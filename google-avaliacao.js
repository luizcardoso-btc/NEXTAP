// Converte qualquer link de uma empresa no Google (share.google, Maps, g.page, goo.gl) no link direto de AVALIAÇÃO.
const HOSTS = /(^|\.)(google\.[a-z.]+|goo\.gl|g\.page|share\.google|maps\.app\.goo\.gl)$/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const linkAvaliacao = id => `https://search.google.com/local/writereview?placeid=${id}`;

function hostOk(u) { try { const x = new URL(u); return x.protocol === 'https:' && HOSTS.test(x.hostname); } catch (e) { return false; } }

// Já é link de avaliação / tem o Place ID na própria URL?
function direto(u) {
  if (/search\.google\.com\/local\/writereview/i.test(u)) return u;
  if (/^https:\/\/g\.page\/r\/[^/]+\/review/i.test(u)) return u;
  const m = u.match(/[?&]placeid=(ChIJ[\w-]{15,})/i) || u.match(/place_id:(ChIJ[\w-]{15,})/i);
  return m ? linkAvaliacao(m[1]) : null;
}

function extrair(url, html) {
  const out = { placeId: null, nome: null, lat: null, lng: null };
  const m = (url + ' ' + html).match(/ChIJ[\w-]{20,}/);
  if (m) out.placeId = m[0];
  const n = url.match(/\/maps\/place\/([^/@?]+)/);
  if (n) out.nome = decodeURIComponent(n[1].replace(/\+/g, ' '));
  else { const t = html.match(/<title>([^<]{2,120})<\/title>/i); if (t) out.nome = t[1].replace(/\s*[-–]\s*(Google( Maps| Search| Pesquisa)?|Pesquisa Google).*$/i, '').trim(); }
  const c = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || html.match(/center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/);
  if (c) { out.lat = +c[1]; out.lng = +c[2]; }
  return out;
}

async function buscar(url, fetchFn = fetch) {
  let atual = url, html = '';
  for (let i = 0; i < 6; i++) {
    if (!hostOk(atual)) throw new Error('Cole um link do Google (share.google, Google Maps ou g.page).');
    const r = await fetchFn(atual, { redirect: 'manual', headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' }, signal: AbortSignal.timeout(8000) });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { atual = new URL(loc, atual).toString(); const d = direto(atual); if (d) return { direto: d }; continue; }
    html = (await r.text()).slice(0, 600000);
    break;
  }
  return { final: atual, html };
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

// Devolve { link, origem } ou lança Error com mensagem em português.
async function converter(entrada, fetchFn = fetch) {
  const u = String(entrada || '').trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('Cole o link completo, começando com https://');
  const d = direto(u); if (d) return { link: d, origem: 'ja_era_avaliacao' };
  const r = await buscar(u.replace(/^http:/i, 'https:'), fetchFn);
  if (r.direto) return { link: r.direto, origem: 'redirecionamento' };
  const d2 = direto(r.final); if (d2) return { link: d2, origem: 'redirecionamento' };
  const info = extrair(r.final, r.html);
  if (info.placeId) return { link: linkAvaliacao(info.placeId), origem: 'pagina', nome: info.nome };
  const id = await placeIdPorNome(info, fetchFn);
  if (id) return { link: linkAvaliacao(id), origem: 'places_api', nome: info.nome };
  throw new Error(process.env.GOOGLE_PLACES_API_KEY
    ? 'Não consegui identificar essa empresa. Use o link "Pedir avaliações" do Perfil da Empresa (g.page/r/…/review).'
    : 'Não consegui converter automaticamente. Use o link "Pedir avaliações" do Perfil da Empresa (g.page/r/…/review) ou peça ao suporte para ativar a conversão automática.');
}

module.exports = { converter, extrair, direto };
