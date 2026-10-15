const express = require('express');
const db = require('./database.js');

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

// Página pública do Pix cadastrado (o que o QR / NFC abre): mostra o QR e o "copia e cola".
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
router.get('/pix/:code', (req, res) => {
  const p = db.prepare('SELECT nome, cidade, valor, descricao, payload FROM gl_pix WHERE code = ?').get(req.params.code);
  if (!p) return res.status(404).send('Pix não encontrado.');
  const valor = p.valor ? 'R$ ' + p.valor.toFixed(2).replace('.', ',') : null;
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Pagar com Pix — ${esc(p.nome)}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>
<style>:root{--bg:#f0f5f1;--card:#fff;--tx:#0f1a13;--mut:#5b6b60;--pr:#15803d;--br:#dfe8e2}@media(prefers-color-scheme:dark){:root{--bg:#0d1410;--card:#16211b;--tx:#eaf3ed;--mut:#9bb0a3;--br:#243329}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
.c{background:var(--card);border:1px solid var(--br);border-radius:18px;padding:22px;max-width:380px;width:100%;text-align:center}h1{font-size:20px;margin:0 0 4px}.m{color:var(--mut);font-size:14px}
#q{background:#fff;padding:10px;border-radius:12px;margin:14px auto;width:230px;height:230px}#q svg{width:100%;height:100%}
input{width:100%;padding:11px;border:1px solid var(--br);border-radius:10px;background:var(--card);color:var(--tx);font:inherit;margin:8px 0}
button{width:100%;padding:13px;border:0;border-radius:10px;background:var(--pr);color:#fff;font:700 16px inherit;cursor:pointer}</style></head><body><div class="c">
<h1>${esc(p.nome)}</h1><div class="m">${esc(p.cidade)}${p.descricao ? ' · ' + esc(p.descricao) : ''}</div>${valor ? `<div style="font-size:26px;font-weight:800;margin:10px 0">${valor}</div>` : ''}
<div id="q"></div><div class="m">Abra o app do seu banco → Pix → Ler QR Code, ou copie o código abaixo.</div>
<input id="p" readonly value="${esc(p.payload)}" onclick="this.select()"><button id="b" onclick="cp()">Copiar código Pix</button></div>
<script>var P=document.getElementById('p').value;try{var q=qrcode(0,'M');q.addData(P);q.make();document.getElementById('q').innerHTML=q.createSvgTag({scalable:true,margin:0})}catch(e){}
function cp(){var b=document.getElementById('b'),ok=function(){b.textContent='Copiado ✓'};if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(P).then(ok,function(){});else{document.getElementById('p').select();try{document.execCommand('copy');ok()}catch(e){}}}</script></body></html>`);
});

// Tabela de preços para o site de vendas (assim o site nunca fica diferente do que é cobrado).
router.get('/api/public/price-tiers', (req, res) => {
  const tiers = db.prepare('SELECT min_qty, max_qty, unit_price FROM price_tiers ORDER BY min_qty').all();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ tiers, minimo: tiers.length ? tiers[0].min_qty : 1, frete: db.freteFixo() });
});

module.exports = router;
