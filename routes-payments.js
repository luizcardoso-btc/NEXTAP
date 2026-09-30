const express = require('express');
const { nanoid } = require('nanoid');
const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');
const db = require('./database.js');
const { requireReseller } = require('./auth-middleware.js');

const router = express.Router();

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// Endereço público do backend (usado no webhook e no retorno do cartão).
// Usa PUBLIC_BACKEND_URL se for https; senão, deduz do próprio pedido (Railway já entrega https).
function baseUrl(req) {
  const b = (process.env.PUBLIC_BACKEND_URL || '').trim().replace(/\/+$/, '');
  if (/^https:\/\//i.test(b)) return b;
  return `${req.protocol}://${req.get('host')}`;
}

// Transforma o erro do SDK do Mercado Pago em texto para o log (sem vazar o token).
function descreverErroMP(err) {
  const causa = Array.isArray(err?.cause) ? err.cause : (err?.cause ? [err.cause] : []);
  return JSON.stringify({
    status: err?.status,
    error: err?.error,
    message: err?.message,
    cause: causa.map(c => ({ code: c?.code, description: c?.description })),
  });
}

// Traduz os erros mais comuns em (a) o que mostrar ao cliente e (b) o que fazer, para o log.
function interpretarErroMP(err) {
  const texto = descreverErroMP(err).toLowerCase();
  const status = Number(err?.status);
  if (texto.includes('invalid users involved') || texto.includes('2034') || texto.includes('same user')) {
    return { cliente: 'Use um e-mail diferente do e-mail da conta do Mercado Pago que recebe os pagamentos.',
             dica: 'O e-mail do pagador é igual ao da conta que recebe (ou mistura conta de teste com real).' };
  }
  if (texto.includes('key enabled') || texto.includes('13253') || texto.includes('without key')) {
    return { cliente: 'Pix indisponível no momento. Tente pagar com cartão ou fale com o suporte.',
             dica: 'A conta do Mercado Pago não tem chave Pix cadastrada. Cadastre uma chave Pix na conta que gera o token.' };
  }
  if (status === 401 || status === 403 || texto.includes('invalid_token') || texto.includes('unauthorized') || texto.includes('invalid access token')) {
    return { cliente: 'Pagamentos indisponíveis no momento. Fale com o suporte.',
             dica: 'MP_ACCESS_TOKEN inválido ou sem permissão. Use o Access Token de PRODUÇÃO (começa com APP_USR-).' };
  }
  if (texto.includes('identification') || texto.includes('cpf')) {
    return { cliente: 'Informe um CPF válido para gerar o Pix.', dica: 'Mercado Pago recusou o CPF/identificação do pagador.' };
  }
  if (texto.includes('notification_url')) {
    return { cliente: 'Não foi possível iniciar o pagamento. Tente novamente em instantes.',
             dica: 'notification_url inválida. Confira PUBLIC_BACKEND_URL (https://... sem barra no final).' };
  }
  return { cliente: 'Não foi possível iniciar o pagamento. Tente novamente em instantes.', dica: null };
}

// E-mail da conta que recebe (descoberto no boot). O Mercado Pago recusa pagador = recebedor.
let collectorEmail = null;

// Roda no boot: confere se o token do Mercado Pago funciona e deixa o resultado nos logs do Railway.
async function diagnose() {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return;
  const tipo = token.startsWith('TEST-') ? 'TESTE' : token.startsWith('APP_USR-') ? 'PRODUÇÃO' : 'DESCONHECIDO';
  console.log(`[MP] Tipo de token: ${tipo}`);
  if (tipo === 'TESTE') console.warn('[MP] AVISO: token de TESTE. Para receber pagamentos reais use o Access Token de produção (APP_USR-...).');
  const pub = (process.env.PUBLIC_BACKEND_URL || '').trim();
  if (!/^https:\/\/[^/]+$/i.test(pub.replace(/\/+$/, ''))) {
    console.warn(`[MP] AVISO: PUBLIC_BACKEND_URL ausente ou fora do padrão ("${pub}"). Vou deduzir o endereço pela requisição.`);
  }
  try {
    const r = await fetch('https://api.mercadopago.com/users/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      console.error(`[MP] TOKEN RECUSADO pelo Mercado Pago (HTTP ${r.status}). Gere/cole novamente o Access Token de produção.`);
      return;
    }
    const u = await r.json();
    collectorEmail = (u.email || '').toLowerCase() || null;
    console.log(`[MP] Token OK — conta ${u.nickname || u.id} (${u.email || 'sem e-mail'}), país ${u.site_id}. Não use esse e-mail como pagador nos testes.`);
  } catch (e) {
    console.warn('[MP] Não consegui validar o token agora:', e.message);
  }
}

function unitPrice(qty) {
  const tiers = db.prepare('SELECT * FROM price_tiers ORDER BY min_qty').all();
  const t = tiers.find(t => qty >= t.min_qty && qty <= t.max_qty);
  if (t) return t.unit_price;
  return tiers.length ? tiers[0].unit_price : 25; // fallback se a tabela de preços estiver vazia
}

// Cria o pedido + inicia o pagamento.
// method: "pix" ou "credit_card"
// Para "pix" respondemos já com o QR Code (copia e cola + imagem).
// Para "credit_card" respondemos com o link de Checkout Pro do Mercado Pago.
router.post('/checkout', requireReseller, async (req, res) => {
  if (!process.env.MP_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'Pagamentos indisponíveis no momento.' });
  }
  const body = req.body || {};
  const method = body.method;
  const payer = body.payer;
  const qty_azul = Number(body.qty_azul ?? 0);
  const qty_preta = Number(body.qty_preta ?? 0);
  if (!Number.isInteger(qty_azul) || !Number.isInteger(qty_preta) || qty_azul < 0 || qty_preta < 0) {
    return res.status(400).json({ error: 'Quantidades inválidas.' });
  }
  const qty = qty_azul + qty_preta;
  if (qty < 1) return res.status(400).json({ error: 'Escolha ao menos 1 placa.' });
  if (qty > 100000) return res.status(400).json({ error: 'Quantidade acima do permitido.' });
  if (!['pix', 'credit_card'].includes(method)) return res.status(400).json({ error: 'Forma de pagamento inválida.' });
  if (!payer || !payer.email || !payer.first_name) {
    return res.status(400).json({ error: 'Informe nome e e-mail para o pagamento.' });
  }

  if (collectorEmail && String(payer.email).toLowerCase().trim() === collectorEmail) {
    return res.status(400).json({ error: 'Use um e-mail diferente do e-mail da conta do Mercado Pago que recebe os pagamentos.' });
  }
  const cpf = String(payer.cpf || '').replace(/\D/g, '');
  if (cpf && cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Informe os 11 números ou deixe em branco.' });

  const price = unitPrice(qty);
  const total = Math.round(price * qty * 100) / 100;
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(req.resellerId);

  const orderInfo = db.prepare(
    `INSERT INTO orders (reseller_id, qty_azul, qty_preta, unit_price, total, status, payment_method)
     VALUES (?, ?, ?, ?, ?, 'aguardando_pagamento', ?)`
  ).run(req.resellerId, qty_azul, qty_preta, price, total, method);
  const orderId = orderInfo.lastInsertRowid;

  const base = baseUrl(req);
  try {
    if (method === 'pix') {
      const payment = new Payment(client);
      const result = await payment.create({
        body: {
          transaction_amount: total,
          description: `NexTap — ${qty} placa(s) para ${reseller.name}`,
          payment_method_id: 'pix',
          payer: {
            email: String(payer.email).trim(),
            first_name: payer.first_name,
            last_name: payer.last_name || payer.first_name,
            ...(cpf ? { identification: { type: 'CPF', number: cpf } } : {}),
          },
          ...(base.startsWith('https://') ? { notification_url: `${base}/api/payments/webhook` } : {}),
          external_reference: String(orderId),
        },
        requestOptions: { idempotencyKey: `nextap-pix-${orderId}` },
      });

      const txData = result.point_of_interaction?.transaction_data;
      db.prepare(`UPDATE orders SET mp_payment_id=?, pix_qr_code=?, pix_qr_base64=? WHERE id=?`)
        .run(String(result.id), txData?.qr_code || '', txData?.qr_code_base64 || '', orderId);

      return res.json({
        order_id: orderId,
        payment_id: result.id,
        status: result.status, // "pending" até o pagamento cair
        pix_qr_code: txData?.qr_code || null,
        pix_qr_base64: txData?.qr_code_base64 || null,
        ticket_url: txData?.ticket_url || null,
        total,
      });
    }

    // credit_card via Checkout Pro: devolvemos um link para o revendedor pagar
    const preference = new Preference(client);
    const result = await preference.create({
      body: {
        items: [{
          title: `NexTap — ${qty} placa(s) NFC`,
          quantity: 1,
          unit_price: total,
          currency_id: 'BRL',
        }],
        payer: { email: String(payer.email).trim(), name: payer.first_name },
        external_reference: String(orderId),
        ...(base.startsWith('https://') ? { notification_url: `${base}/api/payments/webhook` } : {}),
        back_urls: {
          success: `${base}/revendedor/?pedido=${orderId}&status=aprovado`,
          pending: `${base}/revendedor/?pedido=${orderId}&status=pendente`,
          failure: `${base}/revendedor/?pedido=${orderId}&status=falhou`,
        },
        ...(base.startsWith('https://') ? { auto_return: 'approved' } : {}),
      },
    });

    db.prepare('UPDATE orders SET mp_preference_id=? WHERE id=?').run(result.id, orderId);
    return res.json({ order_id: orderId, checkout_url: result.init_point, total });

  } catch (err) {
    const { cliente, dica } = interpretarErroMP(err);
    console.error(`[MP] Falha ao criar pagamento (${method}, pedido ${orderId}): ${descreverErroMP(err)}`);
    if (dica) console.error(`[MP] O QUE FAZER: ${dica}`);
    // Nenhum pagamento foi criado, então descarta a tentativa (não fica pedido "cancelado" sujando a lista).
    db.prepare('DELETE FROM orders WHERE id=? AND mp_payment_id IS NULL').run(orderId);
    return res.status(502).json({ error: cliente });
  }
});

// O revendedor consulta o status do pedido (usado para o painel atualizar sozinho enquanto aguarda o Pix)
router.get('/orders/:id/status', requireReseller, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND reseller_id = ?').get(req.params.id, req.resellerId);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  res.json(order);
});

// Webhook do Mercado Pago: ele chama esta URL quando o status de um pagamento muda.
// Precisa estar public (PUBLIC_BACKEND_URL) e cadastrada no seu app do Mercado Pago.
router.post('/webhook', express.json(), async (req, res) => {
  try {
    const topic = req.query.type || req.body?.type;
    const paymentId = req.query['data.id'] || req.body?.data?.id;
    if (topic !== 'payment' || !paymentId) return res.sendStatus(200);

    const payment = new Payment(client);
    const info = await payment.get({ id: paymentId });
    const orderId = Number(info.external_reference);
    if (!orderId) return res.sendStatus(200);

    if (info.status === 'approved') {
      // Só processa se o pedido ainda não foi pago. (Antes, um webhook repetido depois do
      // pedido virar "enviado"/"entregue" voltava o status para "pago" e duplicava as placas.)
      const markPaid = db.transaction(() => {
        const r = db.prepare(
          `UPDATE orders SET status='pago', paid_at=datetime('now'), mp_payment_id=?
           WHERE id=? AND status IN ('aguardando_pagamento','cancelado')`
        ).run(String(info.id), orderId);
        if (r.changes) generatePlatesForOrder(orderId);
      });
      markPaid();
    } else if (['rejected', 'cancelled'].includes(info.status)) {
      db.prepare(`UPDATE orders SET status='cancelado' WHERE id=? AND status='aguardando_pagamento'`).run(orderId);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook do Mercado Pago:', err?.message || err);
    res.sendStatus(200); // sempre 200, senão o Mercado Pago fica reenviando
  }
});

// Cria as placas no estoque do revendedor assim que o pedido é pago
function generatePlatesForOrder(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return;
  const insert = db.prepare(
    `INSERT INTO plates (reseller_id, order_id, code, color, status, cost) VALUES (?, ?, ?, ?, 'estoque', ?)`
  );
  for (let i = 0; i < order.qty_azul; i++) insert.run(order.reseller_id, order.id, nanoid(10), 'azul', order.unit_price);
  for (let i = 0; i < order.qty_preta; i++) insert.run(order.reseller_id, order.id, nanoid(10), 'preta', order.unit_price);
}

router.diagnose = diagnose;
module.exports = router;
