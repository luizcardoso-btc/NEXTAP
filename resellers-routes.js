const express = require('express');
const { nanoid } = require('nanoid');
const db = require('./db');
const { requireReseller } = require('./auth-middleware');

const router = express.Router();
router.use(requireReseller);

// Dados do próprio revendedor logado
router.get('/me', (req, res) => {
  const r = db.prepare('SELECT id, name, email, whatsapp, created_at FROM resellers WHERE id = ?').get(req.resellerId);
  res.json(r);
});

router.put('/me', (req, res) => {
  const { name, whatsapp } = req.body || {};
  db.prepare('UPDATE resellers SET name = COALESCE(?, name), whatsapp = COALESCE(?, whatsapp) WHERE id = ?')
    .run(name, whatsapp, req.resellerId);
  res.json({ ok: true });
});

// Faixas de preço (públicas para o revendedor logado)
router.get('/price-tiers', (req, res) => {
  const tiers = db.prepare('SELECT min_qty, max_qty, unit_price FROM price_tiers ORDER BY min_qty').all();
  res.json(tiers);
});

// Placas do revendedor
router.get('/plates', (req, res) => {
  const plates = db.prepare('SELECT * FROM plates WHERE reseller_id = ? ORDER BY id DESC').all(req.resellerId);
  res.json(plates);
});

router.put('/plates/:id', (req, res) => {
  const plate = db.prepare('SELECT * FROM plates WHERE id = ? AND reseller_id = ?').get(req.params.id, req.resellerId);
  if (!plate) return res.status(404).json({ error: 'Placa não encontrada.' });
  const { client_name, plate_label, destination_type, destination_url } = req.body || {};
  if (destination_url && !/^https?:\/\//.test(destination_url)) {
    return res.status(400).json({ error: 'O link deve começar com http:// ou https://' });
  }
  const status = (client_name || destination_url) ? 'ativa' : 'estoque';
  db.prepare(`UPDATE plates SET client_name=?, plate_label=?, destination_type=?, destination_url=?, status=? WHERE id=?`)
    .run(client_name || '', plate_label || '', destination_type || '', destination_url || '', status, plate.id);
  res.json({ ok: true });
});

// Leituras (quando alguém aproxima o celular/escaneia o QR) — endpoint público está em plates-public.js
router.get('/plates/:id/reads', (req, res) => {
  const plate = db.prepare('SELECT id FROM plates WHERE id = ? AND reseller_id = ?').get(req.params.id, req.resellerId);
  if (!plate) return res.status(404).json({ error: 'Placa não encontrada.' });
  const reads = db.prepare('SELECT read_at FROM plate_reads WHERE plate_id = ? ORDER BY read_at DESC').all(plate.id);
  res.json(reads);
});

// Vendas do revendedor
router.get('/sales', (req, res) => {
  const sales = db.prepare('SELECT * FROM sales WHERE reseller_id = ? ORDER BY id DESC').all(req.resellerId);
  res.json(sales);
});

router.post('/sales', (req, res) => {
  const { client_name, value, plate_id, destination_url } = req.body || {};
  if (!client_name || typeof value !== 'number' || value < 0) {
    return res.status(400).json({ error: 'Informe cliente e valor válidos.' });
  }
  let cost = 0;
  if (plate_id) {
    const plate = db.prepare('SELECT * FROM plates WHERE id = ? AND reseller_id = ?').get(plate_id, req.resellerId);
    if (!plate) return res.status(404).json({ error: 'Placa não encontrada.' });
    cost = plate.cost || 0;
    db.prepare(`UPDATE plates SET status='ativa', client_name=?, destination_url=COALESCE(NULLIF(?, ''), destination_url) WHERE id=?`)
      .run(client_name, destination_url || '', plate_id);
  }
  const info = db.prepare('INSERT INTO sales (reseller_id, plate_id, client_name, value, cost) VALUES (?, ?, ?, ?, ?)')
    .run(req.resellerId, plate_id || null, client_name, value, cost);
  res.json({ id: info.lastInsertRowid });
});

router.delete('/sales/:id', (req, res) => {
  db.prepare('DELETE FROM sales WHERE id = ? AND reseller_id = ?').run(req.params.id, req.resellerId);
  res.json({ ok: true });
});

// Pedidos do revendedor (histórico)
router.get('/orders', (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE reseller_id = ? ORDER BY id DESC').all(req.resellerId);
  res.json(orders);
});

module.exports = router;
