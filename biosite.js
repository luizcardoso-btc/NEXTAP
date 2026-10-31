// Biosite: página de links para o cliente final do revendedor. O revendedor monta, vê a prévia e paga o custo (settings.biosite_preco)
// por Pix para publicar. O preço de venda ao cliente final é dele (fica 100% com o revendedor).
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('./database.js');
const cv = require('./conversor-links.js');
const gl = require('./google-plano.js');
const { requireReseller, requireAdmin } = require('./auth-middleware.js');

const bad = (m, s = 422) => Object.assign(new Error(m), { status: s });
const preco = () => { const r = db.prepare("SELECT valor FROM settings WHERE chave='biosite_preco'").get(); const n = r ? Number(r.valor) : 25; return n > 0 ? n : 25; };
const TEMAS = { claro: 'Claro', escuro: 'Escuro', gradiente: 'Gradiente' };
const RESERVADOS = ['admin', 'api', 'r', 'pix', 'b', 'revendedor', 'avaliacao', 'biosites', 'login', 'www'];
const ROTULO = { whatsapp: 'Falar no WhatsApp', instagram: 'Instagram', facebook: 'Facebook', google: 'Avalie no Google', site: 'Nosso site', pix: 'Pagar com Pix', telefone: 'Ligar agora', maps: 'Como chegar', email: 'Enviar e-mail', outro: 'Saiba mais' };
const ICONE = { whatsapp: '💬', instagram: '📸', facebook: '👍', google: '⭐', site: '🌐', pix: '💠', telefone: '📞', maps: '📍', email: '✉️', outro: '🔗' };

function url(u) {
  u = String(u || '').trim(); if (!u) throw bad('Informe o link.');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let x; try { x = new URL(u); } catch (e) { throw bad('Link inválido: ' + u.slice(0, 40)); }
  if (!['http:', 'https:'].includes(x.protocol) || !x.hostname.includes('.')) throw bad('Link inválido: ' + u.slice(0, 40));
  return x.href;
}

// Converte o que o revendedor preencheu em um botão pronto. Guarda os campos originais para reeditar.
function normalizarLink(l) {
  const t = String((l && l.tipo) || ''), c = (l && l.campos) || {}, s = (k, m = 200) => String(c[k] == null ? '' : c[k]).trim().slice(0, m);
  const rotulo = String((l && l.rotulo) || '').trim().slice(0, 40) || ROTULO[t];
  let out;
  if (t === 'whatsapp') out = { url: cv.whatsapp({ numero: s('numero', 30), mensagem: s('mensagem', 300) }).link };
  else if (t === 'instagram') out = { url: cv.instagram(s('perfil', 120)).link };
  else if (t === 'facebook') out = { url: cv.facebook(s('pagina', 200)).link };
  else if (['google', 'site', 'maps', 'outro'].includes(t)) out = { url: url(s('url', 500)) };
  else if (t === 'telefone') { const d = s('numero', 30).replace(/\D/g, ''); const n = d.length <= 11 ? '55' + d : d; if (n.length < 12 || n.length > 15) throw bad('Telefone inválido. Informe com DDD.'); out = { url: 'tel:+' + n }; }
  else if (t === 'email') { const e = s('email', 120); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw bad('E-mail inválido.'); out = { url: 'mailto:' + e }; }
  else if (t === 'pix') { const p = cv.pix({ chave: s('chave', 80), nome: s('nome', 40), cidade: s('cidade', 40), valor: s('valor', 12), descricao: s('descricao', 40) }); out = { payload: p.payload, pix_nome: p.nome, pix_valor: p.valor }; }
  else throw bad('Tipo de botão inválido.');
  return { tipo: t, rotulo, campos: c, ...out };
}

const cor = c => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : '#15803d');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render(b, { preview = false } = {}) {
  const links = JSON.parse(b.links || '[]'), c = cor(b.cor), tema = TEMAS[b.tema] ? b.tema : 'claro';
  const foto = b.foto && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.foto) ? b.foto : '';
  const btns = links.map((l, i) => l.tipo === 'pix'
    ? `<button class="b" onclick="pix(${i})">${ICONE.pix} ${esc(l.rotulo)}</button><div class="px" id="px${i}" hidden><div class="q" id="q${i}"></div>${l.pix_valor ? `<b>R$ ${Number(l.pix_valor).toFixed(2).replace('.', ',')}</b><br>` : ''}<small>${esc(l.pix_nome || '')}</small><input readonly value="${esc(l.payload)}" onclick="this.select()"><button class="b" onclick="cp(${i},this)">Copiar código Pix</button></div>`
    : `<a class="b" href="${esc(l.url)}" target="_blank" rel="noopener nofollow">${ICONE[l.tipo] || '🔗'} ${esc(l.rotulo)}</a>`).join('');
  const bg = { claro: '#f3f6f4', escuro: '#0e1512', gradiente: `linear-gradient(160deg, ${c}, #0e1512)` }[tema];
  const fg = tema === 'claro' ? '#10201a' : '#f2f7f4', card = tema === 'claro' ? '#fff' : 'rgba(255,255,255,.1)', bd = tema === 'claro' ? '#dfe8e2' : 'rgba(255,255,255,.18)';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(b.titulo)}</title>
<meta name="description" content="${esc((b.bio || '').slice(0, 150))}"><meta property="og:title" content="${esc(b.titulo)}"><meta property="og:description" content="${esc((b.bio || '').slice(0, 150))}">${preview ? '<meta name="robots" content="noindex">' : ''}
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:${bg};color:${fg};font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;justify-content:center;padding:28px 16px}
.w{width:100%;max-width:440px;text-align:center}.f{width:104px;height:104px;border-radius:50%;object-fit:cover;border:3px solid ${c};margin:0 auto 12px;display:block;background:${card}}
.i{width:104px;height:104px;border-radius:50%;background:${c};color:#fff;display:grid;place-items:center;font-size:42px;font-weight:800;margin:0 auto 12px}
h1{font-size:23px;margin:0 0 6px}p{margin:0 0 20px;opacity:.85;white-space:pre-line;line-height:1.45}
.b{display:block;width:100%;padding:15px 16px;margin:0 0 11px;border-radius:14px;background:${card};border:1px solid ${bd};color:${fg};font:700 16px system-ui,sans-serif;text-decoration:none;cursor:pointer;transition:transform .12s,border-color .12s}
.b:hover{transform:translateY(-2px);border-color:${c}}.px{background:${card};border:1px solid ${bd};border-radius:14px;padding:14px;margin:-3px 0 12px}.q{background:#fff;padding:8px;border-radius:10px;width:200px;height:200px;margin:0 auto 8px}.q svg{width:100%;height:100%}
.px input{width:100%;padding:10px;border-radius:10px;border:1px solid ${bd};background:transparent;color:${fg};margin:8px 0;font:inherit;font-size:13px}.px .b{margin:0;background:${c};color:#fff;border:0}
footer{margin-top:24px;font-size:12px;opacity:.55}footer a{color:inherit}</style></head><body><div class="w">
${foto ? `<img class="f" src="${foto}" alt="${esc(b.titulo)}">` : `<div class="i">${esc((b.titulo || '?').trim().charAt(0).toUpperCase())}</div>`}
<h1>${esc(b.titulo)}</h1>${b.bio ? `<p>${esc(b.bio)}</p>` : '<p></p>'}${btns || '<p style="opacity:.6">Adicione botões para aparecerem aqui.</p>'}
<footer>Biosite por <a href="/" rel="noopener">NexTap</a></footer></div>
<script>var L=${JSON.stringify(links.map(l => l.payload || '')).replace(/</g, '\\u003c')};
function pix(i){var e=document.getElementById('px'+i);e.hidden=!e.hidden;var q=document.getElementById('q'+i);if(!q.innerHTML){try{var z=qrcode(0,'M');z.addData(L[i]);z.make();q.innerHTML=z.createSvgTag({scalable:true,margin:0})}catch(x){}}}
function cp(i,b){var ok=function(){b.textContent='Copiado ✓'};if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(L[i]).then(ok,function(){});else{var n=document.querySelector('#px'+i+' input');n.select();try{document.execCommand('copy');ok()}catch(e){}}}</script></body></html>`;
}

const router = express.Router();

// ---------- público ----------
router.get('/b/:slug', (req, res) => {
  const b = db.prepare("SELECT * FROM biosites WHERE slug = ? AND status = 'publicado'").get(String(req.params.slug).toLowerCase());
  if (!b) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;text-align:center;padding:60px 20px"><h2>Biosite não encontrado</h2><p>Este endereço não existe ou ainda não foi publicado.</p>');
  if (!/bot|crawl|spider|preview|facebookexternalhit|whatsapp/i.test(req.get('user-agent') || '')) db.prepare('INSERT INTO biosite_views (biosite_id) VALUES (?)').run(b.id);
  res.set('Cache-Control', 'no-cache').type('html').send(render(b));
});

// ---------- revendedor ----------
const R = express.Router(); R.use(requireReseller);
const meu = (req) => db.prepare('SELECT * FROM biosites WHERE id = ? AND reseller_id = ?').get(req.params.id, req.resellerId);
const base = req => (process.env.SITE_HOST ? 'https://' + process.env.SITE_HOST.replace(/^https?:\/\//, '') : `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const dto = (b, req) => ({ id: b.id, slug: b.slug, status: b.status, titulo: b.titulo, bio: b.bio, tema: b.tema, cor: b.cor, foto: b.foto, links: JSON.parse(b.links || '[]'),
  cliente_nome: b.cliente_nome, preco_venda: b.preco_venda, criado_em: b.criado_em, publicado_em: b.publicado_em, url: `${base(req)}/b/${b.slug}`,
  visitas: db.prepare('SELECT COUNT(*) AS n FROM biosite_views WHERE biosite_id = ?').get(b.id).n });

function slugLivre(s, ignorarId) {
  s = String(s || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
  if (!/^[a-z0-9][a-z0-9-]{2,29}$/.test(s)) throw bad('Endereço inválido: use de 3 a 30 letras minúsculas, números ou hífen.');
  if (RESERVADOS.includes(s)) throw bad('Esse endereço é reservado. Escolha outro.');
  const o = db.prepare('SELECT id FROM biosites WHERE slug = ?').get(s);
  if (o && o.id !== ignorarId) throw bad('Esse endereço já está em uso. Escolha outro.', 409);
  return s;
}
const txt = (v, m) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, m);
const wrap = fn => (req, res) => { try { fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };

R.get('/', (req, res) => {
  const lista = db.prepare('SELECT * FROM biosites WHERE reseller_id = ? ORDER BY id DESC').all(req.resellerId).map(b => dto(b, req));
  const custo = preco();
  res.json({ preco: custo, cortesia: !!db.prepare('SELECT cortesia FROM resellers WHERE id = ?').get(req.resellerId)?.cortesia, venda_min: 100, venda_max: 200, lista: lista.map(({ foto, links, ...x }) => ({ ...x, tem_foto: !!foto, botoes: links.length })),
    resumo: { publicados: lista.filter(b => b.status === 'publicado').length, lucro_estimado: lista.filter(b => b.status === 'publicado' && b.preco_venda > 0).reduce((s, b) => s + b.preco_venda - custo, 0) } });
});

R.post('/', wrap((req, res) => {
  const t = txt((req.body || {}).titulo, 60); if (t.length < 2) throw bad('Informe o nome do negócio.');
  let slug = txt((req.body || {}).slug, 30) || t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  try { slug = slugLivre(slug); } catch (e) { if (!(req.body || {}).slug) slug = slugLivre((slug.slice(0, 20) || 'meu') + '-' + nanoid(5).toLowerCase().replace(/[^a-z0-9]/g, 'x')); else throw e; }
  const id = db.prepare('INSERT INTO biosites (reseller_id, slug, titulo) VALUES (?, ?, ?)').run(req.resellerId, slug, t).lastInsertRowid;
  res.json(dto(db.prepare('SELECT * FROM biosites WHERE id = ?').get(id), req));
}));
R.get('/pagamento/:pid', async (req, res) => {
  const p = db.prepare('SELECT * FROM biosite_pagamentos WHERE id = ? AND reseller_id = ?').get(req.params.pid, req.resellerId);
  if (!p) return res.status(404).json({ error: 'Pagamento não encontrado.' });
  if (p.status === 'pendente' && p.mp_payment_id && process.env.MP_ACCESS_TOKEN) { try { aplicarPagamento(await gl.mp('/v1/payments/' + p.mp_payment_id)); } catch (e) { console.error('[BIOSITE] conferência falhou:', e.message); } }
  const n = db.prepare('SELECT status FROM biosite_pagamentos WHERE id = ?').get(p.id);
  res.json({ status: n.status, biosite: dto(db.prepare('SELECT * FROM biosites WHERE id = ?').get(p.biosite_id), req) });
});
R.get('/:id', wrap((req, res) => { const b = meu(req); if (!b) throw bad('Biosite não encontrado.', 404); res.json(dto(b, req)); }));
R.get('/:id/preview', wrap((req, res) => { const b = meu(req); if (!b) throw bad('Biosite não encontrado.', 404); res.type('html').send(render(b, { preview: true })); }));
R.put('/:id', wrap((req, res) => {
  const b = meu(req); if (!b) throw bad('Biosite não encontrado.', 404);
  const x = req.body || {}, v = {};
  if (x.titulo !== undefined) { v.titulo = txt(x.titulo, 60); if (v.titulo.length < 2) throw bad('Informe o nome do negócio.'); }
  if (x.bio !== undefined) v.bio = txt(x.bio, 400);
  if (x.tema !== undefined) { if (!TEMAS[x.tema]) throw bad('Tema inválido.'); v.tema = x.tema; }
  if (x.cor !== undefined) v.cor = cor(x.cor);
  if (x.cliente_nome !== undefined) v.cliente_nome = txt(x.cliente_nome, 80);
  if (x.preco_venda !== undefined) { const n = x.preco_venda === '' || x.preco_venda === null ? null : Number(String(x.preco_venda).replace(',', '.')); if (n !== null && !(n >= 0 && n <= 100000)) throw bad('Preço de venda inválido.'); v.preco_venda = n; }
  if (x.slug !== undefined && x.slug !== b.slug) { if (b.status === 'publicado') throw bad('O endereço de um biosite publicado não pode mudar (o link já foi entregue).'); v.slug = slugLivre(x.slug, b.id); }
  if (x.foto !== undefined) { if (x.foto && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(x.foto) || x.foto.length > 150000)) throw bad('Imagem inválida ou grande demais.'); v.foto = x.foto || null; }
  if (x.links !== undefined) { if (!Array.isArray(x.links) || x.links.length > 12) throw bad('No máximo 12 botões.'); v.links = JSON.stringify(x.links.map(normalizarLink)); }
  const cols = Object.keys(v);
  if (cols.length) db.prepare(`UPDATE biosites SET ${cols.map(k => k + ' = ?').join(', ')}, atualizado_em = datetime('now') WHERE id = ?`).run(...cols.map(k => v[k]), b.id);
  res.json(dto(db.prepare('SELECT * FROM biosites WHERE id = ?').get(b.id), req));
}));
R.delete('/:id', wrap((req, res) => {
  const b = meu(req); if (!b) throw bad('Biosite não encontrado.', 404);
  if (b.status === 'publicado') throw bad('Biosite publicado não pode ser apagado.', 409);
  db.prepare('DELETE FROM biosite_pagamentos WHERE biosite_id = ? AND status <> ?').run(b.id, 'pago'); db.prepare('DELETE FROM biosites WHERE id = ?').run(b.id); res.json({ ok: true });
}));

// Pix de publicação (reaproveita um pendente de menos de 25 min)
R.post('/:id/publicar', async (req, res) => {
  try {
    const b = meu(req); if (!b) throw bad('Biosite não encontrado.', 404);
    if (b.status === 'publicado') throw bad('Este biosite já está publicado.', 409);
    if (!JSON.parse(b.links || '[]').length) throw bad('Adicione pelo menos 1 botão antes de publicar.');
    if (db.prepare('SELECT cortesia FROM resellers WHERE id = ?').get(req.resellerId)?.cortesia) { // cortesia: publica sem cobrar
      db.prepare("UPDATE biosites SET status='publicado', publicado_em=COALESCE(publicado_em, datetime('now')), custo_pago=0 WHERE id=?").run(b.id);
      return res.json({ publicado: true, biosite: dto(db.prepare('SELECT * FROM biosites WHERE id = ?').get(b.id), req) });
    }
    if (!process.env.MP_ACCESS_TOKEN) throw bad('Pagamento indisponível no momento. Fale com o suporte.', 503);
    const v = x => ({ id: x.id, valor: x.valor, status: x.status, pix_qr_code: x.pix_qr_code, pix_qr_base64: x.pix_qr_base64 });
    const pend = db.prepare("SELECT * FROM biosite_pagamentos WHERE biosite_id = ? AND status = 'pendente' AND mp_payment_id IS NOT NULL AND criado_em > datetime('now','-25 minutes') ORDER BY id DESC").get(b.id);
    if (pend) return res.json(v(pend));
    const r = db.prepare('SELECT name, email FROM resellers WHERE id = ?').get(req.resellerId), valor = preco();
    const id = db.prepare('INSERT INTO biosite_pagamentos (biosite_id, reseller_id, valor) VALUES (?, ?, ?)').run(b.id, req.resellerId, valor).lastInsertRowid;
    try {
      const nome = String(r.name || 'Cliente').trim().split(/\s+/), u = (() => { try { const o = new URL((process.env.PUBLIC_BACKEND_URL || '').trim()); return o.protocol === 'https:' ? o.origin : ''; } catch (e) { return ''; } })();
      const pay = await gl.mp('/v1/payments', { method: 'POST', headers: { 'X-Idempotency-Key': `nextap-bs-${id}` }, body: JSON.stringify({ transaction_amount: valor, description: `NexTap Biosite — ${b.slug}`, payment_method_id: 'pix',
        payer: { email: r.email, first_name: nome[0], last_name: nome.slice(1).join(' ') || nome[0] }, external_reference: `BS-${id}`, ...(u ? { notification_url: `${u}/api/payments/webhook` } : {}) }) });
      const t = (pay.point_of_interaction && pay.point_of_interaction.transaction_data) || {};
      db.prepare('UPDATE biosite_pagamentos SET mp_payment_id = ?, pix_qr_code = ?, pix_qr_base64 = ? WHERE id = ?').run(String(pay.id), t.qr_code || '', t.qr_code_base64 || '', id);
    } catch (e) { db.prepare('DELETE FROM biosite_pagamentos WHERE id = ? AND mp_payment_id IS NULL').run(id); console.error('[BIOSITE] falha ao criar Pix:', e.message); throw bad('Não consegui gerar o Pix agora. Tente de novo em instantes.', 502); }
    res.json(v(db.prepare('SELECT * FROM biosite_pagamentos WHERE id = ?').get(id)));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.use('/api/biosites', R);

// Aplica um pagamento aprovado do Mercado Pago (webhook ou conferência): publica o biosite UMA vez.
function aplicarPagamento(pay) {
  const p = db.prepare('SELECT * FROM biosite_pagamentos WHERE mp_payment_id = ?').get(String(pay.id));
  if (!p) return 'sem_pagamento';
  if (p.status === 'pago') return 'ja_pago';
  if (pay.status !== 'approved') { if (['rejected', 'cancelled', 'expired'].includes(pay.status)) db.prepare("UPDATE biosite_pagamentos SET status='cancelado' WHERE id=?").run(p.id); return 'pendente'; }
  if (Math.abs(Number(pay.transaction_amount) - p.valor) > 0.009) { console.error(`[BIOSITE] valor divergente no pagamento ${pay.id}`); return 'divergente'; }
  db.transaction(() => {
    db.prepare("UPDATE biosite_pagamentos SET status='pago', pago_em=datetime('now') WHERE id=? AND status<>'pago'").run(p.id);
    db.prepare("UPDATE biosites SET status='publicado', publicado_em=COALESCE(publicado_em, datetime('now')), custo_pago=? WHERE id=?").run(p.valor, p.biosite_id);
  })();
  return 'pago';
}

// ---------- admin ----------
const A = express.Router(); A.use(requireAdmin);
A.get('/', (req, res) => {
  const q = s => db.prepare(s).get();
  const lista = db.prepare(`SELECT b.id, b.slug, b.titulo, b.status, b.preco_venda, b.custo_pago, b.criado_em, b.publicado_em, r.name AS revendedor, r.email,
    (SELECT COUNT(*) FROM biosite_views v WHERE v.biosite_id = b.id) AS visitas FROM biosites b JOIN resellers r ON r.id = b.reseller_id ORDER BY b.id DESC LIMIT 300`).all();
  res.json({ preco: preco(), resumo: { publicados: q("SELECT COUNT(*) AS n FROM biosites WHERE status='publicado'").n, rascunhos: q("SELECT COUNT(*) AS n FROM biosites WHERE status='rascunho'").n,
    faturamento_total: q("SELECT COALESCE(SUM(valor),0) AS s FROM biosite_pagamentos WHERE status='pago'").s,
    faturamento_mes: q("SELECT COALESCE(SUM(valor),0) AS s FROM biosite_pagamentos WHERE status='pago' AND strftime('%Y-%m',pago_em)=strftime('%Y-%m','now')").s,
    vendas_revendedores: q("SELECT COALESCE(SUM(preco_venda),0) AS s FROM biosites WHERE status='publicado'").s, pix_pendentes: q("SELECT COUNT(*) AS n FROM biosite_pagamentos WHERE status='pendente' AND criado_em > datetime('now','-1 day')").n }, lista });
});
A.put('/preco', (req, res) => {
  const n = Number(String((req.body || {}).preco).replace(',', '.'));
  if (!(n >= 1 && n <= 1000)) return res.status(400).json({ error: 'Informe um valor entre R$ 1 e R$ 1.000.' });
  db.prepare("INSERT INTO settings (chave, valor) VALUES ('biosite_preco', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(n.toFixed(2));
  res.json({ preco: n });
});
router.use('/api/admin/biosites', A);

router.aplicarPagamento = aplicarPagamento;
module.exports = router;
