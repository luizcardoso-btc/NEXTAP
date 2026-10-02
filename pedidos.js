// Regras de pagamento dos pedidos, compartilhadas entre o webhook, a conferência automática e o painel admin.
const { nanoid } = require('nanoid');
const db = require('./database.js');

// ---------- Mercado Pago (chamadas diretas à API) ----------
async function mpGet(url) {
  const r = await fetch('https://api.mercadopago.com' + url, { headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` } });
  if (!r.ok) { const e = new Error(`Mercado Pago respondeu ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}
const buscarPagamento = id => mpGet(`/v1/payments/${encodeURIComponent(id)}`);
const buscarPorReferencia = async ref =>
  (await mpGet(`/v1/payments/search?external_reference=${encodeURIComponent(ref)}&sort=date_created&criteria=desc&limit=20`)).results || [];

// ---------- registro do que aconteceu (aparece em Admin → Dados e backups) ----------
function registrarEvento(e) {
  try {
    db.prepare(`INSERT INTO payment_events (origem, payment_id, order_id, mp_status, resultado, detalhe) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(e.origem || '', e.payment_id != null ? String(e.payment_id) : null, e.order_id ?? null, e.mp_status || null, e.resultado || '', e.detalhe || null);
    db.prepare(`DELETE FROM payment_events WHERE id NOT IN (SELECT id FROM payment_events ORDER BY id DESC LIMIT 500)`).run();
  } catch (err) { console.error('[PAGAMENTO] não consegui registrar o evento:', err.message); }
}

// ---------- placas do pedido (código de rastreio #00001, #00002…) ----------
function gerarPlacas(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return;
  const insert = db.prepare(`INSERT INTO plates (reseller_id, order_id, code, color, status, cost) VALUES (?, ?, ?, ?, 'estoque', ?)`);
  const existe = db.prepare('SELECT 1 FROM plates WHERE tracking_code = ?');
  const gravaCodigo = db.prepare('UPDATE plates SET tracking_code = ? WHERE id = ?');
  const novoCodigo = id => { let n = id, c; do { c = '#' + String(n).padStart(5, '0'); n++; } while (existe.get(c)); return c; };
  const criar = cor => {
    const r = insert.run(order.reseller_id, order.id, nanoid(10), cor, order.unit_price);
    gravaCodigo.run(novoCodigo(Number(r.lastInsertRowid)), r.lastInsertRowid);
  };
  for (let i = 0; i < order.qty_azul; i++) criar('azul');
  for (let i = 0; i < order.qty_preta; i++) criar('preta');
}

// Marca como pago UMA vez (repetir não duplica placas). Devolve true se mudou algo.
function marcarPago(orderId, { paymentId = null, manual = false, nota = null } = {}) {
  return db.transaction(() => {
    const r = db.prepare(
      `UPDATE orders SET status='pago', paid_at=datetime('now'), mp_payment_id=COALESCE(?, mp_payment_id),
         paid_manually=?, payment_note=COALESCE(?, payment_note)
       WHERE id=? AND status IN ('aguardando_pagamento','cancelado')`
    ).run(paymentId != null ? String(paymentId) : null, manual ? 1 : 0, nota, orderId);
    if (r.changes) gerarPlacas(orderId);
    return r.changes > 0;
  })();
}

// ---------- o pagamento do Mercado Pago combina com ESTE pedido? ----------
// (Cadastros antigos podem ter reaproveitado o mesmo número de pedido, então confere valor, data e id do Pix.)
function divergencia(order, pay) {
  if (Math.abs(Number(pay.transaction_amount) - Number(order.total)) > 0.01) return 'valor_diferente';
  if (order.payment_method === 'pix' && order.mp_payment_id && String(pay.id) !== String(order.mp_payment_id)) return 'outro_pagamento';
  const criado = new Date(String(order.created_at).replace(' ', 'T') + 'Z').getTime();
  const feito = new Date(pay.date_created).getTime();
  if (Number.isFinite(criado) && Number.isFinite(feito) && feito < criado - 10 * 60 * 1000) return 'pagamento_anterior_ao_pedido';
  return null;
}

// Aplica UM pagamento ao pedido. Devolve: pago | ja_pago | pendente | recusado | divergente
function aplicar(order, pay, origem) {
  db.prepare(`UPDATE orders SET mp_status=?, mp_checked_at=datetime('now') WHERE id=?`).run(pay.status || null, order.id);
  const motivo = divergencia(order, pay);
  if (motivo) {
    registrarEvento({ origem, payment_id: pay.id, order_id: order.id, mp_status: pay.status, resultado: 'divergente', detalhe: motivo });
    return 'divergente';
  }
  if (pay.status === 'approved') {
    const mudou = marcarPago(order.id, { paymentId: pay.id });
    registrarEvento({ origem, payment_id: pay.id, order_id: order.id, mp_status: pay.status, resultado: mudou ? 'pedido_pago' : 'ja_estava_pago' });
    return mudou ? 'pago' : 'ja_pago';
  }
  if (['rejected', 'cancelled'].includes(pay.status)) return 'recusado';
  return 'pendente'; // pending, in_process, authorized…
}

function cancelarPendente(orderId, origem, detalhe) {
  const r = db.prepare(`UPDATE orders SET status='cancelado' WHERE id=? AND status='aguardando_pagamento'`).run(orderId);
  if (r.changes) registrarEvento({ origem, order_id: orderId, resultado: 'pedido_cancelado', detalhe });
  return r.changes > 0;
}

// ---------- notificação do Mercado Pago (webhook) ----------
async function processarNotificacao(paymentId) {
  const pay = await buscarPagamento(paymentId);
  const orderId = Number(pay.external_reference);
  const order = orderId ? db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) : null;
  if (!order) {
    registrarEvento({ origem: 'webhook', payment_id: paymentId, mp_status: pay.status, resultado: 'sem_pedido', detalhe: `referência ${pay.external_reference}` });
    return 'sem_pedido';
  }
  const r = aplicar(order, pay, 'webhook');
  if (r === 'recusado') cancelarPendente(order.id, 'webhook', `pagamento ${pay.status}`);
  else if (r === 'pendente') registrarEvento({ origem: 'webhook', payment_id: pay.id, order_id: order.id, mp_status: pay.status, resultado: 'aguardando' });
  return r;
}

// ---------- conferência direta no Mercado Pago (não depende do webhook) ----------
async function conferirPedido(orderId, origem = 'conferencia') {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { resultado: 'nao_encontrado' };
  if (!['aguardando_pagamento', 'cancelado'].includes(order.status)) return { resultado: 'ja_pago', status: order.status };
  if (!process.env.MP_ACCESS_TOKEN) return { resultado: 'sem_token' };
  const pagamentos = (order.payment_method === 'pix' && order.mp_payment_id)
    ? [await buscarPagamento(order.mp_payment_id)]
    : await buscarPorReferencia(order.id);
  db.prepare(`UPDATE orders SET mp_checked_at=datetime('now') WHERE id=?`).run(order.id);
  if (!pagamentos.length) return { resultado: 'sem_pagamento' };
  const r = pagamentos.map(p => aplicar(order, p, origem));
  const mpStatus = (pagamentos.find(p => p.status === 'approved') || pagamentos[0]).status;
  if (r.includes('pago') || r.includes('ja_pago')) return { resultado: 'pago', mp_status: mpStatus };
  if (r.includes('pendente')) return { resultado: 'pendente', mp_status: mpStatus };
  if (r.includes('recusado')) { cancelarPendente(order.id, origem, `pagamento ${mpStatus}`); return { resultado: 'cancelado', mp_status: mpStatus }; }
  return { resultado: 'divergente', mp_status: mpStatus };
}

async function conferirPendentes(limite = 40, origem = 'conferencia') {
  const lista = db.prepare(`
    SELECT id FROM orders WHERE status='aguardando_pagamento' AND created_at >= datetime('now','-14 days')
    ORDER BY COALESCE(mp_checked_at,'') ASC, id ASC LIMIT ?`).all(limite);
  const resumo = { verificados: 0, pagos: 0, cancelados: 0, pendentes: 0, divergentes: 0, erros: 0 };
  for (const { id } of lista) {
    try {
      const r = await conferirPedido(id, origem);
      resumo.verificados++;
      if (r.resultado === 'pago') resumo.pagos++;
      else if (r.resultado === 'cancelado') resumo.cancelados++;
      else if (r.resultado === 'divergente') resumo.divergentes++;
      else resumo.pendentes++;
    } catch (e) { resumo.erros++; console.error(`[PAGAMENTO] conferência do pedido ${id} falhou:`, e.message); }
  }
  return resumo;
}

// Roda sozinho de tempos em tempos: mesmo que o webhook falhe, o pedido pago é reconhecido em poucos minutos.
function agendar() {
  if (!process.env.MP_ACCESS_TOKEN) return;
  const rodar = () => conferirPendentes(40, 'automatico').then(r => { if (r.pagos || r.cancelados) console.log('[PAGAMENTO] conferência automática:', JSON.stringify(r)); }).catch(e => console.error('[PAGAMENTO] conferência automática falhou:', e.message));
  setTimeout(rodar, 20 * 1000).unref();
  setInterval(rodar, 3 * 60 * 1000).unref();
}

// Pagamentos aprovados do NexTap no Mercado Pago (últimos 90 dias) que NÃO estão ligados a nenhum pedido deste sistema.
// Acontece, por exemplo, com vendas feitas antes de o banco ficar protegido por Volume.
async function pagamentosSemPedido(dias = 90) {
  if (!process.env.MP_ACCESS_TOKEN) return { sem_token: true, itens: [] };
  const conhecidos = new Set(db.prepare("SELECT mp_payment_id AS id FROM orders WHERE mp_payment_id IS NOT NULL").all().map(r => String(r.id)));
  const itens = [];
  for (let off = 0; off < 400; off += 100) {
    const r = await mpGet(`/v1/payments/search?status=approved&sort=date_created&criteria=desc&range=date_created&begin_date=NOW-${dias}DAYS&end_date=NOW&limit=100&offset=${off}`);
    for (const x of r.results || []) {
      if (!/nextap/i.test(x.description || '') || conhecidos.has(String(x.id))) continue;
      itens.push({ id: x.id, valor: x.transaction_amount, data: x.date_created, descricao: x.description,
        email: x.payer?.email || null, nome: [x.payer?.first_name, x.payer?.last_name].filter(Boolean).join(' ') || null,
        pedido_ref: x.external_reference || null });
    }
    if (!r.results || r.results.length < 100) break;
  }
  return { itens };
}

module.exports = { pagamentosSemPedido, marcarPago, gerarPlacas, registrarEvento, processarNotificacao, conferirPedido, conferirPendentes, cancelarPendente, agendar };
