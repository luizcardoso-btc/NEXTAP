const express = require('express');
const db = require('./db');

const router = express.Router();

// Contadores públicos usados no site (placas vendidas e revendedores cadastrados).
// Sem autenticação de propósito: é o que alimenta a seção de números do site.
router.get('/api/public/stats', (req, res) => {
  const plates_sold = db.prepare('SELECT COUNT(*) AS n FROM plates').get().n;
  const resellers = db.prepare('SELECT COUNT(*) AS n FROM resellers').get().n;
  res.json({ plates_sold, resellers });
});

// Esta é a rota que o QR Code / NFC da placa abre: /r/:code
// Ela registra a leitura e redireciona para o link configurado pelo revendedor.
router.get('/r/:code', (req, res) => {
  const plate = db.prepare('SELECT * FROM plates WHERE code = ?').get(req.params.code);
  if (!plate) return res.status(404).send('Placa não encontrada.');

  db.prepare('INSERT INTO plate_reads (plate_id) VALUES (?)').run(plate.id);

  if (!plate.destination_url) {
    return res.status(200).send('Esta placa ainda não foi configurada pelo revendedor.');
  }
  res.redirect(302, plate.destination_url);
});

module.exports = router;
