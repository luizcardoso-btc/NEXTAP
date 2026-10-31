// Restaurantes (cardápio digital O Sacoleiro) — ARQUIVO NOVO. Admin: funil, mensalidade, comissão recorrente e ligação do cardápio à placa.
// Rotas: /api/admin/restaurantes. A integração por API do Sacoleiro entra depois (campos sacoleiro_id e link_cardapio já existem).
const express = require('express');
const db = require('./database.js');
const pedidos = require('./pedidos.js');
const { requireAdmin } = require('./auth-middleware.js');

const router = express.Router(); router.use('/api/admin/restaurantes', requireAdmin);
const STATUS = ['lead', 'cadastrando', 'ativo', 'cancelado'];
const txt = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const money = v => { let t = String(v ?? '').replace(/R\$|\s/g, ''); if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.'); const n = Number(t); return Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n * 100) / 100 : null; };
const mesAtual = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7);
const cfg = k => { const r = db.prepare('SELECT valor FROM settings WHERE chave = ?').get(k); return r ? Number(r.valor) : null; };
const link = v => { const t = String(v ?? '').trim(); if (!t) return ''; return /^https?:\/\/[^\s"'<>]{4,500}$/i.test(t) ? t : null; };
const mesOk = v => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || '')) ? v : null;
const norm = v => { const d = String(v || '').replace(/\D/g, ''); return d && d.length <= 8 ? '#' + d.padStart(5, '0') : null; };

function ler(b, atual = {}) {
  b = b || {};
  const nome = txt(b.nome ?? atual.nome, 120); if (!nome) return { erro: 'Informe o nome do restaurante.' };
  const status = b.status === undefined ? (atual.status || 'lead') : b.status; if (!STATUS.includes(status)) return { erro: 'Situação inválida.' };
  const lk = link(b.link_cardapio ?? atual.link_cardapio); if (lk === null) return { erro: 'Link do cardápio inválido. Use o endereço completo, começando com https://' };
  const mens = b.mensalidade === undefined || b.mensalidade === '' ? (atual.mensalidade ?? cfg('rest_mensalidade') ?? 150) : money(b.mensalidade);
  const com = b.comissao === undefined || b.comissao === '' ? (atual.comissao ?? cfg('rest_comissao') ?? 79) : money(b.comissao);
  if (mens === null || com === null) return { erro: 'Mensalidade e comissão precisam ser valores em reais (ex.: 150,00).' };
  const rid = b.reseller_id === undefined ? (atual.reseller_id ?? null) : (b.reseller_id ? Number(b.reseller_id) : null);
  if (rid && !db.prepare('SELECT 1 FROM resellers WHERE id = ?').get(rid)) return { erro: 'Revendedor não encontrado.' };
  return { d: { nome, contato: txt(b.contato ?? atual.contato, 80), telefone: txt(b.telefone ?? atual.telefone, 25), email: txt(b.email ?? atual.email, 120), documento: txt(b.documento ?? atual.documento, 20),
    cidade: txt(b.cidade ?? atual.cidade, 60), uf: txt(b.uf ?? atual.uf, 2).toUpperCase(), status, reseller_id: rid, link_cardapio: lk, sacoleiro_id: txt(b.sacoleiro_id ?? atual.sacoleiro_id, 60),
    mensalidade: mens, comissao: com, obs: String(b.obs ?? atual.obs ?? '').trim().slice(0, 800) } };
}
// Ao virar "ativo": registra a data e já cria a comissão do mês (se ainda não existe). "Cancelado": registra a data.
function aoMudar(id, antes, depois) {
  if (depois === 'ativo' && antes !== 'ativo') {
    db.prepare("UPDATE restaurantes SET ativo_desde = COALESCE(ativo_desde, datetime('now')), cancelado_em = NULL WHERE id = ?").run(id);
    const r = db.prepare('SELECT comissao FROM restaurantes WHERE id = ?').get(id);
    db.prepare("INSERT OR IGNORE INTO restaurante_comissoes (restaurante_id, mes, valor) VALUES (?, ?, ?)").run(id, mesAtual(), r.comissao);
  }
  if (depois === 'cancelado' && antes !== 'cancelado') db.prepare("UPDATE restaurantes SET cancelado_em = datetime('now') WHERE id = ?").run(id);
}

router.get('/api/admin/restaurantes', (req, res) => {
  const lista = db.prepare(`SELECT r.*, p.tracking_code AS placa, rv.name AS revendedor,
      (SELECT COALESCE(SUM(valor),0) FROM restaurante_comissoes c WHERE c.restaurante_id = r.id AND c.status = 'a_receber') AS a_receber,
      (SELECT COALESCE(SUM(valor),0) FROM restaurante_comissoes c WHERE c.restaurante_id = r.id AND c.status = 'recebido') AS recebido
    FROM restaurantes r LEFT JOIN plates p ON p.id = r.plate_id LEFT JOIN resellers rv ON rv.id = r.reseller_id ORDER BY r.id DESC`).all();
  const q = s => db.prepare(s).get(), mes = mesAtual();
  const resumo = {
    ativos: lista.filter(x => x.status === 'ativo').length, leads: lista.filter(x => x.status === 'lead' || x.status === 'cadastrando').length, cancelados: lista.filter(x => x.status === 'cancelado').length,
    mrr: Math.round(lista.filter(x => x.status === 'ativo').reduce((s, x) => s + x.comissao, 0) * 100) / 100,
    faturamento_mensal: Math.round(lista.filter(x => x.status === 'ativo').reduce((s, x) => s + x.mensalidade, 0) * 100) / 100,
    a_receber: q("SELECT COALESCE(SUM(valor),0) AS s FROM restaurante_comissoes WHERE status = 'a_receber'").s,
    recebido_mes: db.prepare("SELECT COALESCE(SUM(valor),0) AS s FROM restaurante_comissoes WHERE status = 'recebido' AND strftime('%Y-%m', recebido_em, '-3 hours') = ?").get(mes).s,
    recebido_total: q("SELECT COALESCE(SUM(valor),0) AS s FROM restaurante_comissoes WHERE status = 'recebido'").s, mes,
  };
  res.json({ resumo, lista, config: { mensalidade: cfg('rest_mensalidade') ?? 150, comissao: cfg('rest_comissao') ?? 79 } });
});
router.put('/api/admin/restaurantes/config', (req, res) => {
  const m = money((req.body || {}).mensalidade), c = money((req.body || {}).comissao);
  if (m === null || c === null) return res.status(400).json({ error: 'Valores inválidos.' });
  const set = (k, v) => db.prepare('INSERT INTO settings (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(k, String(v));
  set('rest_mensalidade', m); set('rest_comissao', c); res.json({ ok: true });
});
router.post('/api/admin/restaurantes', (req, res) => {
  const r = ler(req.body); if (r.erro) return res.status(400).json({ error: r.erro });
  const id = Number(db.prepare(`INSERT INTO restaurantes (nome, contato, telefone, email, documento, cidade, uf, status, reseller_id, link_cardapio, sacoleiro_id, mensalidade, comissao, obs)
    VALUES (@nome, @contato, @telefone, @email, @documento, @cidade, @uf, @status, @reseller_id, @link_cardapio, @sacoleiro_id, @mensalidade, @comissao, @obs)`).run(r.d).lastInsertRowid);
  aoMudar(id, null, r.d.status); res.json({ id });
});
router.put('/api/admin/restaurantes/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM restaurantes WHERE id = ?').get(req.params.id); if (!o) return res.status(404).json({ error: 'Restaurante não encontrado.' });
  const r = ler(req.body, o); if (r.erro) return res.status(400).json({ error: r.erro });
  db.prepare(`UPDATE restaurantes SET nome=@nome, contato=@contato, telefone=@telefone, email=@email, documento=@documento, cidade=@cidade, uf=@uf, status=@status, reseller_id=@reseller_id,
    link_cardapio=@link_cardapio, sacoleiro_id=@sacoleiro_id, mensalidade=@mensalidade, comissao=@comissao, obs=@obs, atualizado_em=datetime('now') WHERE id=@id`).run({ ...r.d, id: o.id });
  aoMudar(o.id, o.status, r.d.status);
  // Se o link do cardápio mudou e a placa já está ligada, a placa passa a abrir o link novo.
  if (o.plate_id && r.d.link_cardapio && r.d.link_cardapio !== o.link_cardapio) db.prepare("UPDATE plates SET destination_url = ?, destination_type = 'Cardápio', status = 'ativa' WHERE id = ?").run(r.d.link_cardapio, o.plate_id);
  res.json({ ok: true });
});
router.delete('/api/admin/restaurantes/:id', (req, res) => {
  const r = db.prepare('DELETE FROM restaurantes WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Restaurante não encontrado.' }); res.json({ ok: true });
});
// Liga o cardápio a uma placa (pelo código #00658): a placa passa a abrir o link do cardápio.
router.post('/api/admin/restaurantes/:id/ligar-placa', (req, res) => {
  const o = db.prepare('SELECT * FROM restaurantes WHERE id = ?').get(req.params.id); if (!o) return res.status(404).json({ error: 'Restaurante não encontrado.' });
  if (!o.link_cardapio) return res.status(400).json({ error: 'Preencha o link do cardápio do restaurante antes de ligar a placa.' });
  const cod = norm((req.body || {}).codigo); if (!cod) return res.status(400).json({ error: 'Informe o código da placa, por exemplo #00658.' });
  const p = db.prepare('SELECT id, client_name FROM plates WHERE tracking_code = ?').get(cod); if (!p) return res.status(404).json({ error: `Não existe placa ${cod}.` });
  const outro = db.prepare('SELECT nome FROM restaurantes WHERE plate_id = ? AND id <> ?').get(p.id, o.id);
  if (outro) return res.status(409).json({ error: `A placa ${cod} já está ligada ao restaurante "${outro.nome}".` });
  db.transaction(() => {
    db.prepare("UPDATE plates SET destination_url = ?, destination_type = 'Cardápio', status = 'ativa', client_name = COALESCE(NULLIF(client_name, ''), ?) WHERE id = ?").run(o.link_cardapio, o.nome, p.id);
    db.prepare("UPDATE restaurantes SET plate_id = ?, atualizado_em = datetime('now') WHERE id = ?").run(p.id, o.id);
  })();
  pedidos.registrarEvento({ origem: 'admin', resultado: 'restaurante_placa_ligada', detalhe: `${o.nome} → ${cod}` });
  res.json({ ok: true, placa: cod });
});
router.post('/api/admin/restaurantes/:id/desligar-placa', (req, res) => {
  db.prepare('UPDATE restaurantes SET plate_id = NULL WHERE id = ?').run(req.params.id); res.json({ ok: true });
});

// Comissões mensais
router.get('/api/admin/restaurantes/:id/comissoes', (req, res) => res.json(db.prepare('SELECT * FROM restaurante_comissoes WHERE restaurante_id = ? ORDER BY mes DESC').all(req.params.id)));
router.post('/api/admin/restaurantes/comissoes/gerar', (req, res) => {
  const mes = mesOk((req.body || {}).mes) || mesAtual();
  const r = db.prepare("INSERT OR IGNORE INTO restaurante_comissoes (restaurante_id, mes, valor) SELECT id, ?, comissao FROM restaurantes WHERE status = 'ativo'").run(mes);
  res.json({ ok: true, mes, criadas: r.changes });
});
router.post('/api/admin/restaurantes/comissoes/:cid/recebido', (req, res) => {
  const r = db.prepare("UPDATE restaurante_comissoes SET status = 'recebido', recebido_em = datetime('now') WHERE id = ? AND status = 'a_receber'").run(req.params.cid);
  if (!r.changes) return res.status(409).json({ error: 'Comissão não encontrada ou já recebida.' }); res.json({ ok: true });
});
router.post('/api/admin/restaurantes/comissoes/:cid/desfazer', (req, res) => {
  const r = db.prepare("UPDATE restaurante_comissoes SET status = 'a_receber', recebido_em = NULL WHERE id = ? AND status = 'recebido'").run(req.params.cid);
  if (!r.changes) return res.status(409).json({ error: 'Comissão não encontrada ou ainda a receber.' }); res.json({ ok: true });
});

module.exports = router;
