const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./database.js');
const senha = require('./senha.js');
const { requireAdmin } = require('./auth-middleware.js');

const router = express.Router();
router.use(requireAdmin);

router.get('/overview', (req, res) => {
  const revendedores = db.prepare('SELECT COUNT(*) AS n FROM resellers').get().n;
  const faturamento = db.prepare("SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE status IN ('pago','enviado','entregue')").get().s;
  const pendentes = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='aguardando_pagamento'").get().n;
  const placas = db.prepare('SELECT COUNT(*) AS n FROM plates').get().n;
  const ativas = db.prepare("SELECT COUNT(*) AS n FROM plates WHERE status='ativa'").get().n;
  res.json({ revendedores, faturamento, pendentes, placas, ativas, persistente: db.meta.persistente });
});

// Gera um link de redefinição de senha (vale 24h) para o fornecedor enviar ao revendedor, por exemplo no WhatsApp.
router.post('/resellers/:id/reset-link', (req, res) => {
  const r = db.prepare('SELECT id, name FROM resellers WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Revendedor não encontrado.' });
  res.json({ link: senha.criarLink(req, r.id, 24), nome: r.name });
});

// Baixa uma cópia completa do banco (arquivo .db) — guarde no seu computador de vez em quando.
router.get('/backup', (req, res) => {
  try {
    const arquivo = db.copiaTemporaria();
    const nome = `nextap-backup-${new Date().toISOString().slice(0, 10)}.db`;
    res.download(arquivo, nome, () => fs.unlink(arquivo, () => {}));
  } catch (e) {
    console.error('[DB] Falha ao gerar backup para download:', e.message);
    res.status(500).json({ error: 'Não foi possível gerar o backup agora.' });
  }
});

// Situação do armazenamento, contagens e backups (tela "Dados e backups").
router.get('/sistema', (req, res) => {
  res.json({
    dados_persistentes: db.meta.persistente,
    integridade: db.integridade(),
    contagens: db.contagens(),
    backups: db.listarBackups(),
  });
});

// Restaurar a partir de um backup que já está guardado no servidor (pasta backups/ do Volume).
router.post('/restore-local', (req, res) => {
  const { nome, modo } = req.body || {};
  const arquivo = path.join(db.meta.backupDir, path.basename(String(nome || '')));
  if (!/\.db$/.test(arquivo) || !fs.existsSync(arquivo)) return res.status(404).json({ error: 'Backup não encontrado no servidor.' });
  if (!['substituir', 'revendedores'].includes(modo)) return res.status(400).json({ error: 'Escolha como restaurar.' });
  try { res.json(db.restaurar(arquivo, modo)); }
  catch (e) { console.error('[DB] Falha ao restaurar:', e.message); res.status(400).json({ error: e.message }); }
});

// Restaurar a partir de um arquivo .db enviado pelo painel (o backup que você baixou).
router.post('/restore', express.raw({ type: () => true, limit: '80mb' }), (req, res) => {
  const modo = String(req.query.modo || '');
  if (!['substituir', 'revendedores'].includes(modo)) return res.status(400).json({ error: 'Escolha como restaurar.' });
  if (!Buffer.isBuffer(req.body) || req.body.length < 512) return res.status(400).json({ error: 'Nenhum arquivo recebido.' });
  const tmp = path.join(os.tmpdir(), `restore-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    fs.writeFileSync(tmp, req.body);
    res.json(db.restaurar(tmp, modo));
  } catch (e) {
    console.error('[DB] Falha ao restaurar upload:', e.message);
    res.status(400).json({ error: e.message });
  } finally { fs.unlink(tmp, () => {}); }
});

// Lista de revendedores em planilha (CSV abre no Excel/Google Planilhas) — outra forma de guardar uma cópia.
const csvCel = v => {
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // evita fórmulas maliciosas ao abrir no Excel
  return '"' + t.replace(/"/g, '""') + '"';
};
router.get('/export/revendedores', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.name, r.email, r.whatsapp, r.created_at,
      r.addr_cep, r.addr_street, r.addr_number, r.addr_complement, r.addr_district, r.addr_city, r.addr_state, r.addr_country,
      (SELECT COUNT(*) FROM orders o WHERE o.reseller_id = r.id) AS pedidos,
      (SELECT COUNT(*) FROM plates p WHERE p.reseller_id = r.id) AS placas
    FROM resellers r ORDER BY r.id`).all();
  const cab = ['ID', 'Nome', 'E-mail', 'WhatsApp', 'Cadastro', 'CEP', 'Rua', 'Número', 'Complemento', 'Bairro', 'Cidade', 'UF', 'País', 'Pedidos', 'Placas'];
  const linhas = rows.map(r => [r.id, r.name, r.email, r.whatsapp, r.created_at, r.addr_cep, r.addr_street, r.addr_number,
    r.addr_complement, r.addr_district, r.addr_city, r.addr_state, r.addr_country, r.pedidos, r.placas].map(csvCel).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="nextap-revendedores-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\ufeff' + [cab.map(csvCel).join(';'), ...linhas].join('\r\n'));
});

// Cadastro manual de um revendedor (para reativar quem já tinha conta): cria a conta e devolve o link para ele escolher a senha.
router.post('/resellers', async (req, res) => {
  const { name, email, whatsapp } = req.body || {};
  const em = String(email || '').toLowerCase().trim();
  if (!String(name || '').trim() || !em.includes('@')) return res.status(400).json({ error: 'Informe nome e e-mail válidos.' });
  if (db.prepare('SELECT 1 FROM resellers WHERE email = ?').get(em)) return res.status(409).json({ error: 'Já existe um revendedor com esse e-mail.' });
  const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10); // senha aleatória; ele define a dele pelo link
  const info = db.prepare('INSERT INTO resellers (name, email, whatsapp, password_hash) VALUES (?, ?, ?, ?)')
    .run(String(name).trim().slice(0, 120), em, String(whatsapp || '').trim().slice(0, 30), hash);
  res.json({ id: info.lastInsertRowid, link: senha.criarLink(req, info.lastInsertRowid, 72) });
});

router.get('/resellers', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.name, r.email, r.whatsapp, r.created_at,
      (SELECT COUNT(*) FROM orders o WHERE o.reseller_id=r.id) AS pedidos,
      (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.reseller_id=r.id AND o.status IN ('pago','enviado','entregue')) AS gasto,
      (SELECT COUNT(*) FROM plates p WHERE p.reseller_id=r.id) AS placas,
      (SELECT COUNT(*) FROM sales s WHERE s.reseller_id=r.id) AS vendas
    FROM resellers r ORDER BY r.id DESC
  `).all();
  res.json(rows);
});

router.get('/orders', (req, res) => {
  const rows = db.prepare(`
    SELECT o.*, r.name AS reseller_name, r.email AS reseller_email
    FROM orders o JOIN resellers r ON r.id = o.reseller_id
    ORDER BY o.id DESC
  `).all();
  res.json(rows);
});

router.put('/orders/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!['enviado', 'entregue', 'cancelado'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido.' });
  }
  const info = db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Pedido não encontrado.' });
  res.json({ ok: true });
});

router.get('/plates', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, r.name AS reseller_name
    FROM plates p JOIN resellers r ON r.id = p.reseller_id
    ORDER BY p.id DESC
  `).all();
  res.json(rows);
});

router.get('/price-tiers', (req, res) => {
  res.json(db.prepare('SELECT * FROM price_tiers ORDER BY min_qty').all());
});

router.post('/price-tiers', (req, res) => {
  const { tiers } = req.body || {};
  if (!Array.isArray(tiers) || !tiers.length) return res.status(400).json({ error: 'Tabela inválida.' });
  const valid = tiers.every(t =>
    Number.isInteger(t.min_qty) && Number.isInteger(t.max_qty) &&
    t.min_qty >= 1 && t.max_qty >= t.min_qty &&
    typeof t.unit_price === 'number' && t.unit_price > 0);
  if (!valid) return res.status(400).json({ error: 'Faixas inválidas (quantidades inteiras e preço maior que zero).' });
  const del = db.prepare('DELETE FROM price_tiers');
  const ins = db.prepare('INSERT INTO price_tiers (min_qty, max_qty, unit_price) VALUES (?, ?, ?)');
  const tx = db.transaction((list) => {
    del.run();
    list.forEach(t => ins.run(t.min_qty, t.max_qty, t.unit_price));
  });
  tx(tiers);
  res.json({ ok: true });
});

module.exports = router;
