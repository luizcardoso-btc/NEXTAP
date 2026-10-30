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
// Modelos de placa que podem ter QR em estoque: Google azul/preta + as placas do catálogo (Pix, Instagram, WhatsApp, redes sociais, restaurante…).
const modelosCatalogo = () => db.prepare("SELECT nome FROM produtos WHERE categoria LIKE 'Placas%' AND usa_tabela = 1 AND ativo = 1 AND NOT (nome LIKE '%google%' AND nome LIKE '%azul%') ORDER BY ordem, id").all().map(x => x.nome);
function criarLote({ azul = 0, preta = 0, outros = {}, origem = 'manual', observacao = '' }) {
  azul = Math.max(0, Math.min(1000, parseInt(azul, 10) || 0)); preta = Math.max(0, Math.min(1000, parseInt(preta, 10) || 0));
  const validos = new Set(modelosCatalogo()), extras = [];
  for (const [nome, q] of Object.entries(outros || {})) {
    const n = Math.max(0, Math.min(1000, parseInt(q, 10) || 0)); if (!n) continue;
    if (!validos.has(nome)) throw Object.assign(new Error(`Modelo "${nome}" não existe no catálogo de placas (ou está inativo).`), { status: 400 });
    extras.push([nome, n]);
  }
  const total = azul + preta + extras.reduce((s, x) => s + x[1], 0);
  if (total < 1) throw Object.assign(new Error('Informe a quantidade de placas do lote.'), { status: 400 });
  if (total > 3000) throw Object.assign(new Error('No máximo 3000 QR por lote.'), { status: 400 });
  return db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO qr_lotes (qtd_azul, qtd_preta, origem, observacao, detalhe) VALUES (?, ?, ?, ?, ?)').run(azul, preta, origem, String(observacao || '').slice(0, 120), extras.length ? JSON.stringify(Object.fromEntries(extras)) : null).lastInsertRowid);
    const ins = db.prepare('INSERT INTO qr_estoque (numero, code, cor, lote_id) VALUES (?, ?, ?, ?)');
    let n = proximoNumero();
    for (let i = 0; i < azul; i++) ins.run(fmt(n++), codigoUnico(), 'azul', id);
    for (let i = 0; i < preta; i++) ins.run(fmt(n++), codigoUnico(), 'preta', id);
    for (const [nome, q] of extras) for (let i = 0; i < q; i++) ins.run(fmt(n++), codigoUnico(), nome, id);
    return id;
  })();
}
// Estoque por modelo: livres e usados (inclui modelos antigos que ainda têm QR mesmo se o produto foi renomeado).
function modelos() {
  const cont = db.prepare("SELECT cor, SUM(status='livre') AS livres, SUM(status='usada') AS usadas FROM qr_estoque GROUP BY cor").all(), por = Object.fromEntries(cont.map(x => [x.cor, x]));
  const nomes = ['azul', 'preta', ...modelosCatalogo()]; cont.forEach(x => { if (!nomes.includes(x.cor)) nomes.push(x.cor); });
  return nomes.map(n => ({ modelo: n, rotulo: n === 'azul' ? 'Google — azul' : n === 'preta' ? 'Google — preta' : n, livres: (por[n] && por[n].livres) || 0, usadas: (por[n] && por[n].usadas) || 0 }));
}
const descLote = l => { const d = l.detalhe ? JSON.parse(l.detalhe) : {}; return [l.qtd_azul && `${l.qtd_azul} azuis`, l.qtd_preta && `${l.qtd_preta} pretas`, ...Object.entries(d).map(([k, v]) => `${v} ${k}`)].filter(Boolean).join(' · '); };

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
  lotes.forEach(l => { l.descricao = descLote(l); });
  res.json({ config: cfg(), resumo: resumo(), modelos: modelos(), lotes, usadas, proximo_numero: fmt(proximoNumero()) });
});
router.put('/api/admin/qr-estoque/config', (req, res) => {
  const b = req.body || {}, set = (k, v) => db.prepare('INSERT INTO settings (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(k, String(v));
  const m = parseInt(b.minimo, 10), l = parseInt(b.lote_auto, 10);
  if (!(m >= 0 && m <= 5000) || !(l >= 1 && l <= 500)) return res.status(400).json({ error: 'Mínimo de 0 a 5000 e lote automático de 1 a 500.' });
  set('qr_minimo', m); set('qr_lote_auto', l); set('qr_auto', b.auto ? '1' : '0');
  res.json({ config: cfg() });
});
router.post('/api/admin/qr-estoque/lotes', (req, res) => {
  try { const id = criarLote({ azul: (req.body || {}).azul, preta: (req.body || {}).preta, outros: (req.body || {}).outros, origem: 'manual', observacao: (req.body || {}).observacao }); res.json({ id }); } catch (e) { err(res, e); }
});
// Conferência (só leitura): os QR "livres" já viraram placa, foram configurados ou colidem com alguma placa?
router.get('/api/admin/qr-estoque/conferir', (req, res) => {
  const um = (s, ...p) => db.prepare(s).all(...p);
  const livres = um("SELECT e.id, e.numero, e.code, e.cor, e.lote_id, e.plate_id FROM qr_estoque e WHERE e.status = 'livre' ORDER BY e.id");
  const comPlaca = livres.filter(x => x.plate_id).map(x => x.numero);
  const codeEmPlaca = um("SELECT e.numero, p.tracking_code, p.client_name, p.destination_url FROM qr_estoque e JOIN plates p ON p.code = e.code WHERE e.status = 'livre'");
  const numeroEmPlaca = um("SELECT e.numero, p.id AS placa, p.client_name, p.destination_url FROM qr_estoque e JOIN plates p ON p.tracking_code = e.numero WHERE e.status = 'livre'");
  const configuradas = [...codeEmPlaca, ...numeroEmPlaca].filter(x => x.destination_url || x.client_name).map(x => x.numero);
  const lotes = um(`SELECT l.id, l.criado_em, l.baixado_em, l.enviado_em, COUNT(e.id) AS livres, MIN(e.numero) AS de, MAX(e.numero) AS ate,
      SUM(e.cor='azul') AS azuis, SUM(e.cor='preta') AS pretas, SUM(e.cor NOT IN ('azul','preta')) AS outras FROM qr_lotes l JOIN qr_estoque e ON e.lote_id = l.id AND e.status = 'livre' GROUP BY l.id ORDER BY l.id`);
  const usadasSemPlaca = um("SELECT COUNT(*) AS n FROM qr_estoque WHERE status = 'usada' AND plate_id IS NULL")[0].n;
  const leituras = um("SELECT COUNT(*) AS n FROM plate_reads r JOIN plates p ON p.id = r.plate_id JOIN qr_estoque e ON e.code = p.code WHERE e.status = 'livre'")[0].n;
  const problemas = [];
  if (comPlaca.length) problemas.push(`${comPlaca.length} QR marcado(s) como livre mas ligado(s) a uma placa: ${comPlaca.slice(0, 15).join(', ')}`);
  if (codeEmPlaca.length) problemas.push(`${codeEmPlaca.length} QR livre(s) com o MESMO código de uma placa existente: ${codeEmPlaca.slice(0, 15).map(x => x.numero).join(', ')}`);
  if (numeroEmPlaca.length) problemas.push(`${numeroEmPlaca.length} QR livre(s) com o MESMO número de uma placa existente: ${numeroEmPlaca.slice(0, 15).map(x => x.numero).join(', ')}`);
  if (configuradas.length) problemas.push(`${configuradas.length} deles já aparecem em placas configuradas: ${configuradas.slice(0, 15).join(', ')}`);
  res.json({ ok: !problemas.length, livres: livres.length, azuis: livres.filter(x => x.cor === 'azul').length, pretas: livres.filter(x => x.cor === 'preta').length, outras: livres.filter(x => x.cor !== 'azul' && x.cor !== 'preta').length, lotes, problemas, usadas_sem_placa: usadasSemPlaca, leituras_em_livres: leituras });
});

// Zerar o estoque de QR que ainda NÃO foi usado em venda (opcionalmente só uma cor). Os números não voltam: o próximo lote continua da numeração seguinte.
router.post('/api/admin/qr-estoque/zerar', (req, res) => {
  const cor = typeof (req.body || {}).cor === 'string' && req.body.cor ? req.body.cor : null;
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
    const base = exp.baseUrl(req), desc = descLote(l), rows = db.prepare('SELECT numero, code, cor FROM qr_estoque WHERE lote_id = ? ORDER BY id').all(l.id);
    const placas = rows.map(r => ({ numero: r.numero, url: `${base}/r/${r.code}`, cor: r.cor, pedido: '', data: (l.criado_em || '').slice(0, 10) }));
    const z = await exp.montarZip(placas, { titulo: `NexTap — Lote ${l.id}: QR e numeração de ${placas.length} placas (${desc})`, intro: `Lote ${l.id} — ${desc} (o modelo de cada número está no CSV e no PDF).` });
    db.prepare("UPDATE qr_lotes SET baixado_em = COALESCE(baixado_em, datetime('now')) WHERE id = ?").run(l.id);
    exp.enviarZip(res, z, `nextap-lote-${l.id}-${exp.arq(placas[0].numero)}-a-${exp.arq(placas[placas.length - 1].numero)}.zip`);
  } catch (e) { console.error('[QR-ESTOQUE] falha:', e); err(res, e); }
});

router.criarLote = criarLote; router.pegar = pegar; router.vincular = vincular; router.verificarReposicao = verificarReposicao; router.proximoNumero = proximoNumero; router.fmt = fmt;
module.exports = router;
