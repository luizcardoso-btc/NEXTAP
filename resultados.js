// Resultados das placas: leituras (cada toque/QR lido) por estabelecimento e a evolução das avaliações no Google,
// para mostrar a prova real de que as empresas estão crescendo.
// As avaliações vêm da API oficial do Google (Places API) quando a chave GOOGLE_PLACES_API_KEY existe, sempre dentro da cota
// grátis do mês (limite no código), ou são registradas à mão no painel.
const express = require('express');
const db = require('./database.js');
const { requireAdmin } = require('./auth-middleware.js');

db.exec(`CREATE TABLE IF NOT EXISTS google_aval (id INTEGER PRIMARY KEY AUTOINCREMENT, place_id TEXT NOT NULL, data TEXT NOT NULL,
  nota REAL, total INTEGER NOT NULL, nome TEXT, origem TEXT NOT NULL DEFAULT 'api', criado_em TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(place_id, data))`);

const lerS = db.prepare('SELECT valor FROM settings WHERE chave = ?');
const gravarS = db.prepare('INSERT INTO settings (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor');
const hojeBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const placeIdDe = url => ((String(url || '').match(/placeid=(ChIJ[\w-]{15,})/i) || String(url || '').match(/place_id:(ChIJ[\w-]{15,})/i) || [])[1]) || null;
const LIMITE_MES = () => Math.max(0, Number(process.env.GOOGLE_PLACES_LIMITE_MES || 900));   // a cota grátis do Google é 1.000 por mês: paramos antes
const usoChave = () => 'gplaces_uso_' + hojeBR().slice(0, 7);
const usoMes = () => Number((lerS.get(usoChave()) || {}).valor || 0);

// ---------- coleta das avaliações (API oficial do Google) ----------
async function buscarGoogle(placeId, fetchFn = fetch) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('sem_chave');
  if (usoMes() >= LIMITE_MES()) throw new Error('cota_mes');
  gravarS.run(usoChave(), String(usoMes() + 1));
  const r = await fetchFn(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=pt-BR`, {
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'rating,userRatingCount,displayName' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('Google respondeu ' + r.status);
  const j = await r.json();
  return { nota: typeof j.rating === 'number' ? j.rating : null, total: Number(j.userRatingCount || 0), nome: (j.displayName && j.displayName.text) || null };
}
function salvar(placeId, x, origem = 'api', data = hojeBR()) {
  db.prepare(`INSERT INTO google_aval (place_id, data, nota, total, nome, origem) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(place_id, data) DO UPDATE SET nota = excluded.nota, total = excluded.total, nome = COALESCE(excluded.nome, google_aval.nome), origem = excluded.origem`)
    .run(placeId, data, x.nota, Math.max(0, Math.round(x.total)), x.nome || null, origem);
}
// Mede quem está sem medição há 7 dias ou mais (primeiro quem nunca foi medido), até `max` por vez.
async function coletar({ max = 25, fetchFn } = {}) {
  if (!process.env.GOOGLE_PLACES_API_KEY) return { medidos: 0, motivo: 'sem_chave' };
  const ids = db.prepare(`SELECT DISTINCT destination_url AS u FROM plates WHERE destination_url LIKE '%placeid=%'`).all().map(r => placeIdDe(r.u)).filter(Boolean);
  const ult = id => (db.prepare('SELECT MAX(data) AS d FROM google_aval WHERE place_id = ?').get(id) || {}).d;
  const corte = new Date(Date.now() - 7 * 864e5 - 3 * 3600e3).toISOString().slice(0, 10);
  const fila = [...new Set(ids)].map(id => ({ id, d: ult(id) })).filter(x => !x.d || x.d <= corte).sort((a, b) => (a.d || '').localeCompare(b.d || '')).slice(0, max);
  let medidos = 0, erro = null;
  for (const x of fila) {
    try { salvar(x.id, await buscarGoogle(x.id, fetchFn)); medidos++; }
    catch (e) { erro = e.message; if (/cota_mes|sem_chave|403|401/.test(e.message)) break; }
  }
  return { medidos, pendentes: fila.length - medidos, erro, uso_mes: usoMes(), limite_mes: LIMITE_MES() };
}

// ---------- relatório ----------
function semanas(n = 8) {   // início (segunda) de cada uma das últimas n semanas, em UTC-3
  const hoje = new Date(Date.now() - 3 * 3600e3); const dow = (hoje.getUTCDay() + 6) % 7;
  const seg = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - dow);
  return Array.from({ length: n }, (_, i) => new Date(seg - (n - 1 - i) * 7 * 864e5).toISOString().slice(0, 10));
}
function relatorio() {
  const sem = semanas(8), ini = sem[0];
  const placas = db.prepare(`SELECT p.id, p.code, p.client_name, p.plate_label, p.destination_type, p.destination_url, p.created_at, r.name AS revendedor,
      (SELECT COUNT(*) FROM plate_reads x WHERE x.plate_id = p.id) AS total,
      (SELECT COUNT(*) FROM plate_reads x WHERE x.plate_id = p.id AND x.read_at >= datetime('now','-30 days')) AS d30,
      (SELECT COUNT(*) FROM plate_reads x WHERE x.plate_id = p.id AND x.read_at >= datetime('now','-7 days')) AS d7,
      (SELECT MIN(read_at) FROM plate_reads x WHERE x.plate_id = p.id) AS primeira
    FROM plates p JOIN resellers r ON r.id = p.reseller_id WHERE p.status = 'ativa' AND p.destination_url IS NOT NULL AND p.destination_url <> ''`).all();
  const porSemana = db.prepare(`SELECT plate_id, CAST((julianday(date(read_at, '-3 hours')) - julianday(?)) / 7 AS INTEGER) AS s, COUNT(*) AS n
    FROM plate_reads WHERE date(read_at, '-3 hours') >= ? GROUP BY plate_id, s`).all(ini, ini);
  const serie = {}; for (const r of porSemana) { if (r.s < 0 || r.s > 7) continue; (serie[r.plate_id] = serie[r.plate_id] || Array(8).fill(0))[r.s] += r.n; }

  // agrupa por estabelecimento: o Place ID do Google junta várias placas da mesma empresa; as demais ficam por placa
  const est = new Map();
  for (const p of placas) {
    const pid = placeIdDe(p.destination_url), k = pid || 'placa:' + p.id;
    const e = est.get(k) || { chave: k, place_id: pid, nome: p.client_name || p.plate_label || 'Sem nome', tipo: pid ? 'Google Avaliações' : (p.destination_type || 'Link'), revendedores: new Set(), placas: [], total: 0, d30: 0, d7: 0, desde: null, serie: Array(8).fill(0) };
    e.placas.push(p.code); e.revendedores.add(p.revendedor); e.total += p.total; e.d30 += p.d30; e.d7 += p.d7;
    const d0 = p.primeira || p.created_at; if (!e.desde || d0 < e.desde) e.desde = d0;
    (serie[p.id] || []).forEach((v, i) => { e.serie[i] += v; });
    est.set(k, e);
  }
  const lista = [...est.values()].map(e => {
    const out = { ...e, revendedores: [...e.revendedores].join(', '), desde: e.desde ? String(e.desde).slice(0, 10) : null };
    if (e.place_id) {
      const snaps = db.prepare('SELECT data, nota, total, nome, origem FROM google_aval WHERE place_id = ? ORDER BY data').all(e.place_id);
      if (snaps.length) {
        const a = snaps[0], b = snaps[snaps.length - 1], dias = Math.max(1, Math.round((Date.parse(b.data) - Date.parse(a.data)) / 864e5));
        out.google = { inicio: a, atual: b, novas: b.total - a.total, nota_dif: a.nota != null && b.nota != null ? Math.round((b.nota - a.nota) * 10) / 10 : null,
          dias: snaps.length > 1 ? dias : 0, por_mes: snaps.length > 1 ? Math.round(((b.total - a.total) / dias) * 30 * 10) / 10 : null,
          pct: a.total ? Math.round(((b.total - a.total) / a.total) * 1000) / 10 : null, medicoes: snaps.length, historico: snaps.slice(-12) };
        if (b.nome && out.nome === 'Sem nome') out.nome = b.nome;
      }
    }
    return out;
  }).sort((a, b) => b.d30 - a.d30 || b.total - a.total);

  const g = lista.filter(x => x.google && x.google.medicoes > 1);
  const resumo = {
    estabelecimentos: lista.length, placas: placas.length,
    leituras_total: lista.reduce((s, x) => s + x.total, 0), leituras_30d: lista.reduce((s, x) => s + x.d30, 0), leituras_7d: lista.reduce((s, x) => s + x.d7, 0),
    google_monitorados: lista.filter(x => x.place_id).length, google_medidos: lista.filter(x => x.google).length,
    avaliacoes_novas: g.reduce((s, x) => s + Math.max(0, x.google.novas), 0), empresas_crescendo: g.filter(x => x.google.novas > 0).length, com_comparacao: g.length,
    serie: sem.map((d, i) => ({ semana: d, leituras: lista.reduce((s, x) => s + x.serie[i], 0) })),
    api: { chave: !!process.env.GOOGLE_PLACES_API_KEY, uso_mes: usoMes(), limite_mes: LIMITE_MES() },
  };
  return { resumo, lista, semanas: sem };
}

// ---------- rotas ----------
const router = express.Router();
router.use('/api/admin/resultados', requireAdmin);
router.get('/api/admin/resultados', (req, res) => res.json(relatorio()));
router.post('/api/admin/resultados/coletar', async (req, res) => {
  try { res.json(await coletar({ max: 40 })); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/api/admin/resultados/manual', (req, res) => {
  const b = req.body || {}, pid = String(b.place_id || '').trim();
  if (!/^ChIJ[\w-]{15,}$/.test(pid)) return res.status(400).json({ error: 'Estabelecimento inválido.' });
  const total = Number(String(b.total).replace(/\D/g, ''));
  if (!Number.isFinite(total) || String(b.total).trim() === '') return res.status(400).json({ error: 'Informe quantas avaliações a empresa tem no Google.' });
  const nota = b.nota === '' || b.nota == null ? null : Number(String(b.nota).replace(',', '.'));
  if (nota !== null && !(nota >= 1 && nota <= 5)) return res.status(400).json({ error: 'A nota vai de 1 a 5 (ex.: 4,7).' });
  const data = /^\d{4}-\d{2}-\d{2}$/.test(b.data || '') ? b.data : hojeBR();
  if (data > hojeBR()) return res.status(400).json({ error: 'A data não pode ser no futuro.' });
  salvar(pid, { nota, total, nome: null }, 'manual', data);
  res.json({ ok: true });
});
router.delete('/api/admin/resultados/medicao', (req, res) => {
  const r = db.prepare('DELETE FROM google_aval WHERE place_id = ? AND data = ?').run(String(req.query.place_id || ''), String(req.query.data || ''));
  res.json({ ok: r.changes > 0 });
});

// coleta automática: 2 minutos depois de ligar e a cada 6 horas (cada empresa no máximo 1 vez por semana)
if (process.env.NODE_ENV !== 'test') {
  const rodar = () => coletar().then(r => { if (r.medidos) console.log(`[RESULTADOS] ${r.medidos} empresa(s) medidas no Google (uso do mês: ${r.uso_mes}/${r.limite_mes})`); }).catch(e => console.error('[RESULTADOS]', e.message));
  setTimeout(rodar, 120e3).unref(); setInterval(rodar, 6 * 3600e3).unref();
}

module.exports = { router, relatorio, coletar, salvar, placeIdDe, buscarGoogle };
