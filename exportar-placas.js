// Exporta as últimas N placas vendidas para o fornecedor: ZIP com planilha (CSV), PDF com QR + numeração e um SVG vetorial por placa.
// O QR leva ao endereço fixo /r/<código> da placa (QR dinâmico): o destino é trocado no painel sem regravar a placa.
const express = require('express');
const PDFDocument = require('pdfkit');
const zlib = require('zlib');
const db = require('./database.js');
const qrcode = require('./qrcode-lib.js');
const { requireAdmin } = require('./auth-middleware.js');

function matriz(texto) {
  const q = qrcode(0, 'M'); q.addData(texto); q.make();
  const n = q.getModuleCount(), m = [];
  for (let r = 0; r < n; r++) { m.push([]); for (let c = 0; c < n; c++) m[r].push(q.isDark(r, c)); }
  return m;
}
function svg(texto, rotulo) {
  const m = matriz(texto), n = m.length, borda = 4, T = n + borda * 2;
  let d = '';
  m.forEach((lin, r) => lin.forEach((x, c) => { if (x) d += `M${c + borda},${r + borda}h1v1h-1z`; }));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${T} ${T}" width="${T * 10}" height="${T * 10}" shape-rendering="crispEdges"><title>${rotulo}</title><rect width="${T}" height="${T}" fill="#fff"/><path d="${d}" fill="#000"/></svg>\n`;
}

// ---- ZIP mínimo (sem compressão) ----
const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zip(arquivos) { // [{nome, dados:Buffer}]
  const partes = [], central = []; let pos = 0;
  const d = new Date(), hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), data = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const a of arquivos) {
    const nome = Buffer.from(a.nome, 'utf8'), crc = crc32(a.dados), h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8); h.writeUInt16LE(hora, 10); h.writeUInt16LE(data, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(a.dados.length, 18); h.writeUInt32LE(a.dados.length, 22); h.writeUInt16LE(nome.length, 26); h.writeUInt16LE(0, 28);
    partes.push(h, nome, a.dados);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10); c.writeUInt16LE(hora, 12); c.writeUInt16LE(data, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(a.dados.length, 20); c.writeUInt32LE(a.dados.length, 24); c.writeUInt16LE(nome.length, 28); c.writeUInt32LE(pos, 42);
    central.push(c, nome); pos += 30 + nome.length + a.dados.length;
  }
  const cd = Buffer.concat(central), fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(arquivos.length, 8); fim.writeUInt16LE(arquivos.length, 10); fim.writeUInt32LE(cd.length, 12); fim.writeUInt32LE(pos, 16);
  return Buffer.concat([...partes, cd, fim]);
}

function pdf(placas, titulo) {
  return new Promise((ok, falha) => {
    const doc = new PDFDocument({ size: 'A4', margin: 30, info: { Title: titulo } }), bufs = [];
    doc.on('data', b => bufs.push(b)); doc.on('end', () => ok(Buffer.concat(bufs))); doc.on('error', falha);
    const COL = 4, LIN = 5, W = (595.28 - 60) / COL, H = (841.89 - 90) / LIN, QR = 112;
    placas.forEach((p, i) => {
      const k = i % (COL * LIN);
      if (i && k === 0) doc.addPage();
      if (k === 0) doc.font('Helvetica-Bold').fontSize(10).fillColor('#444').text(`${titulo} — página ${Math.floor(i / (COL * LIN)) + 1}`, 30, 24, { width: 535 });
      const x = 30 + (k % COL) * W, y = 50 + Math.floor(k / COL) * H, m = matriz(p.url), cel = QR / (m.length + 8), ox = x + (W - QR) / 2, oy = y + 4;
      doc.rect(ox, oy, QR, QR).fill('#fff');
      doc.fillColor('#000');
      m.forEach((lin, r) => lin.forEach((v, c) => { if (v) doc.rect(ox + (c + 4) * cel, oy + (r + 4) * cel, cel + 0.15, cel + 0.15).fill(); }));
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#000').text(p.numero, x, oy + QR + 2, { width: W, align: 'center' });
      doc.font('Helvetica').fontSize(6.5).fillColor('#555').text(p.url.replace(/^https?:\/\//, ''), x, oy + QR + 20, { width: W, align: 'center' });
    });
    doc.end();
  });
}

const router = express.Router();
router.get('/api/admin/placas/exportar', requireAdmin, async (req, res) => {
  try {
    const qtd = Math.max(1, Math.min(1000, parseInt(req.query.qtd, 10) || 100));
    const base = (process.env.SITE_HOST ? 'https://' + process.env.SITE_HOST.replace(/^https?:\/\//, '') : `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const linhas = db.prepare(`SELECT p.id, p.tracking_code, p.code, p.color, p.order_id, o.paid_at, o.created_at
      FROM plates p JOIN orders o ON o.id = p.order_id WHERE p.order_id IS NOT NULL ORDER BY p.id DESC LIMIT ?`).all(qtd).reverse();
    if (!linhas.length) return res.status(404).json({ error: 'Ainda não há placas vendidas para exportar.' });
    const placas = linhas.map(l => ({ numero: l.tracking_code || '#' + String(l.id).padStart(5, '0'), url: `${base}/r/${l.code}`, cor: l.color, pedido: l.order_id, data: (l.paid_at || l.created_at || '').slice(0, 10) }));
    const arq = n => n.replace('#', '');
    const csv = '﻿' + ['numero;cor;pedido;data_venda;link_qr_dinamico'].concat(placas.map(p => [p.numero, p.cor, p.pedido, p.data, p.url].join(';'))).join('\r\n') + '\r\n';
    const lista = [{ nome: 'placas.csv', dados: Buffer.from(csv, 'utf8') }, { nome: 'placas-qr.pdf', dados: await pdf(placas, `NexTap — QR e numeração das últimas ${placas.length} placas`) },
      { nome: 'LEIA-ME.txt', dados: Buffer.from(`NexTap — arquivo para o fornecedor\r\n\r\nPlacas: ${placas[0].numero} a ${placas[placas.length - 1].numero} (${placas.length} placas)\r\n- placas.csv: numeração, cor e link de cada placa (abre no Excel)\r\n- placas-qr.pdf: QR Code + número de cada placa, 20 por página (vetorial)\r\n- svg/: um QR Code vetorial por placa, nomeado pelo número (ex.: 00001.svg)\r\n\r\nO QR é dinâmico: leva ao link fixo da placa e o destino é trocado no painel, sem regravar nada.\r\nGerado em ${new Date().toISOString().slice(0, 10)}.\r\n`, 'utf8') }]
      .concat(placas.map(p => ({ nome: `svg/${arq(p.numero)}.svg`, dados: Buffer.from(svg(p.url, p.numero), 'utf8') })));
    const z = zip(lista);
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="nextap-placas-${arq(placas[0].numero)}-a-${arq(placas[placas.length - 1].numero)}.zip"`, 'Content-Length': z.length }).send(z);
  } catch (e) { console.error('[EXPORTAR] falha:', e); res.status(500).json({ error: 'Não consegui gerar o arquivo agora.' }); }
});

module.exports = router;
