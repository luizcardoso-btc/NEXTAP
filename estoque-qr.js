// Estoque de QR codes pré-numerados: você gera lotes (por cor), baixa o arquivo e envia ao fornecedor ANTES das vendas.
// Cada venda paga usa os próximos números livres da cor (na ordem), então a placa física #N chega ao cliente com o QR certo.
// Reposição automática: quando os livres de uma cor ficam abaixo do mínimo, um lote novo é gerado sozinho (para você baixar e enviar).
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('./database.js');
const exp = require('./exportar-placas.js');
const { requireAdmin } = require('./auth-middleware.js');

const cfg = () => {
  const g = (k, d) => { const r = db.prepare('SELECT valor FROM settings WHERE chave = ?').get(k); return r ? r.valor : d; };
  return { minimo: Math.max(0, parseInt(g('qr_minimo', '20'), 10) || 0), lote_auto: Math.max(1, Math.min(500, parseInt(g('qr_lote_auto', '50'), 10) || 50)), auto: g('qr_auto', '1') !== '0' };
};
const num = c => parseInt(String(c || '').replace(/\D/g, ''), 10) || 0;
const fmt = n => '#' + String(n).padStart(5, '0');

// Próximo número livre: maior entre placas já criadas e QRs já reservados.
function proximoNumero() {
  const a = db.prepare("SELECT MAX(CAST(substr(tracking_code, 2) AS INTEGER)) AS m FROM plates WHERE tracking_code LIKE '#%'").get().m || 0;
  const b = db.prepare("SELECT MAX(CAST(substr(numero, 2) AS INTEGER)) AS m FROM qr_estoque").get().m || 0;
  return Math.max(a, b) + 1;
}
function codigoUnico() { for (;;) { const c = nanoid(10); if (!db.prepare('SELECT 1 FROM plates WHERE code = ?').get(c) && !db.prepare('SELECT 1 FROM qr_estoque WHERE code = ?').get(c)) return c; } }

// Cria um lote: numeração contínua, azuis primeiro e depois pretas.
function criarLote({ azul = 0, preta = 0, origem = 'manual', observacao = '' }) {
  azul = Math.max(0, Math.min(1000, parseInt(azul, 10) || 0)); preta = Math.max(0, Math.min(1000, parseInt(preta, 10) || 0));
  if (azul + preta < 1) throw Object.assign(new Error('Informe a quantidade de placas do lote.'), { status: 400 });
  return db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO qr_lotes (qtd_azul, qtd_preta, origem, observacao) VALUES (?, ?, ?, ?)').run(azul, preta, origem, String(observacao || '').slice(0, 120)).lastInsertRowid);
    const ins = db.prepare('INSERT INTO qr_estoque (numero, code, cor, lote_id) VALUES (?, ?, ?, ?)');
    let n = proximoNumero();
    for (let i = 0; i < azul; i++) ins.run(fmt(n++), codigoUnico(), 'azul', id);
    for (let i = 0; i < preta; i++) ins.run(fmt(n++), codigoUnico(), 'preta', id);
    return id;
  })();
}

// Usado pela venda: devolve o próximo QR livre da cor (ou null) e já o marca como usado.
function pegar(cor) {
  const q = db.prepare("SELECT * FROM qr_estoque WHERE status = 'livre' AND cor = ? ORDER BY id LIMIT 1").get(cor);
  if (!q) return null;
  db.prepare("UPDATE qr_estoque SET status = 'usada', usado_em = datetime('now') WHERE id = ?").run(q.id);
  return q;
}
const vincular = (qrId, plateId) => db.prepare('UPDATE qr_estoque SET plate_id = ? WHERE id = ?').run(plateId, qrId);

// Depois de cada venda: se faltar estoque de alguma cor, gera um lote automático (um só por vez).
function verificarReposicao() {
  const c = cfg(); if (!c.auto) return null;
  if (db.prepare("SELECT 1 FROM qr_lotes WHERE origem = 'auto' AND baixado_em IS NULL").get()) return null; // já há um aguardando você baixar
  const livres = cor => db.prepare("SELECT COUNT(*) AS n FROM qr_estoque WHERE status = 'livre' AND cor = ?").get(cor).n;
  const fa = livres('azul') < c.minimo, fp = livres('preta') < c.minimo;
  if (!fa && !fp) return null;
  return criarLote({ azul: fa ? c.lote_auto : 0, preta: fp ? c.lote_auto : 0, origem: 'auto', observacao: 'Reposição automática (estoque abaixo do mínimo)' });
}

const resumo = () => {
  const q = (cor, st) => db.prepare('SELECT COUNT(*) AS n FROM qr_estoque WHERE cor = ? AND status = ?').get(cor, st).n;
  return { azul: { livres: q('azul', 'livre'), usadas: q('azul', 'usada') }, preta: { livres: q('preta', 'livre'), usadas: q('preta', 'usada') } };
};

const router = express.Router(); router.use('/api/admin/qr-estoque', requireAdmin);
const err = (res, e) => res.status(e.status || 500).json({ error: e.message || 'Erro inesperado.' });

router.get('/api/admin/qr-estoque', (req, res) => {
  const lotes = db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM qr_estoque e WHERE e.lote_id = l.id) AS total, (SELECT COUNT(*) FROM qr_estoque e WHERE e.lote_id = l.id AND e.status = 'livre') AS livres,
      (SELECT MIN(numero) FROM qr_estoque e WHERE e.lote_id = l.id) AS de, (SELECT MAX(numero) FROM qr_estoque e WHERE e.lote_id = l.id) AS ate FROM qr_lotes l ORDER BY l.id DESC LIMIT 60`).all();
  const usadas = db.prepare(`SELECT e.numero, e.cor, e.usado_em, p.order_id, r.name AS revendedor FROM qr_estoque e LEFT JOIN plates p ON p.id = e.plate_id LEFT JOIN resellers r ON r.id = p.reseller_id
      WHERE e.status = 'usada' ORDER BY e.id DESC LIMIT 60`).all();
  res.json({ config: cfg(), resumo: resumo(), lotes, usadas, proximo_numero: fmt(proximoNumero()) });
});
router.put('/api/admin/qr-estoque/config', (req, res) => {
  const b = req.body || {}, set = (k, v) => db.prepare('INSERT INTO settings (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(k, String(v));
  const m = parseInt(b.minimo, 10), l = parseInt(b.lote_auto, 10);
  if (!(m >= 0 && m <= 5000) || !(l >= 1 && l <= 500)) return res.status(400).json({ error: 'Mínimo de 0 a 5000 e lote automático de 1 a 500.' });
  set('qr_minimo', m); set('qr_lote_auto', l); set('qr_auto', b.auto ? '1' : '0');
  res.json({ config: cfg() });
});
router.post('/api/admin/qr-estoque/lotes', (req, res) => {
  try { const id = criarLote({ azul: (req.body || {}).azul, preta: (req.body || {}).preta, origem: 'manual', observacao: (req.body || {}).observacao }); res.json({ id }); } catch (e) { err(res, e); }
});
// Zerar o estoque de QR que ainda NÃO foi usado em venda (opcionalmente só uma cor). Os números não voltam: o próximo lote continua da numeração seguinte.
router.post('/api/admin/qr-estoque/zerar', (req, res) => {
  const cor = ['azul', 'preta'].includes((req.body || {}).cor) ? req.body.cor : null;
  const where = "status = 'livre'" + (cor ? ' AND cor = ?' : ''), p = cor ? [cor] : [];
  if ((req.body || {}).somente_contar) return res.json({ ok: true, total: db.prepare(`SELECT COUNT(*) AS n FROM qr_estoque WHERE ${where}`).get(...p).n });
  const r = db.prepare(`UPDATE qr_estoque SET status = 'descartada', usado_em = datetime('now') WHERE ${where}`).run(...p);
  require('./pedidos.js').registrarEvento({ origem: 'admin', resultado: 'qr_estoque_zerado', detalhe: `${r.changes} QR livre(s) descartado(s)${cor ? ' (' + cor + ')' : ''}` });
  res.json({ ok: true, total: r.changes });
});
router.post('/api/admin/qr-estoque/lotes/:id/enviado', (req, res) => {
  db.prepare("UPDATE qr_lotes SET enviado_em = COALESCE(enviado_em, datetime('now')) WHERE id = ?").run(req.params.id); res.json({ ok: true });
});
router.get('/api/admin/qr-estoque/lotes/:id/arquivo', async (req, res) => {
  try {
    const l = db.prepare('SELECT * FROM qr_lotes WHERE id = ?').get(req.params.id); if (!l) return res.status(404).json({ error: 'Lote não encontrado.' });
    const base = exp.baseUrl(req), rows = db.prepare('SELECT numero, code, cor FROM qr_estoque WHERE lote_id = ? ORDER BY id').all(l.id);
    const placas = rows.map(r => ({ numero: r.numero, url: `${base}/r/${r.code}`, cor: r.cor, pedido: '', data: (l.criado_em || '').slice(0, 10) }));
    const z = await exp.montarZip(placas, { titulo: `NexTap — Lote ${l.id}: QR e numeração de ${placas.length} placas (${l.qtd_azul} azuis, ${l.qtd_preta} pretas)`, intro: `Lote ${l.id} — ${l.qtd_azul} placas azuis e ${l.qtd_preta} placas pretas (a cor de cada número está no CSV).` });
    db.prepare("UPDATE qr_lotes SET baixado_em = COALESCE(baixado_em, datetime('now')) WHERE id = ?").run(l.id);
    exp.enviarZip(res, z, `nextap-lote-${l.id}-${exp.arq(placas[0].numero)}-a-${exp.arq(placas[placas.length - 1].numero)}.zip`);
  } catch (e) { console.error('[QR-ESTOQUE] falha:', e); err(res, e); }
});

router.criarLote = criarLote; router.pegar = pegar; router.vincular = vincular; router.verificarReposicao = verificarReposicao; router.proximoNumero = proximoNumero; router.fmt = fmt;
module.exports = router;
