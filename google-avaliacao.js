// Converte qualquer link de uma empresa no Google (share.google, Maps, g.page, goo.gl) no link direto de AVALIAÇÃO.
const HOSTS = /(^|\.)(google\.[a-z.]+|goo\.gl|g\.page|share\.google|maps\.app\.goo\.gl)$/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const linkAvaliacao = id => `https://search.google.com/local/writereview?placeid=${id}`;

// Identifica o negócio (para contar 1 vez por negócio): Place ID ou o próprio link.
const chaveDe = l => ((l.match(/placeid=(ChIJ[\w-]+)/i) || [])[1]) || l.toLowerCase().replace(/[?#].*$/, '').replace(/\/$/, '');

function hostOk(u) { try { const x = new URL(u); return x.protocol === 'https:' && HOSTS.test(x.hostname); } catch (e) { return false; } }

// ---- O Google guarda cada empresa como um par "0x…:0x…" (aparece como ftid=, lrd= ou !1s0x… nos links do Maps/Pesquisa).
// O Place ID "ChIJ…" é exatamente esse par codificado (2 números de 64 bits em base64), então dá para converter SEM API paga.
const HEX = /0x([0-9a-f]{8,16}):0x([0-9a-f]{8,16})/gi;
function placeIdDeHex(a, b) {
  const buf = Buffer.alloc(20); buf[0] = 0x0a; buf[1] = 0x12; buf[2] = 0x09;
  buf.writeBigUInt64LE(BigInt('0x' + a), 3); buf[11] = 0x11; buf.writeBigUInt64LE(BigInt('0x' + b), 12);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const paresDe = t => { const out = []; let m; HEX.lastIndex = 0; while ((m = HEX.exec(t))) out.push([m[1].toLowerCase(), m[2].toLowerCase()]); return out; };
// o par que mais aparece é o da empresa principal (empresas "relacionadas" aparecem poucas vezes)
function melhorPar(texto) {
  const cont = new Map(); for (const [a, b] of paresDe(texto)) { const k = a + ':' + b; cont.set(k, (cont.get(k) || 0) + 1); }
  let best = null, n = 0; for (const [k, c] of cont) if (c > n) { best = k; n = c; }
  return best ? best.split(':') : null;
}
const decodificar = u => { try { return decodeURIComponent(u); } catch (_) { return u; } };

// Já é link de avaliação / tem o identificador da empresa na própria URL?
function direto(u) {
  if (/search\.google\.com\/local\/writereview/i.test(u)) return u;
  if (/^https:\/\/g\.page\/r\/[^/]+\/review/i.test(u)) return u;
  const m = u.match(/[?&]placeid=(ChIJ[\w-]{15,})/i) || u.match(/place_id:(ChIJ[\w-]{15,})/i);
  if (m) return linkAvaliacao(m[1]);
  const x = u.match(/!1s0x|ftid=0x|lrd=0x|[?&]fid=0x/i) ? melhorPar(decodificar(u)) : null; // só confia no par quando vem no formato do Maps/Pesquisa
  return x ? linkAvaliacao(placeIdDeHex(x[0], x[1])) : null;
}

function extrair(url, html) {
  const out = { placeId: null, nome: null, lat: null, lng: null };
  const m = (url + ' ' + html).match(/ChIJ[\w-]{20,}/);
  if (m) out.placeId = m[0];
  else { const par = melhorPar(decodificar(url)) || melhorPar(html); if (par) out.placeId = placeIdDeHex(par[0], par[1]); }
  const n = url.match(/\/maps\/place\/([^/@?]+)/);
  if (n) out.nome = decodificar(n[1].replace(/\+/g, ' '));
  else { const q = (url.match(/[?&]q=([^&]+)/) || [])[1]; if (q) out.nome = decodificar(q.replace(/\+/g, ' ')); }
  if (!out.nome) { const t = html.match(/<title>([^<]{2,120})<\/title>/i); if (t) out.nome = t[1].replace(/\s*[-–]\s*(Google( Maps| Search| Pesquisa)?|Pesquisa Google).*$/i, '').trim(); }
  const c = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || html.match(/center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/);
  if (c) { out.lat = +c[1]; out.lng = +c[2]; }
  return out;
}

const cabecalhos = { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9', 'Cookie': 'CONSENT=YES+cb.20240101-00-p0.pt+FX+000; SOCS=CAI' };
async function buscar(url, fetchFn = fetch) {
  let atual = url, html = '';
  for (let i = 0; i < 8; i++) {
    if (!hostOk(atual)) throw new Error('Cole um link do Google (share.google, Google Maps ou g.page).');
    const u = new URL(atual);
    if (/^consent\./i.test(u.hostname) && u.searchParams.get('continue')) { atual = u.searchParams.get('continue'); continue; } // tela de cookies do Google
    const r = await fetchFn(atual, { redirect: 'manual', headers: cabecalhos, signal: AbortSignal.timeout(10000) });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { atual = new URL(loc, atual).toString(); const d = direto(atual); if (d) return { direto: d, final: atual }; continue; }
    html = (await r.text()).slice(0, 900000);
    break;
  }
  return { final: atual, html };
}

const norm = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function parecido(a, b) {
  const x = norm(a), y = norm(b); if (!x || !y) return false; if (x.includes(y) || y.includes(x)) return true;
  const tx = x.split(' ').filter(w => w.length > 2), ty = new Set(y.split(' ')); if (!tx.length) return false;
  return tx.filter(w => ty.has(w)).length / tx.length >= 0.6;
}
// Plano B grátis: procura o nome no Google Maps e confere se o resultado é mesmo a mesma empresa.
async function porBuscaNoMaps(info, fetchFn) {
  if (!info.nome) return null;
  const q = encodeURIComponent(info.nome + (info.lat != null ? '' : ''));
  const url = `https://www.google.com/maps/search/?api=1&query=${q}` + (info.lat != null ? `&center=${info.lat},${info.lng}` : '');
  const r = await buscar(url, fetchFn);
  if (r.direto) { const nomeMaps = decodificar(((r.final || '').match(/\/maps\/place\/([^/@?]+)/) || [])[1] || '').replace(/\+/g, ' '); return parecido(nomeMaps, info.nome) ? { link: r.direto, nomeMaps } : null; }
  const i2 = extrair(r.final, r.html); if (!i2.placeId) return null;
  return parecido(i2.nome, info.nome) ? { link: linkAvaliacao(i2.placeId), nomeMaps: i2.nome } : null;
}

async function placeIdPorNome(info, fetchFn = fetch) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key || !info.nome) return null;
  const body = { textQuery: info.nome, languageCode: 'pt-BR', pageSize: 1 };
  if (info.lat != null) body.locationBias = { circle: { center: { latitude: info.lat, longitude: info.lng }, radius: 300 } };
  const r = await fetchFn('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return (j.places && j.places[0] && j.places[0].id) || null;
}

const MSG_AJUDA = 'Não consegui converter este link. Faça assim (leva 20 segundos): abra a empresa no Google Maps, copie o link da barra de endereço (o longo, que começa com google.com/maps/place/…) e cole aqui. Ou, no Perfil da Empresa, use “Pedir avaliações” (g.page/r/…/review).';
// Devolve { link, origem } ou lança Error com mensagem em português.
async function converter(entrada, fetchFn = fetch) {
  const u = String(entrada || '').trim();
  const solto = u.match(/^(ChIJ[\w-]{20,})$/); if (solto) return { link: linkAvaliacao(solto[1]), origem: 'place_id', chave: solto[1] };
  if (!/^https?:\/\//i.test(u)) throw new Error('Cole o link completo, começando com https://');
  const d = direto(u); if (d) return { link: d, origem: 'ja_era_avaliacao', chave: chaveDe(d) };
  const r = await buscar(u.replace(/^http:/i, 'https:'), fetchFn);
  if (r.direto) return { link: r.direto, origem: 'redirecionamento', chave: chaveDe(r.direto) };
  const d2 = direto(r.final); if (d2) return { link: d2, origem: 'redirecionamento', chave: chaveDe(d2) };
  const info = extrair(r.final, r.html);
  if (info.placeId) return { link: linkAvaliacao(info.placeId), origem: 'pagina', nome: info.nome, chave: info.placeId };
  try { const m = await porBuscaNoMaps(info, fetchFn); if (m) return { link: m.link, origem: 'busca_maps', nome: m.nomeMaps || info.nome, chave: chaveDe(m.link) }; } catch (_) { /* segue para a API opcional */ }
  const id = await placeIdPorNome(info, fetchFn).catch(() => null);
  if (id) return { link: linkAvaliacao(id), origem: 'places_api', nome: info.nome, chave: id };
  throw new Error(MSG_AJUDA);
}

module.exports = { converter, extrair, direto, placeIdDeHex, melhorPar };
