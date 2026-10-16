// Integração com o Melhor Envio (frete mais barato + etiqueta + rastreio). ARQUIVO NOVO.
// Configuração por variáveis de ambiente: MELHOR_ENVIO_TOKEN (obrigatória), MELHOR_ENVIO_SANDBOX=1 (testes),
// MELHOR_ENVIO_BASE (opcional, sobrescreve a URL), MELHOR_ENVIO_EMAIL (contato técnico no User-Agent).
// Remetente: reaproveita os dados da tela "Declaração" (settings rem_*). Embalagem e opções: settings me_*.
const express = require('express');
const db = require('./database.js');
const pedidos = require('./pedidos.js');
const { requireAdmin } = require('./auth-middleware.js');

const router = express.Router();
const getSet = db.prepare('SELECT valor FROM settings WHERE chave = ?');
const putSet = db.prepare('INSERT INTO settings (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor');
const set = (k, d) => { const r = getSet.get(k); return r ? r.valor : d; };
const dig = v => String(v ?? '').replace(/\D/g, '');
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };

const EMBALAGEM = { me_comp: '20', me_larg: '15', me_alt: '5', me_peso_base: '0.1', me_peso_placa: '0.03', me_seguro: '1', me_ie: '', me_tel: '', me_email: '' };
const embalagem = () => Object.fromEntries(Object.entries(EMBALAGEM).map(([k, d]) => [k, set(k, d)]));

const base = () => (process.env.MELHOR_ENVIO_BASE || (process.env.MELHOR_ENVIO_SANDBOX === '1' ? 'https://sandbox.melhorenvio.com.br' : 'https://melhorenvio.com.br')).replace(/\/$/, '');
// Limpa o que costuma vir junto ao colar: espaços, quebras de linha, aspas e o prefixo "Bearer ".
const token = () => String(process.env.MELHOR_ENVIO_TOKEN || '').replace(/\s+/g, '').replace(/^["']+|["']+$/g, '').replace(/^Bearer/i, '');
const contato = () => process.env.MELHOR_ENVIO_EMAIL || set('me_email', '') || process.env.MAIL_FROM || 'contato@nextapbrasil.com.br';

async function api(metodo, caminho, corpo) {
  if (!token()) throw Object.assign(new Error('Melhor Envio não configurado: defina a variável MELHOR_ENVIO_TOKEN no Railway.'), { status: 503 });
  let r;
  try {
    r = await fetch(base() + '/api/v2/me' + caminho, {
      method: metodo,
      headers: { Authorization: 'Bearer ' + token(), Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': `NexTap (${contato()})` },
      body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(30000),
    });
  } catch (e) { throw Object.assign(new Error('Não consegui falar com o Melhor Envio: ' + e.message), { status: 502 }); }
  const txt = await r.text(); let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { raw: txt.slice(0, 300) }; }
  if (!r.ok) {
    let m = j.message || j.error || '';
    if (j.errors && typeof j.errors === 'object') m += ' ' + Object.values(j.errors).flat().join(' ');
    if (r.status === 401) m = 'o Melhor Envio recusou o token. Confira se a variável MELHOR_ENVIO_TOKEN no Railway tem o token completo e sem aspas, se não há MELHOR_ENVIO_SANDBOX=1 com token de produção (ou o contrário) e se o token tem as permissões de envio.';
    throw Object.assign(new Error('Melhor Envio: ' + (String(m).trim() || ('erro ' + r.status))), { status: r.status === 401 ? 401 : 422, detalhe: j });
  }
  return j;
}

// ---------- dados do pedido ----------
function remetente() {
  const c = embalagem();
  const doc = dig(set('rem_doc', ''));
  const r = { name: set('rem_nome', ''), phone: dig(c.me_tel), email: contato(), address: set('rem_rua', ''), complement: set('rem_complemento', ''),
    number: set('rem_numero', ''), district: set('rem_bairro', ''), city: set('rem_cidade', ''), state_abbr: set('rem_uf', '').toUpperCase(), country_id: 'BR', postal_code: dig(set('rem_cep', '')) };
  if (doc.length === 14) { r.company_document = doc; if (c.me_ie) r.state_register = c.me_ie; } else r.document = doc;
  return r;
}
function faltaRemetente(r) {
  const f = [];
  if (!r.name) f.push('nome'); if (!(r.document || r.company_document)) f.push('CPF/CNPJ'); if (r.postal_code.length !== 8) f.push('CEP');
  if (!r.address) f.push('rua'); if (!r.number) f.push('número'); if (!r.district) f.push('bairro'); if (!r.city) f.push('cidade'); if (!r.state_abbr) f.push('UF');
  if (!r.phone) f.push('telefone');
  return f;
}
function pedido(id) {
  const o = db.prepare(`SELECT o.*, r.name AS r_nome, r.email AS r_email, r.whatsapp AS r_whats, r.addr_cep, r.addr_street, r.addr_number, r.addr_complement,
    r.addr_district, r.addr_city, r.addr_state FROM orders o JOIN resellers r ON r.id = o.reseller_id WHERE o.id = ?`).get(id);
  if (!o) return null;
  const e = o.ship_street || o.ship_cep;
  o.dest = { name: o.ship_name || o.r_nome, phone: dig(o.ship_phone || o.r_whats), email: o.r_email, postal_code: dig(e ? o.ship_cep : o.addr_cep),
    address: e ? o.ship_street : o.addr_street, number: e ? o.ship_number : o.addr_number, complement: (e ? o.ship_complement : o.addr_complement) || '',
    district: e ? o.ship_district : o.addr_district, city: e ? o.ship_city : o.addr_city, state_abbr: String((e ? o.ship_state : o.addr_state) || '').toUpperCase(), country_id: 'BR' };
  o.qtd = (o.qty_azul || 0) + (o.qty_preta || 0);
  return o;
}
function pacote(o) {
  const c = embalagem();
  const peso = Math.max(0.1, +(num(c.me_peso_base) + num(c.me_peso_placa) * o.qtd).toFixed(3));
  return { width: num(c.me_larg), height: num(c.me_alt), length: num(c.me_comp), weight: peso };
}
const valorDeclarado = (o, c) => (c.me_seguro === '1' ? Math.max(1, +(o.unit_price * o.qtd).toFixed(2)) : 0);

// ---------- cotação ----------
async function cotar(id, docDest) {
  const o = pedido(id); if (!o) throw Object.assign(new Error('Pedido não encontrado.'), { status: 404 });
  if (o.dest.postal_code.length !== 8) throw Object.assign(new Error('O pedido não tem CEP de entrega válido.'), { status: 400 });
  const rem = remetente(); if (rem.postal_code.length !== 8) throw Object.assign(new Error('Preencha o CEP do remetente em Melhor Envio > Configurar (ou em Declaração).'), { status: 400 });
  const p = pacote(o), c = embalagem();
  const j = await api('POST', '/shipment/calculate', {
    from: { postal_code: rem.postal_code }, to: { postal_code: o.dest.postal_code },
    products: [{ id: 'pedido-' + id, width: p.width, height: p.height, length: p.length, weight: p.weight, insurance_value: valorDeclarado(o, c), quantity: 1 }],
  });
  const lista = (Array.isArray(j) ? j : []).map(s => ({
    id: s.id, nome: s.name, empresa: s.company && s.company.name, erro: s.error || null,
    preco: num(s.custom_price ?? s.price), prazo: s.custom_delivery_time ?? s.delivery_time, precisa_agencia: /latam|azul|buslog/i.test((s.company && s.company.name) || ''),
  })).filter(s => !s.erro && Number.isFinite(s.preco) && !s.precisa_agencia).sort((a, b) => a.preco - b.preco);
  return { pacote: p, opcoes: lista, valor_cobrado: o.shipping_fee || 0 };
}

// ---------- compra ----------
const primeiro = v => (Array.isArray(v) ? v[0] : v);
function acharRastreio(j, id) {
  const x = (j && (j[id] || (j.orders && j.orders[id]))) || primeiro(j && j.orders) || j || {};
  return String(x.tracking || x.self_tracking || '').trim().toUpperCase() || null;
}
async function rastrear(id) {
  const o = pedido(id); if (!o || !o.me_id) throw Object.assign(new Error('Este pedido não tem etiqueta do Melhor Envio.'), { status: 409 });
  const j = await api('POST', '/shipment/tracking', { orders: [o.me_id] });
  const x = j[o.me_id] || {};
  return { codigo: acharRastreio(j, o.me_id), status: x.status || null };
}
function aplicarRastreio(id, codigo) {
  if (db.prepare('SELECT 1 FROM orders WHERE tracking_code=? AND id<>?').get(codigo, id)) return false; // código já usado em outro pedido
  // Marca o pedido como enviado quando o código chega (pagos/em produção).
  const r = db.prepare(`UPDATE orders SET tracking_code=?, status='enviado', enviado_at=COALESCE(enviado_at, datetime('now')),
    producao_at=COALESCE(producao_at, datetime('now')) WHERE id=? AND status IN ('pago','em_producao','enviado')`).run(codigo, id);
  if (r.changes) pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'status_enviado', detalhe: codigo + ' (Melhor Envio)' });
  return r.changes > 0;
}
async function comprar(id, servico, docDest, nomeServ) {
  const o = pedido(id); if (!o) throw Object.assign(new Error('Pedido não encontrado.'), { status: 404 });
  if (!['pago', 'em_producao'].includes(o.status)) throw Object.assign(new Error('Só dá para comprar etiqueta de pedidos pagos que ainda não foram enviados.'), { status: 409 });
  if (o.me_id) throw Object.assign(new Error('Este pedido já tem etiqueta comprada. Use "Atualizar rastreio" ou "Abrir etiqueta".'), { status: 409 });
  servico = parseInt(servico, 10); if (!servico) throw Object.assign(new Error('Escolha o serviço de frete.'), { status: 400 });
  const rem = remetente(), falta = faltaRemetente(rem);
  if (falta.length) throw Object.assign(new Error('Complete os dados do remetente: ' + falta.join(', ') + '.'), { status: 400 });
  const d = o.dest; for (const [k, n] of [['address', 'rua'], ['number', 'número'], ['district', 'bairro'], ['city', 'cidade'], ['state_abbr', 'UF']]) {
    if (!d[k]) throw Object.assign(new Error(`O endereço do pedido está sem ${n}. Complete antes de comprar a etiqueta.`), { status: 400 });
  }
  const c = embalagem(), p = pacote(o), vd = valorDeclarado(o, c);
  const doc = dig(docDest); const para = { ...d }; if (doc.length === 11) para.document = doc; else if (doc.length === 14) para.company_document = doc;
  const nfe = db.prepare('SELECT chave FROM nfe_pedido WHERE order_id = ?').get(id);
  const opcoes = { receipt: false, own_hand: false, reverse: false, platform: 'NexTap', tags: [{ tag: 'Pedido #' + String(id).padStart(5, '0'), url: null }] };
  if (vd) opcoes.insurance_value = vd;
  if (nfe && nfe.chave) opcoes.invoice = { key: dig(nfe.chave) };
  const carrinho = await api('POST', '/cart', {
    service: servico, from: rem, to: para,
    products: [{ name: 'Placa NFC/QR de avaliação', quantity: o.qtd, unitary_value: +o.unit_price.toFixed(2) }],
    volumes: [{ height: p.height, width: p.width, length: p.length, weight: p.weight }], options: opcoes,
  });
  const meId = carrinho.id; if (!meId) throw Object.assign(new Error('O Melhor Envio não devolveu o id da etiqueta.'), { status: 502 });
  db.prepare('UPDATE orders SET me_id=?, me_servico_id=?, me_status=? WHERE id=?').run(meId, servico, 'carrinho', id);
  let compra;
  try { compra = await api('POST', '/shipment/checkout', { orders: [meId] }); }
  catch (e) { e.message += ' (A etiqueta ficou no carrinho do Melhor Envio; ajuste o saldo e use "Concluir compra".)'; throw e; }
  const pago = num(compra.purchase && compra.purchase.price) ; const preco = Number.isFinite(pago) ? pago : num(carrinho.price);
  db.prepare('UPDATE orders SET me_status=? WHERE id=?').run('comprada', id);
  return finalizar(id, meId, servico, nomeServ || nome(carrinho, compra), preco);
}
const nome = (carrinho, compra) => (carrinho && carrinho.service && carrinho.service.name) || (carrinho && carrinho.service_name) || null;
async function finalizar(id, meId, servicoId, servicoNome, preco) {
  await api('POST', '/shipment/generate', { orders: [meId] });
  let url = null;
  try { const pr = await api('POST', '/shipment/print', { mode: 'public', orders: [meId] }); url = pr.url || null; } catch { /* a etiqueta pode ser aberta depois */ }
  db.prepare('UPDATE orders SET me_status=?, me_etiqueta_url=COALESCE(?, me_etiqueta_url), shipping_service=COALESCE(?, shipping_service), custo_frete_real=COALESCE(?, custo_frete_real) WHERE id=?')
    .run('gerada', url, servicoNome ? String(servicoNome).slice(0, 30) : null, Number.isFinite(preco) ? preco : null, id);
  let codigo = null; try { codigo = (await rastrear(id)).codigo; } catch { /* o código pode demorar alguns minutos */ }
  if (codigo) aplicarRastreio(id, codigo);
  pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'etiqueta_melhor_envio', detalhe: (codigo || 'sem código ainda') });
  const o = pedido(id);
  return { ok: true, codigo, etiqueta_url: o.me_etiqueta_url, custo: o.custo_frete_real, servico: o.shipping_service, order: pedidos.decorar(db.prepare('SELECT * FROM orders WHERE id=?').get(id)) };
}

// ---------- rotas ----------
const erro = (res, e) => res.status(e.status || 500).json({ error: e.message || 'Erro inesperado.' });
const faltas = () => faltaRemetente(remetente());
router.get('/api/admin/melhor-envio', requireAdmin, (req, res) => {
  const rem = remetente();
  res.json({ token: !!token(), sandbox: process.env.MELHOR_ENVIO_SANDBOX === '1', remetente_ok: faltas().length === 0, faltando: faltas(),
    remetente: { nome: rem.name, documento: rem.document || rem.company_document || '', cep: rem.postal_code, cidade: rem.city, uf: rem.state_abbr }, config: embalagem() });
});
// Diagnóstico: mostra qual endereço e qual token (mascarado) o sistema está usando e se o Melhor Envio aceita.
router.post('/api/admin/melhor-envio/testar', requireAdmin, async (req, res) => {
  const t = token();
  const info = { ambiente: base(), token_tamanho: t.length, token_inicio: t.slice(0, 6), token_fim: t.slice(-4), sandbox_var: process.env.MELHOR_ENVIO_SANDBOX || '' };
  if (!t) return res.json({ ok: false, ...info, erro: 'A variável MELHOR_ENVIO_TOKEN não chegou ao sistema (vazia). Confirme se foi criada no serviço certo do Railway e se o deploy terminou.' });
  try {
    const u = await api('GET', '');
    let saldo = null; try { const s = await api('GET', '/balance'); saldo = s.balance ?? null; } catch { /* opcional */ }
    res.json({ ok: true, ...info, nome: [u.firstname, u.lastname].filter(Boolean).join(' ') || u.name || null, email: u.email || null, saldo });
  } catch (e) { res.json({ ok: false, ...info, erro: e.message, status: e.status }); }
});
router.put('/api/admin/melhor-envio', requireAdmin, (req, res) => {
  const b = req.body || {}, ant = embalagem();
  for (const k of Object.keys(EMBALAGEM)) if (b[k] !== undefined) {
    let v = String(b[k]).trim().slice(0, 80);
    if (['me_comp', 'me_larg', 'me_alt', 'me_peso_base', 'me_peso_placa'].includes(k)) { const n = num(v); if (!(n > 0)) return res.status(400).json({ error: 'Medidas e pesos precisam ser maiores que zero.' }); v = String(n); }
    if (k === 'me_tel') v = dig(v); if (k === 'me_seguro') v = v === '1' || v === 'true' ? '1' : '0';
    putSet.run(k, v);
  }
  res.json({ ok: true, config: embalagem() });
});
router.post('/api/admin/orders/:id/melhor-envio/cotar', requireAdmin, async (req, res) => { try { res.json(await cotar(Number(req.params.id))); } catch (e) { erro(res, e); } });
router.post('/api/admin/orders/:id/melhor-envio/comprar', requireAdmin, async (req, res) => { try { res.json(await comprar(Number(req.params.id), (req.body || {}).servico, (req.body || {}).documento, (req.body || {}).nome)); } catch (e) { erro(res, e); } });
// Conclui uma etiqueta que ficou no carrinho (por exemplo depois de recarregar o saldo).
router.post('/api/admin/orders/:id/melhor-envio/concluir', requireAdmin, async (req, res) => {
  try {
    const o = pedido(Number(req.params.id)); if (!o || !o.me_id) return res.status(409).json({ error: 'Este pedido não tem etiqueta no carrinho.' });
    if (o.me_status === 'carrinho') await api('POST', '/shipment/checkout', { orders: [o.me_id] });
    res.json(await finalizar(o.id, o.me_id, o.me_servico_id, null, NaN));
  } catch (e) { erro(res, e); }
});
router.post('/api/admin/orders/:id/melhor-envio/rastrear', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id), r = await rastrear(id);
    if (r.codigo) aplicarRastreio(id, r.codigo);
    res.json({ ok: true, codigo: r.codigo, status: r.status, order: pedidos.decorar(db.prepare('SELECT * FROM orders WHERE id=?').get(id)) });
  } catch (e) { erro(res, e); }
});
router.post('/api/admin/orders/:id/melhor-envio/etiqueta', requireAdmin, async (req, res) => {
  try {
    const o = pedido(Number(req.params.id)); if (!o || !o.me_id) return res.status(409).json({ error: 'Este pedido não tem etiqueta do Melhor Envio.' });
    const pr = await api('POST', '/shipment/print', { mode: 'public', orders: [o.me_id] });
    if (pr.url) db.prepare('UPDATE orders SET me_etiqueta_url=? WHERE id=?').run(pr.url, o.id);
    res.json({ url: pr.url || o.me_etiqueta_url });
  } catch (e) { erro(res, e); }
});
module.exports = router;
