// Cardápio inteligente em vídeo — ARQUIVO NOVO. Público: /c/:slug (abre ao aproximar o celular da placa).
// Admin: /api/admin/restaurantes/:id/cardapio (+ itens). Vídeos entram por LINK (YouTube, Vimeo ou .mp4), nada pesado no servidor.
const express = require('express');
const db = require('./database.js');
const { requireAdmin } = require('./auth-middleware.js');

const router = express.Router();
const txt = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const bad = (m, c = 400) => Object.assign(new Error(m), { status: c });
const wrap = f => (req, res) => { try { f(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro interno.' }); if (!e.status) console.error(e); } };
const base = req => (process.env.SITE_HOST ? 'https://' + process.env.SITE_HOST.replace(/^https?:\/\//, '') : `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const money = v => { let t = String(v ?? '').replace(/R\$|\s/g, ''); if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.'); const n = Number(t); return Number.isFinite(n) && n >= 0 && n <= 9999 ? Math.round(n * 100) / 100 : null; };
const httpsUrl = v => { const t = String(v ?? '').trim(); if (!t) return ''; return /^https:\/\/[^\s"'<>]{4,480}$/i.test(t) ? t : null; };

// Reconhece o link do vídeo e devolve como tocar: YouTube e Vimeo (incorporados) ou arquivo direto (.mp4/.webm).
function midia(url) {
  if (!url) return null; let u; try { u = new URL(url); } catch (e) { return null; }
  const h = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
  let id;
  if (h === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (h === 'youtube.com') id = u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/embed/') ? u.pathname.split('/')[2] : u.searchParams.get('v');
  if (id && /^[\w-]{11}$/.test(id)) return { t: 'yt', id };
  if (h === 'vimeo.com' || h === 'player.vimeo.com') { const m = u.pathname.match(/(\d{6,12})/); if (m) return { t: 'vm', id: m[1] }; }
  if (/\.(mp4|webm|m4v|mov)$/i.test(u.pathname)) return { t: 'mp4', src: url };
  return null;
}
const thumb = (m, foto) => foto || (m && m.t === 'yt' ? `https://i.ytimg.com/vi/${m.id}/hqdefault.jpg` : '');
const slugOk = s => { s = String(s || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, ''); if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(s)) throw bad('Endereço inválido: use de 3 a 40 letras minúsculas, números ou hífen.'); return s; };
const zap = v => { const d = String(v || '').replace(/\D/g, ''); if (!d) return ''; if (d.length < 10 || d.length > 13) return null; return d.length <= 11 ? '55' + d : d; };
const corOk = v => /^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : '#e11d48';

// ---------------- admin ----------------
const A = express.Router(); A.use('/api/admin', requireAdmin);
const rest = id => db.prepare('SELECT * FROM restaurantes WHERE id = ?').get(id) || (() => { throw bad('Restaurante não encontrado.', 404); })();
const stats = cid => {
  const q = tipo => db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(valor),0) AS v FROM cardapio_eventos WHERE cardapio_id = ? AND tipo = ? AND criado_em > datetime('now','-30 days')").get(cid, tipo);
  const v = q('visita'), p = q('pedido'); return { visitas_30d: v.n, pedidos_30d: p.n, valor_pedidos_30d: p.v };
};
A.get('/api/admin/restaurantes/:id/cardapio', wrap((req, res) => {
  const r = rest(req.params.id), c = db.prepare('SELECT * FROM cardapios WHERE restaurante_id = ?').get(r.id);
  if (!c) return res.json({ cardapio: null, itens: [], sugestao_slug: slugSugerido(r.nome) });
  res.json({ cardapio: { ...c, url: `${base(req)}/c/${c.slug}` }, itens: db.prepare('SELECT * FROM cardapio_itens WHERE cardapio_id = ? ORDER BY ordem, id').all(c.id), stats: stats(c.id) });
}));
function slugSugerido(n) { let s = String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30); if (s.length < 3) s = 'restaurante-' + s; let x = s, i = 2; while (db.prepare('SELECT 1 FROM cardapios WHERE slug = ?').get(x)) x = s + '-' + i++; return x; }

A.put('/api/admin/restaurantes/:id/cardapio', wrap((req, res) => {
  const r = rest(req.params.id), b = req.body || {}, o = db.prepare('SELECT * FROM cardapios WHERE restaurante_id = ?').get(r.id);
  const titulo = txt(b.titulo ?? o?.titulo ?? r.nome, 80); if (!titulo) throw bad('Informe o nome que aparece no cardápio.');
  const slug = slugOk(b.slug ?? o?.slug ?? slugSugerido(r.nome));
  const dup = db.prepare('SELECT restaurante_id FROM cardapios WHERE slug = ?').get(slug); if (dup && dup.restaurante_id !== r.id) throw bad('Esse endereço já está em uso. Escolha outro.', 409);
  const logo = httpsUrl(b.logo_url ?? o?.logo_url); if (logo === null) throw bad('Link da logo inválido. Use o endereço completo, começando com https://');
  const wa = zap(b.whatsapp ?? o?.whatsapp); if (wa === null) throw bad('WhatsApp inválido. Use DDD + número.');
  const d = { titulo, slug, descricao: txt(b.descricao ?? o?.descricao ?? '', 200), cor: corOk(b.cor ?? o?.cor), tema: (b.tema ?? o?.tema) === 'claro' ? 'claro' : 'escuro', logo_url: logo, whatsapp: wa,
    instagram: txt(b.instagram ?? o?.instagram ?? '', 40).replace(/^@/, '').replace(/[^\w.]/g, ''), ativo: (b.ativo ?? o?.ativo ?? 1) ? 1 : 0 };
  db.transaction(() => {
    if (o) db.prepare("UPDATE cardapios SET titulo=@titulo, slug=@slug, descricao=@descricao, cor=@cor, tema=@tema, logo_url=@logo_url, whatsapp=@whatsapp, instagram=@instagram, ativo=@ativo, atualizado_em=datetime('now') WHERE id=@id").run({ ...d, id: o.id });
    else db.prepare('INSERT INTO cardapios (restaurante_id, titulo, slug, descricao, cor, tema, logo_url, whatsapp, instagram, ativo) VALUES (@rid, @titulo, @slug, @descricao, @cor, @tema, @logo_url, @whatsapp, @instagram, @ativo)').run({ ...d, rid: r.id });
    // O link do cardápio do restaurante passa a ser o cardápio inteligente; se a placa já estiver ligada, ela abre o novo endereço.
    const url = `${base(req)}/c/${slug}`;
    db.prepare("UPDATE restaurantes SET link_cardapio = ?, atualizado_em = datetime('now') WHERE id = ?").run(url, r.id);
    if (r.plate_id) db.prepare("UPDATE plates SET destination_url = ?, destination_type = 'Cardápio', status = 'ativa' WHERE id = ?").run(url, r.plate_id);
  })();
  res.json({ ok: true, url: `${base(req)}/c/${slug}` });
}));

function lerItem(b, o = {}) {
  const nome = txt(b.nome ?? o.nome, 80); if (!nome) throw bad('Informe o nome do prato.');
  const preco = b.preco === undefined || b.preco === '' ? (o.preco ?? 0) : money(b.preco); if (preco === null) throw bad('Preço inválido (ex.: 39,90).');
  const foto = httpsUrl(b.foto_url ?? o.foto_url); if (foto === null) throw bad('Link da foto inválido. Use o endereço completo, começando com https://');
  const vraw = String(b.video_url ?? o.video_url ?? '').trim(); let video = '';
  if (vraw) { if (!midia(vraw)) throw bad('Link de vídeo não reconhecido. Use YouTube, Vimeo ou um arquivo .mp4/.webm (começando com https://).'); video = vraw.slice(0, 500); }
  return { categoria: txt(b.categoria ?? o.categoria ?? 'Cardápio', 40) || 'Cardápio', nome, descricao: txt(b.descricao ?? o.descricao ?? '', 220), preco, foto_url: foto, video_url: video,
    destaque: (b.destaque ?? o.destaque) ? 1 : 0, ativo: (b.ativo ?? o.ativo ?? 1) ? 1 : 0, ordem: Number.isFinite(Number(b.ordem ?? o.ordem)) ? Math.trunc(Number(b.ordem ?? o.ordem)) : 0 };
}
A.post('/api/admin/restaurantes/:id/cardapio/itens', wrap((req, res) => {
  const c = db.prepare('SELECT id FROM cardapios WHERE restaurante_id = ?').get(req.params.id); if (!c) throw bad('Crie o cardápio antes de adicionar pratos.', 409);
  const d = lerItem(req.body || {}); if (req.body?.ordem === undefined) d.ordem = db.prepare('SELECT COALESCE(MAX(ordem),0)+1 AS m FROM cardapio_itens WHERE cardapio_id = ?').get(c.id).m;
  res.json({ id: Number(db.prepare('INSERT INTO cardapio_itens (cardapio_id, categoria, nome, descricao, preco, foto_url, video_url, destaque, ativo, ordem) VALUES (@cid, @categoria, @nome, @descricao, @preco, @foto_url, @video_url, @destaque, @ativo, @ordem)').run({ ...d, cid: c.id }).lastInsertRowid) });
}));
A.put('/api/admin/cardapio-itens/:iid', wrap((req, res) => {
  const o = db.prepare('SELECT * FROM cardapio_itens WHERE id = ?').get(req.params.iid); if (!o) throw bad('Prato não encontrado.', 404);
  const d = lerItem(req.body || {}, o);
  db.prepare('UPDATE cardapio_itens SET categoria=@categoria, nome=@nome, descricao=@descricao, preco=@preco, foto_url=@foto_url, video_url=@video_url, destaque=@destaque, ativo=@ativo, ordem=@ordem WHERE id=@id').run({ ...d, id: o.id }); res.json({ ok: true });
}));
A.delete('/api/admin/cardapio-itens/:iid', wrap((req, res) => {
  if (!db.prepare('DELETE FROM cardapio_itens WHERE id = ?').run(req.params.iid).changes) throw bad('Prato não encontrado.', 404); res.json({ ok: true });
}));
router.use(A);

// ---------------- público ----------------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nao = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;text-align:center;padding:60px 20px"><h2>Cardápio não encontrado</h2><p>Este endereço não existe ou está desativado.</p>';

router.get('/c/:slug', (req, res) => {
  const c = db.prepare('SELECT * FROM cardapios WHERE slug = ? AND ativo = 1').get(String(req.params.slug).toLowerCase());
  if (!c) return res.status(404).type('html').send(nao);
  const mesa = txt(req.query.mesa, 10).replace(/[^\w-]/g, '');
  if (!/bot|crawl|spider|preview|facebookexternalhit|whatsapp/i.test(req.get('user-agent') || '')) db.prepare("INSERT INTO cardapio_eventos (cardapio_id, tipo, mesa) VALUES (?, 'visita', ?)").run(c.id, mesa);
  const itens = db.prepare('SELECT * FROM cardapio_itens WHERE cardapio_id = ? AND ativo = 1 ORDER BY ordem, id').all(c.id).map(i => {
    const m = midia(i.video_url); return { id: i.id, c: i.categoria, n: i.nome, d: i.descricao, p: i.preco, f: i.foto_url, t: thumb(m, i.foto_url), m, s: i.destaque };
  });
  const dados = { t: c.titulo, d: c.descricao, cor: c.cor, tema: c.tema, logo: c.logo_url, wa: c.whatsapp, ig: c.instagram, mesa, slug: c.slug, itens };
  const json = JSON.stringify(dados).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');
  res.set('Cache-Control', 'no-cache').type('html').send(pagina(c, json));
});
router.post('/c/:slug/evento', (req, res) => {
  const c = db.prepare('SELECT id FROM cardapios WHERE slug = ? AND ativo = 1').get(String(req.params.slug).toLowerCase()); if (!c) return res.status(404).json({ error: 'x' });
  const b = req.body || {}; if (b.tipo !== 'pedido') return res.status(400).json({ error: 'x' });
  const ult = db.prepare("SELECT COUNT(*) AS n FROM cardapio_eventos WHERE cardapio_id = ? AND tipo = 'pedido' AND criado_em > datetime('now','-1 minutes')").get(c.id).n; if (ult >= 20) return res.status(429).json({ error: 'x' });
  const v = Number(b.valor); db.prepare("INSERT INTO cardapio_eventos (cardapio_id, tipo, mesa, valor) VALUES (?, 'pedido', ?, ?)").run(c.id, txt(b.mesa, 10).replace(/[^\w-]/g, ''), Number.isFinite(v) && v >= 0 && v < 100000 ? v : 0);
  res.json({ ok: true });
});

const CSS = String.raw`
:root{--ac:#e11d48;--bg:#0b0b0f;--fg:#f5f5f7;--mut:#9a9aa5;--card:#16161d;--bd:#26262f}
body.claro{--bg:#faf8f5;--fg:#1c1917;--mut:#78716c;--card:#fff;--bd:#e7e2db}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding-bottom:90px}
button{font:inherit;cursor:pointer;border:0}
.hero{position:relative;min-height:78svh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 22px;overflow:hidden;background:radial-gradient(120% 90% at 50% 0%,color-mix(in srgb,var(--ac) 55%,#000) 0%,var(--bg) 70%)}
.hero:before,.hero:after{content:"";position:absolute;width:340px;height:340px;border-radius:50%;background:var(--ac);opacity:.18;filter:blur(70px);animation:fl 9s ease-in-out infinite}
.hero:before{top:-90px;left:-110px}.hero:after{bottom:-120px;right:-100px;animation-delay:-4s}
@keyframes fl{50%{transform:translate(40px,30px) scale(1.15)}}
.hero>*{position:relative;z-index:1;animation:up .8s both}.hero>*:nth-child(2){animation-delay:.12s}.hero>*:nth-child(3){animation-delay:.24s}.hero>*:nth-child(4){animation-delay:.36s}
@keyframes up{from{opacity:0;transform:translateY(22px)}}
.logo{width:104px;height:104px;border-radius:50%;object-fit:cover;border:3px solid var(--ac);box-shadow:0 0 0 6px color-mix(in srgb,var(--ac) 25%,transparent);margin-bottom:18px;background:#000}
h1{margin:0 0 8px;font-size:clamp(28px,8vw,44px);line-height:1.05;letter-spacing:-.02em}
.sub{color:var(--mut);max-width:420px;margin:0 auto 24px;line-height:1.5}
.mesa{display:inline-block;background:color-mix(in srgb,var(--ac) 22%,transparent);color:var(--fg);padding:5px 14px;border-radius:99px;font-size:13px;font-weight:600;margin-bottom:16px}
.play{background:var(--ac);color:#fff;font-weight:700;font-size:17px;padding:16px 28px;border-radius:99px;box-shadow:0 10px 30px color-mix(in srgb,var(--ac) 50%,transparent);animation:pl 2.2s infinite}
@keyframes pl{50%{transform:scale(1.045)}}
.ghost{background:transparent;color:var(--fg);border:1.5px solid var(--bd);padding:11px 20px;border-radius:99px;margin-top:12px;font-size:14px}
.tabs{position:sticky;top:0;z-index:5;display:flex;gap:8px;overflow-x:auto;padding:12px 14px;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--bd);scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}.tabs button{flex:0 0 auto;background:var(--card);color:var(--fg);border:1px solid var(--bd);padding:8px 16px;border-radius:99px;font-size:14px;font-weight:600}
.tabs button.on{background:var(--ac);border-color:var(--ac);color:#fff}
.sec{padding:20px 14px 0;max-width:720px;margin:0 auto}.sec h2{margin:0 0 12px;font-size:20px}
.it{display:flex;gap:12px;background:var(--card);border:1px solid var(--bd);border-radius:18px;padding:10px;margin-bottom:12px;cursor:pointer;animation:up .5s both}
.th{position:relative;flex:0 0 104px;height:104px;border-radius:14px;overflow:hidden;background:linear-gradient(135deg,color-mix(in srgb,var(--ac) 40%,#000),#111);display:grid;place-items:center;font-size:34px}
.th img,.th video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.th i{position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.65);color:#fff;font-style:normal;font-size:11px;padding:2px 7px;border-radius:99px;z-index:2}
.bd{flex:1;min-width:0;display:flex;flex-direction:column}.bd b{font-size:16px}.bd p{margin:4px 0 8px;color:var(--mut);font-size:13px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ft{margin-top:auto;display:flex;align-items:center;justify-content:space-between}.pr{font-weight:800;color:var(--ac)}
.add{background:var(--ac);color:#fff;width:36px;height:36px;border-radius:50%;font-size:22px;line-height:1}
.star{color:#f59e0b;font-size:12px;margin-left:4px}
#reel{position:fixed;inset:0;z-index:50;background:#000;display:none}#reel.on{display:block}
#rs{height:100%;overflow-y:scroll;scroll-snap-type:y mandatory;scrollbar-width:none}#rs::-webkit-scrollbar{display:none}
.sl{position:relative;height:100dvh;scroll-snap-align:start;scroll-snap-stop:always;overflow:hidden;background:#000;color:#fff}
.sl .md{position:absolute;inset:0}.sl video,.sl iframe,.sl img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border:0}
.sl .md.yt iframe{width:177.78vh;min-width:100%;height:100%;left:50%;transform:translateX(-50%);pointer-events:none}
.sl .nomd{position:absolute;inset:0;display:grid;place-items:center;font-size:90px;background:radial-gradient(circle at 50% 30%,color-mix(in srgb,var(--ac) 50%,#000),#050505)}
.sl:after{content:"";position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.88) 0%,rgba(0,0,0,.25) 45%,rgba(0,0,0,.35) 100%);pointer-events:none}
.sl .tx{position:absolute;left:0;right:0;bottom:0;z-index:2;padding:0 20px 34px;animation:up .6s both}
.sl .cat{display:inline-block;background:var(--ac);padding:3px 11px;border-radius:99px;font-size:12px;font-weight:700;margin-bottom:10px}
.sl h3{margin:0;font-size:30px;line-height:1.05}.sl p{margin:8px 0 14px;color:#e4e4ea;font-size:15px;line-height:1.4;max-width:480px}
.sl .row{display:flex;align-items:center;gap:14px}.sl .pr{font-size:28px;color:#fff}
.sl .add2{background:#fff;color:#111;font-weight:800;padding:13px 22px;border-radius:99px;font-size:16px}
.rt{position:absolute;top:0;left:0;right:0;z-index:6;padding:14px 16px;display:flex;align-items:center;gap:10px;background:linear-gradient(rgba(0,0,0,.6),transparent)}
.rt .pg{flex:1;display:flex;gap:4px}.rt .pg span{flex:1;height:3px;border-radius:3px;background:rgba(255,255,255,.28)}.rt .pg span.on{background:#fff}
.rt button{background:rgba(255,255,255,.18);color:#fff;border-radius:99px;padding:7px 13px;font-size:13px;font-weight:600;backdrop-filter:blur(6px)}
.rt button.on{background:var(--ac)}
.bar{position:fixed;left:12px;right:12px;bottom:12px;z-index:60;display:none;align-items:center;justify-content:space-between;background:var(--ac);color:#fff;border-radius:18px;padding:14px 18px;font-weight:800;box-shadow:0 10px 30px rgba(0,0,0,.4)}.bar.on{display:flex}
#sheet{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.6);display:none;align-items:flex-end}#sheet.on{display:flex}
.pn{width:100%;max-height:86dvh;overflow:auto;background:var(--card);color:var(--fg);border-radius:24px 24px 0 0;padding:20px;animation:up .3s both}
.pn h3{margin:0 0 12px}.li{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--bd)}.li span{flex:1}
.q{display:flex;align-items:center;gap:8px}.q button{width:30px;height:30px;border-radius:50%;background:var(--bd);color:var(--fg);font-size:18px}
.pn input,.pn textarea{width:100%;margin-top:10px;padding:12px;border-radius:12px;border:1px solid var(--bd);background:var(--bg);color:var(--fg);font:inherit}
.send{width:100%;margin-top:14px;background:#16a34a;color:#fff;font-weight:800;font-size:17px;padding:15px;border-radius:14px}
.foot{text-align:center;color:var(--mut);font-size:12px;padding:30px 0 10px}.foot a{color:inherit}
.vazio{text-align:center;color:var(--mut);padding:40px 20px}
`;

const JS = String.raw`
(function(){
var D=JSON.parse(document.getElementById('d').textContent),I=D.itens,$=function(i){return document.getElementById(i)};
document.body.className=D.tema==='claro'?'claro':'';document.documentElement.style.setProperty('--ac',D.cor);
var R=function(n){return n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})};
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
var cart={},cats=[];I.forEach(function(i){if(cats.indexOf(i.c)<0)cats.push(i.c)});
/* ---- abertura ---- */
var h=$('hero');
if(D.logo){var lg=el('img','logo');lg.src=D.logo;lg.alt='';h.appendChild(lg)}
if(D.mesa){h.appendChild(el('div','mesa','Mesa '+D.mesa))}
h.appendChild(el('h1','',D.t));if(D.d)h.appendChild(el('p','sub',D.d));
var withMedia=I.some(function(i){return i.m||i.f});
var pb=el('button','play',withMedia?'▶ Assistir o cardápio':'Ver o cardápio');pb.onclick=function(){if(I.length&&withMedia)openReel(0,true);else $('menu').scrollIntoView()};h.appendChild(pb);
var gb=el('button','ghost','Ver lista completa ↓');gb.onclick=function(){$('menu').scrollIntoView()};h.appendChild(gb);
/* ---- lista ---- */
var tabs=$('tabs'),menu=$('menu');
function lista(){menu.innerHTML='';tabs.innerHTML='';
 if(!I.length){menu.appendChild(el('div','vazio','Cardápio em preparação. Volte em instantes!'));return}
 cats.forEach(function(c,ci){var b=el('button',ci?'':'on',c);b.onclick=function(){var s=$('cat'+ci);window.scrollTo({top:s.getBoundingClientRect().top+scrollY-70})};tabs.appendChild(b);
  var s=el('div','sec');s.id='cat'+ci;s.appendChild(el('h2','',c));
  I.forEach(function(i,ix){if(i.c!==c)return;var card=el('div','it'),th=el('div','th','🍽');
   if(i.m&&i.m.t==='mp4'){var v=document.createElement('video');v.muted=true;v.loop=true;v.playsInline=true;v.setAttribute('playsinline','');v.preload='none';v.dataset.src=i.m.src;if(i.t)v.poster=i.t;th.appendChild(v);lazy.observe(v)}
   else if(i.t){var im=document.createElement('img');im.src=i.t;im.alt='';im.loading='lazy';th.appendChild(im)}
   if(i.m)th.appendChild(el('i','','▶ vídeo'));
   var bd=el('div','bd'),nm=el('b','',i.n);if(i.s){nm.appendChild(el('span','star','★ destaque'))}bd.appendChild(nm);if(i.d)bd.appendChild(el('p','',i.d));
   var ft=el('div','ft');ft.appendChild(el('span','pr',i.p>0?R(i.p):''));if(D.wa&&i.p>=0){var a=el('button','add','+');a.setAttribute('aria-label','Adicionar '+i.n);a.onclick=function(e){e.stopPropagation();add(i.id);a.textContent='✓';setTimeout(function(){a.textContent='+'},700)};ft.appendChild(a)}
   bd.appendChild(ft);card.appendChild(th);card.appendChild(bd);card.onclick=function(){openReel(ix,false)};s.appendChild(card)});
  menu.appendChild(s)})}
var lazy=new IntersectionObserver(function(es){es.forEach(function(e){var v=e.target;if(e.isIntersecting){if(!v.src&&v.dataset.src)v.src=v.dataset.src;var p=v.play();if(p&&p.catch)p.catch(function(){})}else v.pause()})},{threshold:.3});
/* ---- vitrine em vídeo ---- */
var rs=$('rs'),pg=$('pg'),cur=-1,auto=false,timer=null,ob=null;
function slide(i,ix){var s=el('section','sl'),m=el('div','md');
 if(i.m){if(i.m.t==='yt')m.className='md yt';s.dataset.k=i.m.t;s.dataset.v=i.m.id||i.m.src||''}
 else if(i.f){var im=document.createElement('img');im.src=i.f;im.alt='';m.appendChild(im)}
 else m=el('div','nomd','🍽');
 if(i.m&&i.t){var p=document.createElement('img');p.src=i.t;p.alt='';m.appendChild(p)}
 s.appendChild(m);var tx=el('div','tx');tx.appendChild(el('span','cat',i.c));tx.appendChild(el('h3','',i.n));if(i.d)tx.appendChild(el('p','',i.d));
 var row=el('div','row');if(i.p>0)row.appendChild(el('span','pr',R(i.p)));
 if(D.wa){var b=el('button','add2','+ Adicionar');b.onclick=function(){add(i.id);b.textContent='✓ Adicionado';setTimeout(function(){b.textContent='+ Adicionar'},900)};row.appendChild(b)}
 tx.appendChild(row);s.appendChild(tx);return s}
function playSlide(s,on){var k=s.dataset.k,md=s.querySelector('.md');if(!k)return;var old=md.querySelector('video,iframe');
 if(!on){if(old){old.remove()}return}
 if(old)return;var v=s.dataset.v,e;
 if(k==='mp4'){e=document.createElement('video');e.src=v;e.muted=true;e.loop=true;e.autoplay=true;e.playsInline=true;e.setAttribute('playsinline','');md.appendChild(e);var p=e.play();if(p&&p.catch)p.catch(function(){})}
 else{e=document.createElement('iframe');e.allow='autoplay; encrypted-media';e.setAttribute('loading','lazy');
  e.src=k==='yt'?'https://www.youtube.com/embed/'+v+'?autoplay=1&mute=1&loop=1&playlist='+v+'&controls=0&playsinline=1&modestbranding=1&rel=0':'https://player.vimeo.com/video/'+v+'?background=1&autoplay=1&loop=1&muted=1';md.appendChild(e)}}
function openReel(ix,a){rs.innerHTML='';pg.innerHTML='';I.forEach(function(i,k){rs.appendChild(slide(i,k));pg.appendChild(document.createElement('span'))});
 $('reel').classList.add('on');document.body.style.overflow='hidden';
 if(ob)ob.disconnect();ob=new IntersectionObserver(function(es){es.forEach(function(e){var k=Array.prototype.indexOf.call(rs.children,e.target);if(e.isIntersecting&&e.intersectionRatio>.6){cur=k;[].forEach.call(pg.children,function(x,j){x.className=j<=k?'on':''});playSlide(e.target,true)}else if(!e.isIntersecting||e.intersectionRatio<.2)playSlide(e.target,false)})},{root:rs,threshold:[0,.2,.6]});
 [].forEach.call(rs.children,function(s){ob.observe(s)});
 rs.scrollTop=ix*innerHeight;setAuto(!!a)}
function closeReel(){setAuto(false);$('reel').classList.remove('on');document.body.style.overflow='';[].forEach.call(rs.children,function(s){playSlide(s,false)});rs.innerHTML=''}
function setAuto(on){auto=on;$('au').className=on?'on':'';$('au').textContent=on?'⏸ Automático':'▶ Automático';clearInterval(timer);if(on)timer=setInterval(function(){var n=cur+1>=I.length?0:cur+1;rs.scrollTo({top:n*innerHeight,behavior:'smooth'})},6500)}
$('au').onclick=function(){setAuto(!auto)};$('cx').onclick=closeReel;
rs.addEventListener('touchstart',function(){if(auto)setAuto(false)},{passive:true});
$('ver').onclick=function(){closeReel();$('menu').scrollIntoView()};
/* ---- pedido ---- */
function add(id){cart[id]=(cart[id]||0)+1;bar()}
function tot(){var n=0,v=0;I.forEach(function(i){var q=cart[i.id]||0;n+=q;v+=q*i.p});return{n:n,v:v}}
function bar(){var t=tot(),b=$('bar');b.className=t.n?'bar on':'bar';b.innerHTML='';b.appendChild(el('span','','🛒 Ver pedido ('+t.n+')'));b.appendChild(el('span','',R(t.v)))}
$('bar').onclick=function(){sheet()};
function sheet(){var t=tot(),s=$('sheet'),p=$('pn');s.className='on';p.innerHTML='';p.appendChild(el('h3','','Seu pedido'));
 I.forEach(function(i){var q=cart[i.id];if(!q)return;var li=el('div','li');li.appendChild(el('span','',i.n+(i.p>0?' · '+R(i.p):'')));var d=el('div','q'),m=el('button','','−'),n=el('b','',q),pl=el('button','','+');
  m.onclick=function(){cart[i.id]--;if(!cart[i.id])delete cart[i.id];bar();tot().n?sheet():(s.className='')};pl.onclick=function(){cart[i.id]++;bar();sheet()};d.appendChild(m);d.appendChild(n);d.appendChild(pl);li.appendChild(d);p.appendChild(li)});
 var tt=el('div','li');tt.appendChild(el('span','','Total'));tt.appendChild(el('b','',R(t.v)));p.appendChild(tt);
 var mesa=document.createElement('input');mesa.placeholder='Número da mesa (opcional)';mesa.value=D.mesa||'';mesa.maxLength=10;mesa.inputMode='numeric';p.appendChild(mesa);
 var ob2=document.createElement('textarea');ob2.rows=2;ob2.placeholder='Observações (sem cebola, ponto da carne…)';ob2.maxLength=200;p.appendChild(ob2);
 var sd=el('button','send','Enviar pedido pelo WhatsApp');sd.onclick=function(){var tt2=tot(),m=mesa.value.replace(/[^\w-]/g,'').slice(0,10),L=['Olá! Pedido pelo cardápio digital'+(m?' — Mesa '+m:'')+':',''];
  I.forEach(function(i){var q=cart[i.id];if(q)L.push(q+'x '+i.n+(i.p>0?' — '+R(i.p*q):''))});L.push('','Total: '+R(tt2.v));if(ob2.value.trim())L.push('Obs: '+ob2.value.trim());
  try{navigator.sendBeacon('/c/'+D.slug+'/evento',new Blob([JSON.stringify({tipo:'pedido',mesa:m,valor:tt2.v})],{type:'application/json'}))}catch(e){}
  window.open('https://wa.me/'+D.wa+'?text='+encodeURIComponent(L.join('\n')),'_blank');cart={};bar();s.className=''};p.appendChild(sd);
 var cc=el('button','ghost','Continuar escolhendo');cc.style.width='100%';cc.onclick=function(){s.className=''};p.appendChild(cc)}
$('sheet').onclick=function(e){if(e.target===this)this.className=''};
var f=$('foot');if(D.ig){var a=el('a','','@'+D.ig);a.href='https://instagram.com/'+D.ig;a.target='_blank';a.rel='noopener';f.appendChild(a);f.appendChild(document.createTextNode(' · '))}
f.appendChild(document.createTextNode('Cardápio digital por '));var nt=el('a','','NexTap');nt.href='https://nextapbrasil.com.br';nt.target='_blank';nt.rel='noopener';f.appendChild(nt);
lista();
})();
`;

function pagina(c, json) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="${esc(c.cor)}"><meta name="robots" content="noindex">
<title>${esc(c.titulo)} — Cardápio</title><meta property="og:title" content="${esc(c.titulo)} — Cardápio digital"><meta property="og:description" content="${esc(c.descricao || 'Veja o cardápio em vídeo')}">${c.logo_url ? `<meta property="og:image" content="${esc(c.logo_url)}">` : ''}
<style>${CSS}</style></head><body>
<header class="hero" id="hero"></header><nav class="tabs" id="tabs"></nav><main id="menu"></main><div class="foot" id="foot"></div>
<div id="reel"><div class="rt"><div class="pg" id="pg"></div><button id="au">▶ Automático</button><button id="ver">Lista</button><button id="cx" aria-label="Fechar">✕</button></div><div id="rs"></div></div>
<div class="bar" id="bar"></div><div id="sheet"><div class="pn" id="pn"></div></div>
<script type="application/json" id="d">${json}</script><script>${JS}</script></body></html>`;
}

module.exports = router;
module.exports._midia = midia;
