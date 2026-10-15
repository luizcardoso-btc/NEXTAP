// Serviço "Link de avaliação do Google": 10 negócios grátis; depois assinatura mensal paga por Pix (renovação manual).
const db = require('./database.js');

const PLANOS = {
  gratis:    { nome: 'Grátis',    limite: 10,       preco: 0 },
  p50:       { nome: 'Até 50',    limite: 50,       preco: 9.9 },
  ilimitado: { nome: 'Ilimitado', limite: Infinity, preco: 19.9 },
};
const DIAS = 30;

function estado(resellerId) {
  const r = db.prepare('SELECT gl_plano, gl_ate FROM resellers WHERE id = ?').get(resellerId) || {};
  const vigente = !!(r.gl_plano && PLANOS[r.gl_plano] && r.gl_ate && db.prepare("SELECT ? > datetime('now') AS v").get(r.gl_ate).v);
  const plano = vigente ? r.gl_plano : 'gratis';
  const usados = db.prepare('SELECT COUNT(*) AS n FROM gl_links WHERE reseller_id = ?').get(resellerId).n;
  const limite = PLANOS[plano].limite;
  return { plano, nome: PLANOS[plano].nome, ate: vigente ? r.gl_ate : null, usados, limite: limite === Infinity ? null : limite,
           expirado: !vigente && !!r.gl_plano, planos: Object.entries(PLANOS).filter(([k]) => k !== 'gratis').map(([k, p]) => ({ id: k, nome: p.nome, preco: p.preco, limite: p.limite === Infinity ? null : p.limite })) };
}

// Registra o negócio convertido. Converter de novo o mesmo negócio não gasta cota. Lança erro com .status = 402 no limite.
function registrar(resellerId, { chave, link, nome }) {
  const ja = db.prepare('SELECT id FROM gl_links WHERE reseller_id = ? AND place_key = ?').get(resellerId, chave);
  if (!ja) {
    const e = estado(resellerId);
    if (e.limite !== null && e.usados >= e.limite) {
      const err = new Error(e.plano === 'gratis'
        ? `Você usou os ${e.limite} links grátis. Assine por R$ 9,90/mês (até 50) ou R$ 19,90/mês (ilimitado) para gerar mais.`
        : `Você chegou a ${e.limite} links do plano ${e.nome}. Passe para o Ilimitado (R$ 19,90/mês) para gerar mais.`);
      err.status = 402; err.estado = e; throw err;
    }
    db.prepare('INSERT INTO gl_links (reseller_id, place_key, link, nome) VALUES (?, ?, ?, ?)').run(resellerId, chave, link, nome || null);
  }
  return estado(resellerId);
}

const listarLinks = id => db.prepare('SELECT link, nome, created_at FROM gl_links WHERE reseller_id = ? ORDER BY id DESC LIMIT 200').all(id);

async function mp(path, opts = {}, fetchFn = fetch) {
  const r = await fetchFn((process.env.MP_API_BASE || 'https://api.mercadopago.com') + path, { ...opts, headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.message || 'Erro no Mercado Pago'); e.status = r.status; throw e; }
  return j;
}

// Cria um Pix de R$ 9,90 ou R$ 19,90. Reaproveita um Pix pendente do mesmo plano criado há menos de 25 minutos.
async function criarPix(req, resellerId, planoId, fetchFn = fetch) {
  const p = PLANOS[planoId];
  if (!p || !p.preco) throw Object.assign(new Error('Plano inválido.'), { status: 400 });
  if (!process.env.MP_ACCESS_TOKEN) throw Object.assign(new Error('Pagamento indisponível no momento. Fale com o suporte.'), { status: 503 });
  const pend = db.prepare("SELECT * FROM gl_pagamentos WHERE reseller_id = ? AND plano = ? AND status = 'pendente' AND criado_em > datetime('now','-25 minutes') ORDER BY id DESC").get(resellerId, planoId);
  if (pend) return view(pend);
  const r = db.prepare('SELECT name, email FROM resellers WHERE id = ?').get(resellerId);
  const id = db.prepare("INSERT INTO gl_pagamentos (reseller_id, plano, valor) VALUES (?, ?, ?)").run(resellerId, planoId, p.preco).lastInsertRowid;
  try {
    const base = (() => { try { const u = new URL((process.env.PUBLIC_BACKEND_URL || '').trim()); return u.protocol === 'https:' ? u.origin : ''; } catch (e) { return ''; } })();
    const nome = String(r.name || 'Cliente').trim().split(/\s+/);
    const pay = await mp('/v1/payments', { method: 'POST', headers: { 'X-Idempotency-Key': `nextap-gl-${id}` }, body: JSON.stringify({
      transaction_amount: p.preco, description: `NexTap Link de Avaliação — plano ${p.nome} (30 dias)`, payment_method_id: 'pix',
      payer: { email: r.email, first_name: nome[0], last_name: nome.slice(1).join(' ') || nome[0] },
      external_reference: `GL-${id}`, ...(base ? { notification_url: `${base}/api/payments/webhook` } : {}) }) }, fetchFn);
    const t = pay.point_of_interaction && pay.point_of_interaction.transaction_data || {};
    db.prepare('UPDATE gl_pagamentos SET mp_payment_id = ?, pix_qr_code = ?, pix_qr_base64 = ? WHERE id = ?').run(String(pay.id), t.qr_code || '', t.qr_code_base64 || '', id);
  } catch (e) {
    db.prepare('DELETE FROM gl_pagamentos WHERE id = ? AND mp_payment_id IS NULL').run(id);
    console.error('[GL] falha ao criar Pix:', e.message);
    throw Object.assign(new Error('Não consegui gerar o Pix agora. Tente de novo em instantes.'), { status: 502 });
  }
  return view(db.prepare('SELECT * FROM gl_pagamentos WHERE id = ?').get(id));
}

const view = x => ({ id: x.id, plano: x.plano, valor: x.valor, status: x.status, pix_qr_code: x.pix_qr_code, pix_qr_base64: x.pix_qr_base64 });

// Aplica um pagamento do Mercado Pago (webhook ou conferência). Libera 30 dias UMA vez.
function aplicarPagamento(pay) {
  const x = db.prepare('SELECT * FROM gl_pagamentos WHERE mp_payment_id = ?').get(String(pay.id));
  if (!x) return 'sem_pagamento';
  if (x.status === 'pago') return 'ja_pago';
  if (pay.status !== 'approved') { if (['rejected', 'cancelled', 'expired'].includes(pay.status)) db.prepare("UPDATE gl_pagamentos SET status='cancelado' WHERE id=?").run(x.id); return 'pendente'; }
  if (Math.abs(Number(pay.transaction_amount) - x.valor) > 0.009) { console.error(`[GL] valor divergente no pagamento ${pay.id}`); return 'divergente'; }
  db.transaction(() => {
    db.prepare("UPDATE gl_pagamentos SET status='pago', pago_em=datetime('now') WHERE id=? AND status<>'pago'").run(x.id);
    const e = estado(x.reseller_id);
    const base = e.plano === x.plano && e.ate ? e.ate : null; // renovando o mesmo plano soma 30 dias ao que resta
    db.prepare(`UPDATE resellers SET gl_plano=?, gl_ate=datetime(COALESCE(?, 'now'), '+${DIAS} days') WHERE id=?`).run(x.plano, base, x.reseller_id);
  })();
  return 'pago';
}

async function conferir(resellerId, pagId, fetchFn = fetch) {
  const x = db.prepare('SELECT * FROM gl_pagamentos WHERE id = ? AND reseller_id = ?').get(pagId, resellerId);
  if (!x) return null;
  if (x.status === 'pendente' && x.mp_payment_id && process.env.MP_ACCESS_TOKEN) {
    try { aplicarPagamento(await mp('/v1/payments/' + x.mp_payment_id, {}, fetchFn)); } catch (e) { console.error('[GL] conferência falhou:', e.message); }
  }
  const novo = db.prepare('SELECT * FROM gl_pagamentos WHERE id = ?').get(pagId);
  return { ...view(novo), estado: estado(resellerId) };
}

module.exports = { PLANOS, estado, registrar, listarLinks, criarPix, aplicarPagamento, conferir };
