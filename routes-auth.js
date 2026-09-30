const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./database.js');

const router = express.Router();

function sign(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// Cadastro gratuito de revendedor
router.post('/register', async (req, res) => {
  const { name, email, whatsapp, password } = req.body || {};
  if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string'
      || !name.trim() || !email.includes('@') || password.length < 6) {
    return res.status(400).json({ error: 'Informe nome, e-mail e senha (mínimo 6 caracteres).' });
  }
  const existing = db.prepare('SELECT id FROM resellers WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });

  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare(
    'INSERT INTO resellers (name, email, whatsapp, password_hash) VALUES (?, ?, ?, ?)'
  ).run(name, email.toLowerCase(), whatsapp || '', hash);

  const token = sign({ id: info.lastInsertRowid, type: 'reseller' });
  res.json({ token, reseller: { id: info.lastInsertRowid, name, email: email.toLowerCase(), whatsapp } });
});

// Login de revendedor
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const r = db.prepare('SELECT * FROM resellers WHERE email = ?').get(String(email || '').toLowerCase().trim());
  if (!r) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  const ok = await bcrypt.compare(password || '', r.password_hash);
  if (!ok) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });

  const token = sign({ id: r.id, type: 'reseller' });
  res.json({ token, reseller: { id: r.id, name: r.name, email: r.email, whatsapp: r.whatsapp } });
});

// Login do admin (fornecedor) — credenciais fixas definidas no .env
router.post('/admin-login', (req, res) => {
  const { email, password } = req.body || {};
  const safeEq = (a, b) => {
    const A = Buffer.from(String(a ?? '')), B = Buffer.from(String(b ?? ''));
    return A.length === B.length && crypto.timingSafeEqual(A, B);
  };
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD
      || !safeEq(email, process.env.ADMIN_EMAIL) || !safeEq(password, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }
  const token = sign({ type: 'admin' });
  res.json({ token });
});

module.exports = router;
