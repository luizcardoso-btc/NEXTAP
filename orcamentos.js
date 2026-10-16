// Orçamentos de placas (admin) — ARQUIVO NOVO.
// Admin: /api/admin/orcamentos (lista, cria, edita, apaga, muda status).
// Público (link para o cliente): /o/:token (página) e /o/:token/pdf (PDF).
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const PDFDocument = require('pdfkit');
const db = require('./database.js');
const { requireAdmin } = require('./auth-middleware.js');
const exp = require('./exportar-placas.js');

const router = express.Router();
const pastaImg = path.join(path.dirname(db.meta.arquivo), 'catalogo-img');
// Foto da linha no PDF: só imagens salvas aqui em JPG/PNG (o PDF não lê WebP nem link externo).
const imgBuf = u => { const m = /^\/catalogo-img\/([\w.-]+\.(?:jpe?g|png))$/i.exec(u || ''); if (!m) return null; try { return require('fs').readFileSync(path.join(pastaImg, m[1])); } catch (e) { return null; } };
const getSet = db.prepare('SELECT valor FROM settings WHERE chave = ?');
const set = (k, d = '') => { const r = getSet.get(k); return r ? r.valor : d; };
const dig = v => String(v ?? '').replace(/\D/g, '');
const txt = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const money = n => Math.round(num(n) * 100) / 100;
const BRL = n => 'R$ ' + money(n).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dataBR = d => { const m = String(d || '').match(/^(\d{4})-(\d\d)-(\d\d)/); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const numero = id => String(id).padStart(4, '0');
const docFmt = v => { const d = dig(v); if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'); if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4'); return v || ''; };
const telFmt = v => { const d = dig(v); return d.length === 11 ? d.replace(/^(\d\d)(\d{5})(\d{4})$/, '($1) $2-$3') : d.length === 10 ? d.replace(/^(\d\d)(\d{4})(\d{4})$/, '($1) $2-$3') : (v || ''); };

const imgOk = u => { u = String(u || '').trim(); return (/^\/catalogo-img\/[\w.-]+$/.test(u) || /^https:\/\/[^\s"'<>]{1,280}$/i.test(u)) ? u : ''; };

function ler(corpo) {
  const b = corpo || {};
  const nome = txt(b.cliente_nome, 120);
  if (!nome) return { erro: 'Informe o nome do cliente.' };
  const itens = (Array.isArray(b.itens) ? b.itens : []).slice(0, 30).map(i => ({ desc: txt(i && i.desc, 140), qtd: Math.floor(num(i && i.qtd)), unit: money(i && i.unit), img: imgOk(i && i.img) }))
    .filter(i => i.desc && i.qtd > 0 && i.unit >= 0);
  if (!itens.length) return { erro: 'Adicione ao menos um item com descrição, quantidade e valor.' };
  const frete = money(b.frete), desconto = money(b.desconto);
  if (frete < 0 || desconto < 0) return { erro: 'Frete e desconto não podem ser negativos.' };
  const subtotal = itens.reduce((a, i) => a + i.qtd * i.unit, 0);
  if (desconto > subtotal + frete) return { erro: 'O desconto é maior que o total do orçamento.' };
  const validade = /^\d{4}-\d\d-\d\d$/.test(String(b.validade || '')) ? b.validade : null;
  return { d: {
    cliente_nome: nome, cliente_doc: txt(b.cliente_doc, 20), cliente_tel: txt(b.cliente_tel, 25), cliente_email: txt(b.cliente_email, 120),
    cliente_cep: txt(b.cliente_cep, 12), cliente_cidade: txt(b.cliente_cidade, 80), cliente_uf: txt(b.cliente_uf, 2).toUpperCase(),
    itens: JSON.stringify(itens), frete, frete_desc: txt(b.frete_desc, 80), desconto, validade, obs: String(b.obs ?? '').trim().slice(0, 800), vendedor: txt(b.vendedor, 60),
  } };
}
const total = o => { const it = JSON.parse(o.itens || '[]'); const sub = it.reduce((a, i) => a + i.qtd * i.unit, 0); return { itens: it, subtotal: money(sub), total: money(sub + o.frete - o.desconto) }; };
const completo = (o, base) => ({ ...o, ...total(o), numero: numero(o.id), url: `${base}/o/${o.token}`, pdf: `${base}/o/${o.token}/pdf` });
const base = req => exp.baseUrl(req);

// ---------- admin ----------
router.get('/api/admin/orcamentos', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM orcamentos ORDER BY id DESC LIMIT 500').all().map(o => completo(o, base(req))).map(o => ({
    id: o.id, numero: o.numero, cliente_nome: o.cliente_nome, cliente_tel: o.cliente_tel, total: o.total, validade: o.validade, status: o.status, criado_em: o.criado_em, url: o.url, pdf: o.pdf,
  })));
});
router.get('/api/admin/orcamentos/:id', requireAdmin, (req, res) => {
  const o = db.prepare('SELECT * FROM orcamentos WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Orçamento não encontrado.' });
  res.json(completo(o, base(req)));
});
router.post('/api/admin/orcamentos', requireAdmin, (req, res) => {
  const r = ler(req.body); if (r.erro) return res.status(400).json({ error: r.erro });
  const d = r.d, token = crypto.randomBytes(12).toString('hex');
  const info = db.prepare(`INSERT INTO orcamentos (token, cliente_nome, cliente_doc, cliente_tel, cliente_email, cliente_cep, cliente_cidade, cliente_uf, itens, frete, frete_desc, desconto, validade, obs, vendedor)
    VALUES (@token, @cliente_nome, @cliente_doc, @cliente_tel, @cliente_email, @cliente_cep, @cliente_cidade, @cliente_uf, @itens, @frete, @frete_desc, @desconto, @validade, @obs, @vendedor)`).run({ ...d, token });
  res.json(completo(db.prepare('SELECT * FROM orcamentos WHERE id = ?').get(info.lastInsertRowid), base(req)));
});
router.put('/api/admin/orcamentos/:id', requireAdmin, (req, res) => {
  const o = db.prepare('SELECT id FROM orcamentos WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Orçamento não encontrado.' });
  const r = ler(req.body); if (r.erro) return res.status(400).json({ error: r.erro });
  db.prepare(`UPDATE orcamentos SET cliente_nome=@cliente_nome, cliente_doc=@cliente_doc, cliente_tel=@cliente_tel, cliente_email=@cliente_email, cliente_cep=@cliente_cep,
    cliente_cidade=@cliente_cidade, cliente_uf=@cliente_uf, itens=@itens, frete=@frete, frete_desc=@frete_desc, desconto=@desconto, validade=@validade, obs=@obs, vendedor=@vendedor,
    atualizado_em=datetime('now') WHERE id=@id`).run({ ...r.d, id: o.id });
  res.json(completo(db.prepare('SELECT * FROM orcamentos WHERE id = ?').get(o.id), base(req)));
});
router.post('/api/admin/orcamentos/:id/status', requireAdmin, (req, res) => {
  const st = String((req.body || {}).status || '');
  if (!['aberto', 'aprovado', 'recusado'].includes(st)) return res.status(400).json({ error: 'Status inválido.' });
  const r = db.prepare("UPDATE orcamentos SET status=?, atualizado_em=datetime('now') WHERE id=?").run(st, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Orçamento não encontrado.' });
  res.json({ ok: true });
});
router.delete('/api/admin/orcamentos/:id', requireAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM orcamentos WHERE id=?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Orçamento não encontrado.' });
  res.json({ ok: true });
});

// ---------- dados do emitente ----------
function emitente() {
  const end = [set('rem_rua'), set('rem_numero') && 'nº ' + set('rem_numero'), set('rem_complemento'), set('rem_bairro')].filter(Boolean).join(', ');
  const cid = [set('rem_cidade'), set('rem_uf')].filter(Boolean).join(' - ');
  return { nome: set('rem_nome', 'NexTap'), doc: docFmt(set('rem_doc')), tel: telFmt(set('me_tel')), email: set('me_email'), endereco: [end, cid].filter(Boolean).join(' — '), site: (process.env.SITE_HOST || 'nextapbrasil.com.br').replace(/^https?:\/\//, '') };
}
const doToken = token => { const o = db.prepare('SELECT * FROM orcamentos WHERE token = ?').get(String(token || '')); return o || null; };

// ---------- página pública ----------
router.get('/o/:token', (req, res) => {
  const o = doToken(req.params.token);
  if (!o) return res.status(404).type('html').send('<meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h2>Orçamento não encontrado</h2><p>O link pode estar incorreto.</p>');
  const c = completo(o, base(req)), e = emitente();
  const venc = o.validade && o.validade < new Date().toISOString().slice(0, 10);
  const linhas = c.itens.map(i => `<tr><td>${i.img ? `<img src="${esc(i.img)}" alt="" style="width:46px;height:46px;object-fit:cover;border-radius:8px;vertical-align:middle;margin-right:10px">` : ''}${esc(i.desc)}</td><td class="r">${i.qtd}</td><td class="r">${BRL(i.unit)}</td><td class="r b">${BRL(i.qtd * i.unit)}</td></tr>`).join('');
  res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orçamento N ${c.numero} — ${esc(e.nome)}</title>
<style>:root{--g:#16a34a;--gd:#0f7a37;--tx:#0f172a;--mu:#64748b;--bd:#e2e8f0;--bg:#f1f5f9}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.w{max-width:820px;margin:0 auto;padding:18px 14px 40px}.bar{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-bottom:12px}.btn{border:1px solid var(--bd);background:#fff;color:var(--tx);padding:10px 16px;border-radius:999px;font:700 14px inherit;cursor:pointer;text-decoration:none}.btn.p{background:var(--g);border-color:var(--g);color:#fff}
.doc{background:#fff;border-radius:16px;padding:0;box-shadow:0 2px 14px #0f172a14;overflow:hidden}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;padding:22px 26px;border-bottom:4px solid var(--g)}
.top img{height:54px}.top .n{text-align:right}.top small{color:var(--g);font-weight:800;letter-spacing:.14em}.top h1{margin:0;font-size:30px;line-height:1.1}.emit{padding:12px 26px 0;color:var(--mu);font-size:13px}
.cli{margin:16px 26px;background:var(--bg);border-radius:12px;padding:14px 16px}.cli b{font-size:18px}.cli div{color:var(--mu);font-size:13px;margin-top:2px}
table{width:calc(100% - 52px);margin:0 26px;border-collapse:collapse}th{text-align:left;color:var(--mu);font-size:12px;padding:10px 6px;border-bottom:1px solid var(--bd)}td{padding:12px 6px;border-bottom:1px solid var(--bd)}.r{text-align:right}.b{font-weight:800}
.tot{margin:14px 26px 0;display:flex;flex-direction:column;align-items:flex-end;gap:4px}.tot .l{display:flex;gap:26px;color:var(--mu)}.tot .l b{color:var(--tx);min-width:110px;text-align:right}
.big{background:var(--g);color:#fff;border-radius:12px;padding:12px 18px;display:flex;justify-content:space-between;gap:30px;font-weight:800;font-size:20px;min-width:300px;margin-top:6px}
.inf{padding:16px 26px 8px;font-size:13px;color:var(--mu)}.inf b{color:var(--tx)}.obs{margin:0 26px 8px;background:#f8fafc;border-left:4px solid var(--g);padding:10px 14px;border-radius:8px;white-space:pre-wrap;font-size:14px}
.ft{padding:14px 26px 22px;color:var(--mu);font-size:12px;text-align:center}.venc{color:#dc2626;font-weight:800}
@media print{body{background:#fff}.bar{display:none}.w{padding:0}.doc{box-shadow:none}}</style></head><body><div class="w">
<div class="bar"><a class="btn" href="${esc(c.pdf)}">Baixar PDF</a><button class="btn p" onclick="window.print()">Imprimir</button></div>
<div class="doc"><div class="top"><img src="/logo.png" alt="${esc(e.nome)}"><div class="n"><small>ORÇAMENTO</small><h1>N ${c.numero}</h1><div style="color:var(--mu);font-size:13px">Emitido em ${dataBR(o.criado_em)}</div></div></div>
<div class="emit">${esc([e.nome, e.doc && 'CNPJ/CPF ' + e.doc, e.tel].filter(Boolean).join(' · '))}${e.endereco ? '<br>' + esc(e.endereco) : ''}</div>
<div class="cli"><b>${esc(o.cliente_nome)}</b><div>${esc([telFmt(o.cliente_tel), o.cliente_doc && 'CPF/CNPJ ' + docFmt(o.cliente_doc), o.cliente_email].filter(Boolean).join(' · '))}</div>${o.cliente_cidade ? `<div>${esc(o.cliente_cidade)}${o.cliente_uf ? '/' + esc(o.cliente_uf) : ''}${o.cliente_cep ? ' · CEP ' + esc(o.cliente_cep) : ''}</div>` : ''}</div>
<table><tr><th>Descrição</th><th class="r">Qtd.</th><th class="r">Unitário</th><th class="r">Subtotal</th></tr>${linhas}</table>
<div class="tot"><div class="l"><span>Subtotal</span><b>${BRL(c.subtotal)}</b></div>${o.frete ? `<div class="l"><span>Frete${o.frete_desc ? ' (' + esc(o.frete_desc) + ')' : ''}</span><b>${BRL(o.frete)}</b></div>` : ''}${o.desconto ? `<div class="l"><span>Desconto</span><b>− ${BRL(o.desconto)}</b></div>` : ''}<div class="big"><span>TOTAL</span><span>${BRL(c.total)}</span></div></div>
<div class="inf">${o.validade ? `<b>Validade:</b> até ${dataBR(o.validade)}${venc ? ' <span class="venc">(vencido)</span>' : ''}` : ''}${o.vendedor ? ` · <b>Vendedor:</b> ${esc(o.vendedor)}` : ''}</div>
${o.obs ? `<div class="obs">${esc(o.obs)}</div>` : ''}<div class="ft">${esc(e.nome)} · ${esc(e.site)}${e.tel ? ' · ' + esc(e.tel) : ''}</div></div></div></body></html>`);
});

// ---------- PDF ----------
router.get('/o/:token/pdf', (req, res) => {
  const o = doToken(req.params.token);
  if (!o) return res.status(404).send('Orçamento não encontrado.');
  const c = completo(o, base(req)), e = emitente();
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Orçamento N ${c.numero}` } });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="orcamento-${c.numero}.pdf"` });
  doc.pipe(res);
  const L = 40, W = 515, G = '#16a34a', MU = '#64748b', TX = '#0f172a';
  try { doc.image(path.join(__dirname, 'logo.png'), L, 36, { height: 46 }); } catch { doc.font('Helvetica-Bold').fontSize(20).fillColor(TX).text(e.nome, L, 44); }
  doc.font('Helvetica-Bold').fontSize(9).fillColor(G).text('ORÇAMENTO', L, 38, { width: W, align: 'right', characterSpacing: 2 });
  doc.fontSize(26).fillColor(TX).text('N ' + c.numero, L, 50, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MU).text('Emitido em ' + dataBR(o.criado_em), L, 82, { width: W, align: 'right' });
  doc.rect(L, 98, W, 3).fill(G);
  doc.font('Helvetica').fontSize(9).fillColor(MU).text([e.nome, e.doc && 'CNPJ/CPF ' + e.doc, e.tel].filter(Boolean).join('  ·  '), L, 110, { width: W });
  if (e.endereco) doc.text(e.endereco, L, doc.y + 1, { width: W });
  let y = doc.y + 12;
  const cl = [telFmt(o.cliente_tel), o.cliente_doc && 'CPF/CNPJ ' + docFmt(o.cliente_doc), o.cliente_email].filter(Boolean).join('  ·  ');
  const loc = o.cliente_cidade ? `${o.cliente_cidade}${o.cliente_uf ? '/' + o.cliente_uf : ''}${o.cliente_cep ? '  ·  CEP ' + o.cliente_cep : ''}` : '';
  const ch = 26 + (cl ? 14 : 0) + (loc ? 14 : 0);
  doc.roundedRect(L, y, W, ch, 8).fill('#f1f5f9');
  doc.font('Helvetica-Bold').fontSize(13).fillColor(TX).text(o.cliente_nome, L + 12, y + 8, { width: W - 24 });
  let yy = y + 26; doc.font('Helvetica').fontSize(9).fillColor(MU);
  if (cl) { doc.text(cl, L + 12, yy, { width: W - 24 }); yy += 14; } if (loc) doc.text(loc, L + 12, yy, { width: W - 24 });
  y += ch + 14;
  const col = { d: L, q: L + 300, u: L + 355, s: L + 440 };
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MU).text('DESCRIÇÃO', col.d + 4, y).text('QTD.', col.q, y, { width: 40, align: 'right' }).text('UNITÁRIO', col.u, y, { width: 70, align: 'right' }).text('SUBTOTAL', col.s, y, { width: 75, align: 'right' });
  y += 14; doc.moveTo(L, y).lineTo(L + W, y).strokeColor('#e2e8f0').stroke(); y += 6;
  for (const i of c.itens) {
    const buf = imgBuf(i.img), dx = buf ? 44 : 0;
    const h = Math.max(buf ? 44 : 20, doc.font('Helvetica').fontSize(10).heightOfString(i.desc, { width: 285 - dx }) + 10);
    if (y + h > 740) { doc.addPage(); y = 50; }
    if (buf) { try { doc.image(buf, col.d + 4, y + 4, { fit: [36, 36], align: 'center', valign: 'center' }); } catch (e) { /* formato não suportado */ } }
    doc.font('Helvetica').fontSize(10).fillColor(TX).text(i.desc, col.d + 4 + dx, y + (buf ? 15 : 4), { width: 285 - dx });
    doc.text(String(i.qtd), col.q, y + 4, { width: 40, align: 'right' }).text(BRL(i.unit), col.u, y + 4, { width: 70, align: 'right' });
    doc.font('Helvetica-Bold').text(BRL(i.qtd * i.unit), col.s, y + 4, { width: 75, align: 'right' });
    y += h; doc.moveTo(L, y).lineTo(L + W, y).strokeColor('#e2e8f0').stroke();
  }
  y += 12;
  const linha = (rot, val) => { doc.font('Helvetica').fontSize(10).fillColor(MU).text(rot, L + 280, y, { width: 150, align: 'right' }); doc.font('Helvetica-Bold').fillColor(TX).text(val, L + 435, y, { width: 80, align: 'right' }); y += 16; };
  if (y > 700) { doc.addPage(); y = 50; }
  linha('Subtotal', BRL(c.subtotal));
  if (o.frete) linha('Frete' + (o.frete_desc ? ' (' + o.frete_desc + ')' : ''), BRL(o.frete));
  if (o.desconto) linha('Desconto', '- ' + BRL(o.desconto));
  y += 4; doc.roundedRect(L + 250, y, 265, 36, 8).fill(G);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#ffffff').text('TOTAL', L + 266, y + 10).text(BRL(c.total), L + 340, y + 10, { width: 160, align: 'right' });
  y += 52;
  const inf = [o.validade && 'Validade: até ' + dataBR(o.validade), o.vendedor && 'Vendedor: ' + o.vendedor].filter(Boolean).join('   ·   ');
  if (inf) { doc.font('Helvetica').fontSize(9).fillColor(MU).text(inf, L, y, { width: W }); y = doc.y + 8; }
  if (o.obs) { const h = doc.font('Helvetica').fontSize(9.5).heightOfString(o.obs, { width: W - 24 }) + 16; doc.rect(L, y, 3, h).fill(G); doc.rect(L + 3, y, W - 3, h).fill('#f8fafc'); doc.fillColor(TX).text(o.obs, L + 14, y + 8, { width: W - 24 }); y += h + 8; }
  doc.font('Helvetica').fontSize(8).fillColor(MU).text([e.nome, e.site, e.tel].filter(Boolean).join('  ·  '), L, 790, { width: W, align: 'center' });
  doc.end();
});

module.exports = router;
