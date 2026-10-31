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
function criarPlaca(order, cor, estoque) {
  const insert = db.prepare(`INSERT INTO plates (reseller_id, order_id, code, color, status, cost) VALUES (?, ?, ?, ?, 'estoque', ?)`);
  const existe = db.prepare('SELECT 1 FROM plates WHERE tracking_code = ? UNION SELECT 1 FROM qr_estoque WHERE numero = ?');
  const novoCodigo = id => { let n = id, c; do { c = '#' + String(n).padStart(5, '0'); n++; } while (existe.get(c, c)); return c; };
  const q = estoque.pegar(cor); // QR já numerado e enviado ao fornecedor; sem estoque, gera na hora (como antes)
  const r = insert.run(order.reseller_id, order.id, q ? q.code : nanoid(10), cor, order.unit_price);
  db.prepare('UPDATE plates SET tracking_code = ? WHERE id = ?').run(q ? q.numero : novoCodigo(Number(r.lastInsertRowid)), r.lastInsertRowid);
  if (q) estoque.vincular(q.id, r.lastInsertRowid);
}
function gerarPlacas(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return;
  const estoque = require('./estoque-qr.js');
  for (let i = 0; i < order.qty_azul; i++) criarPlaca(order, 'azul', estoque);
  for (let i = 0; i < order.qty_preta; i++) criarPlaca(order, 'preta', estoque);
  for (const it of db.itensPedido(order.id)) for (let i = 0; i < it.qty; i++) criarPlaca(order, it.nome, estoque); // demais placas: a "cor" guarda o nome do produto
  try { estoque.verificarReposicao(); } catch (e) { console.error('[QR-ESTOQUE] reposição automática falhou:', e.message); }
}

// Placas de teste (sem pedido): para o fornecedor testar NFC/QR e a configuração no painel.
function criarPlacasTeste(resellerId, quantidade) {
  const n = Math.max(1, Math.min(50, parseInt(quantidade, 10) || 1));
  const insert = db.prepare(`INSERT INTO plates (reseller_id, order_id, code, color, status, cost, plate_label) VALUES (?, NULL, ?, ?, 'estoque', 0, 'Placa de teste')`);
  const existe = db.prepare('SELECT 1 FROM plates WHERE tracking_code = ? UNION SELECT 1 FROM qr_estoque WHERE numero = ?');
  const grava = db.prepare('UPDATE plates SET tracking_code = ? WHERE id = ?');
  const novo = id => { let k = id, c; do { c = '#' + String(k).padStart(5, '0'); k++; } while (existe.get(c, c)); return c; };
  return db.transaction(() => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const cor = i % 2 ? 'preta' : 'azul', code = nanoid(10);
      const r = insert.run(resellerId, code, cor);
      const tc = novo(Number(r.lastInsertRowid)); grava.run(tc, r.lastInsertRowid);
      out.push({ id: Number(r.lastInsertRowid), tracking_code: tc, code, cor });
    }
    return out;
  })();
}

// Marca como pago UMA vez (repetir não duplica placas). Devolve true se mudou algo.
function marcarPago(orderId, opts = {}) {
  const pago = marcarPagoBase(orderId, opts);
  // Compra automática da etiqueta (se ligada). Roda depois, sem travar a confirmação do pagamento.
  if (pago) setImmediate(() => { try { require('./melhor-envio.js').autoComprar(orderId); } catch (e) { console.error('[Melhor Envio] auto:', e.message); } });
  return pago;
}
function marcarPagoBase(orderId, { paymentId = null, manual = false, nota = null } = {}) {
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
// Taxa real cobrada pelo Mercado Pago e valor líquido recebido (vêm no próprio pagamento).
function guardarTaxas(orderId, pay) {
  const taxas = Array.isArray(pay.fee_details) ? pay.fee_details.reduce((s, f) => s + (Number(f.amount) || 0), 0) : null;
  const liquido = pay.transaction_details && Number.isFinite(Number(pay.transaction_details.net_received_amount)) ? Number(pay.transaction_details.net_received_amount) : null;
  if (taxas === null && liquido === null) return false;
  db.prepare('UPDATE orders SET mp_fee = COALESCE(?, mp_fee), mp_net = COALESCE(?, mp_net) WHERE id = ?').run(taxas, liquido, orderId);
  return true;
}

function aplicar(order, pay, origem) {
  db.prepare(`UPDATE orders SET mp_status=?, mp_checked_at=datetime('now') WHERE id=?`).run(pay.status || null, order.id);
  const motivo = divergencia(order, pay);
  if (motivo) {
    registrarEvento({ origem, payment_id: pay.id, order_id: order.id, mp_status: pay.status, resultado: 'divergente', detalhe: motivo });
    return 'divergente';
  }
  if (pay.status === 'approved') {
    const mudou = marcarPago(order.id, { paymentId: pay.id });
    guardarTaxas(order.id, pay);
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
  if (String(pay.external_reference || '').startsWith('GL-')) return require('./google-plano.js').aplicarPagamento(pay); // assinatura do Link de Avaliação
  if (String(pay.external_reference || '').startsWith('BS-')) return require('./biosite.js').aplicarPagamento(pay); // publicação de biosite
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


// ---------- andamento do pedido: produção → envio (Correios) → entrega ----------
const PRAZO_PRODUCAO_DIAS = Math.max(1, Number(process.env.PRAZO_PRODUCAO_DIAS) || 5); // em dias úteis

const hojeBrasil = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bahia' }); // AAAA-MM-DD

// Soma dias úteis (pula sábado e domingo) a partir do dia, no horário de Brasília. Feriados não são considerados.
function adicionarDiasUteis(iso, dias) {
  const base = new Date(String(iso).replace(' ', 'T') + 'Z');
  const [a, m, d] = base.toLocaleDateString('en-CA', { timeZone: 'America/Bahia' }).split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d, 12));
  let somados = 0;
  while (somados < dias) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const w = dt.getUTCDay();
    if (w !== 0 && w !== 6) somados++;
  }
  return dt.toISOString().slice(0, 10);
}

const CODIGO_CORREIOS = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
const CODIGO_OUTRA = /^[A-Z0-9][A-Z0-9-]{4,29}$/; // J&T e outras transportadoras: letras/números, 5 a 30 caracteres
const SERV_CORREIOS = ['PAC', 'SEDEX', 'PAC MINI', 'MINI ENVIOS'];
const ehJT = s => /j\s*&?\s*t|jet/i.test(String(s || ''));
// Correios exige o formato AA123456789BR. Serviço "J&T Express" ou "Outro" (outras transportadoras) aceita o código da transportadora.
function lerRastreio(b) {
  const codigo = String((b || {}).codigo || '').replace(/\s/g, '').toUpperCase();
  const servico = String((b || {}).servico || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const correios = !servico || SERV_CORREIOS.includes(servico.toUpperCase());
  if (correios ? !CODIGO_CORREIOS.test(codigo) : !CODIGO_OUTRA.test(codigo)) {
    return { erro: correios
      ? 'Código de rastreio inválido. Os Correios usam 2 letras + 9 números + 2 letras, por exemplo AA123456789BR. Se o envio foi por outra transportadora (J&T etc.), escolha o serviço "J&T Express" ou "Outro".'
      : 'Código de rastreio inválido. Use só letras e números (de 5 a 30 caracteres).' };
  }
  return { codigo, servico };
}
// Link de acompanhamento: Correios (formato AA123456789BR) ou J&T; outras transportadoras ficam sem link (só o código).
const linkRastreio = (codigo, servico) => {
  if (CODIGO_CORREIOS.test(String(codigo || '')) && (!servico || SERV_CORREIOS.includes(String(servico).toUpperCase()))) return `https://rastreamento.correios.com.br/app/index.php?objetos=${encodeURIComponent(codigo)}`;
  if (ehJT(servico)) return `https://www.jtexpress.com.br/trajectoryQuery?waybillNo=${encodeURIComponent(codigo)}`;
  return CODIGO_CORREIOS.test(String(codigo || '')) ? `https://rastreamento.correios.com.br/app/index.php?objetos=${encodeURIComponent(codigo)}` : null;
};
const nomeTransp = (servico, codigo) => ehJT(servico) ? 'J&T Express' : (CODIGO_CORREIOS.test(String(codigo || '')) ? 'Correios' : (servico || 'transportadora'));

// Versão para o revendedor: sem os dados internos da etiqueta (rastreio só aparece quando o envio é liberado).
const INTERNOS = ['me_id', 'me_servico_id', 'me_etiqueta_url', 'me_status', 'me_rastreio', 'me_liberar', 'me_erro', 'me_tent'];
function decorarPublico(o) { const x = decorar(o); for (const k of INTERNOS) delete x[k]; return x; }

// Acrescenta ao pedido o que a tela precisa: previsão de envio, atraso e o link de rastreio.
function decorar(o) {
  const x = { ...o, prazo_producao_dias: PRAZO_PRODUCAO_DIAS, itens: db.itensPedido(o.id) };
  if (o.status === 'em_producao' && o.producao_at) {
    x.prazo_envio = adicionarDiasUteis(o.producao_at, PRAZO_PRODUCAO_DIAS);
    x.atrasado = hojeBrasil() > x.prazo_envio;
  }
  if (o.tracking_code) { x.rastreio_url = linkRastreio(o.tracking_code, o.shipping_service); x.transportadora = nomeTransp(o.shipping_service, o.tracking_code); }
  return x;
}

// Busca no Mercado Pago a taxa real dos pedidos já pagos que ainda não têm (até 80 por vez).
async function atualizarTaxas(limite = 80) {
  const lista = db.prepare(`SELECT id, mp_payment_id FROM orders WHERE status IN ('pago','em_producao','enviado','entregue')
    AND mp_payment_id IS NOT NULL AND mp_fee IS NULL ORDER BY id DESC LIMIT ?`).all(limite);
  const r = { verificados: 0, atualizados: 0, erros: 0, restantes: 0 };
  for (const o of lista) {
    r.verificados++;
    try { if (guardarTaxas(o.id, await buscarPagamento(o.mp_payment_id))) r.atualizados++; } catch (e) { r.erros++; }
  }
  r.restantes = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status IN ('pago','em_producao','enviado','entregue') AND mp_payment_id IS NOT NULL AND mp_fee IS NULL`).get().n;
  return r;
}

// Corrige a quantidade de placas de uma cor num pedido já pago (edição pelo admin).
// Aumentar: cria as placas que faltam. Diminuir: só remove placas ainda sem uso (em estoque, sem cliente, sem venda, sem leitura) e devolve o QR ao estoque.
function ajustarPlacas(orderId, cor, alvo) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const atuais = db.prepare('SELECT * FROM plates WHERE order_id = ? AND color = ? ORDER BY id').all(orderId, cor);
  if (alvo === atuais.length) return { criadas: 0, removidas: 0 };
  if (alvo > atuais.length) {
    const estoque = require('./estoque-qr.js');
    for (let i = atuais.length; i < alvo; i++) criarPlaca(order, cor, estoque);
    try { estoque.verificarReposicao(); } catch (e) { /* reposição automática é opcional */ }
    return { criadas: alvo - atuais.length, removidas: 0 };
  }
  const livres = atuais.filter(pl => pl.status === 'estoque' && !pl.client_name && !pl.destination_url
    && !db.prepare('SELECT 1 FROM sales WHERE plate_id = ?').get(pl.id) && !db.prepare('SELECT 1 FROM plate_reads WHERE plate_id = ?').get(pl.id));
  const tirar = atuais.length - alvo;
  if (livres.length < tirar) throw Object.assign(new Error(`Só dá para remover ${livres.length} placa(s) ${cor}: as outras já foram configuradas ou vendidas pelo revendedor.`), { status: 400 });
  const alvoIds = livres.slice(-tirar).map(pl => pl.id);
  db.transaction(() => alvoIds.forEach(id => {
    db.prepare("UPDATE qr_estoque SET status='livre', plate_id=NULL, usado_em=NULL WHERE plate_id = ?").run(id);
    db.prepare('DELETE FROM plates WHERE id = ?').run(id);
  }))();
  return { criadas: 0, removidas: tirar };
}

// Exclui um pedido (inclusive pago) pelo admin. Placas sem uso voltam ao estoque de QR; se alguma já foi configurada/vendida, só com forcar=true.
function excluirPedido(orderId, { forcar = false } = {}) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) throw Object.assign(new Error('Pedido não encontrado.'), { status: 404 });
  const placas = db.prepare('SELECT * FROM plates WHERE order_id = ?').all(orderId);
  const emUso = pl => !(pl.status === 'estoque' && !pl.client_name && !pl.destination_url)
    || db.prepare('SELECT 1 FROM sales WHERE plate_id = ?').get(pl.id) || db.prepare('SELECT 1 FROM plate_reads WHERE plate_id = ?').get(pl.id);
  const usadas = placas.filter(emUso);
  if (usadas.length && !forcar) throw Object.assign(new Error(`${usadas.length} das placas deste pedido já foram configuradas, vendidas ou lidas pelo revendedor.`), { status: 409, placas_em_uso: usadas.length });
  const arquivos = db.prepare('SELECT arquivo FROM declaracoes WHERE order_id = ?').all(orderId);
  db.transaction(() => {
    const usadasIds = new Set(usadas.map(x => x.id));
    for (const pl of placas) {
      if (!usadasIds.has(pl.id)) db.prepare("UPDATE qr_estoque SET status='livre', plate_id=NULL, usado_em=NULL WHERE plate_id = ?").run(pl.id); // QR sem uso volta ao estoque
      else db.prepare('UPDATE qr_estoque SET plate_id=NULL WHERE plate_id = ?').run(pl.id);                                                    // QR já em uso não é reaproveitado
      db.prepare('DELETE FROM plate_reads WHERE plate_id = ?').run(pl.id);
      db.prepare('UPDATE sales SET plate_id = NULL WHERE plate_id = ?').run(pl.id);
      db.prepare('DELETE FROM plates WHERE id = ?').run(pl.id);
    }
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
    db.prepare('DELETE FROM declaracoes WHERE order_id = ?').run(orderId);
    db.prepare('DELETE FROM nfe_pedido WHERE order_id = ?').run(orderId);
    db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
    registrarEvento({ origem: 'admin', order_id: orderId, resultado: 'pedido_excluido', detalhe: JSON.stringify({ status: o.status, reseller_id: o.reseller_id, azul: o.qty_azul, preta: o.qty_preta, outras: o.qty_outras, total: o.total, frete: o.shipping_fee, mp_payment_id: o.mp_payment_id, placas: placas.length, placas_em_uso: usadas.length }).slice(0, 480) });
  })();
  for (const a of arquivos) { try { const fs = require('fs'), path = require('path'); fs.unlinkSync(path.join(path.dirname(db.meta.arquivo), 'declaracoes', path.basename(String(a.arquivo)))); } catch (e) { /* já não existe */ } }
  return { placas: placas.length, placas_em_uso: usadas.length, mp_payment_id: o.mp_payment_id || null, status: o.status };
}

module.exports = { excluirPedido, ajustarPlacas, atualizarTaxas, decorar, decorarPublico, adicionarDiasUteis, lerRastreio, linkRastreio, PRAZO_PRODUCAO_DIAS, pagamentosSemPedido, marcarPago, gerarPlacas, criarPlacasTeste, registrarEvento, processarNotificacao, conferirPedido, conferirPendentes, cancelarPendente, agendar };
