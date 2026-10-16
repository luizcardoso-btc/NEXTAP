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

const EMBALAGEM = { me_comp: '20', me_larg: '15', me_alt: '5', me_peso_base: '0.1', me_peso_placa: '0.03', me_seguro: '1', me_ie: '', me_tel: '', me_email: '', me_ao_vivo: '1', me_auto: '0', me_margem: '0', me_pct: '0', me_caixa: '100' };
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
const pacotesDe = qtd => Math.max(1, Math.ceil(qtd / Math.max(1, parseInt(embalagem().me_caixa, 10) || 100)));
function pacoteQtd(qtd) {
  const c = embalagem(), n = Math.ceil(qtd / pacotesDe(qtd));
  const peso = Math.max(0.1, +(num(c.me_peso_base) + num(c.me_peso_placa) * n).toFixed(3));
  return { width: num(c.me_larg), height: num(c.me_alt), length: num(c.me_comp), weight: peso };
}
const pacote = o => pacoteQtd(o.qtd);
const valorDeclarado = (o, c) => (c.me_seguro === '1' ? Math.max(1, +(o.unit_price * o.qtd).toFixed(2)) : 0);
function precoUnit(qtd) {
  const t = db.prepare('SELECT * FROM price_tiers ORDER BY min_qty').all();
  const f = t.find(x => qtd >= x.min_qty && qtd <= x.max_qty);
  return f ? f.unit_price : (t.length ? (qtd > t[t.length - 1].max_qty ? t[t.length - 1].unit_price : t[0].unit_price) : 25);
}

// ---------- cotação ----------
// Devolve os serviços disponíveis para um CEP e uma quantidade de placas (preço do Melhor Envio, já somando todas as caixas).
async function cotarRaw(cepDest, qtd, valorUnit) {
  const rem = remetente(); if (rem.postal_code.length !== 8) throw Object.assign(new Error('Preencha o CEP do remetente em Melhor Envio > Configurar (ou em Declaração).'), { status: 400 });
  const np = pacotesDe(qtd), pq = pacoteQtd(qtd), c = embalagem();
  const seguro = c.me_seguro === '1' ? Math.max(1, +(valorUnit * Math.ceil(qtd / np)).toFixed(2)) : 0;
  const j = await api('POST', '/shipment/calculate', {
    from: { postal_code: rem.postal_code }, to: { postal_code: cepDest },
    products: [{ id: 'pedido', width: pq.width, height: pq.height, length: pq.length, weight: pq.weight, insurance_value: seguro, quantity: 1 }],
  });
  const opcoes = (Array.isArray(j) ? j : []).map(s => ({
    id: s.id, nome: s.name, empresa: s.company && s.company.name, erro: s.error || null,
    preco: +(num(s.custom_price ?? s.price) * np).toFixed(2), prazo: s.custom_delivery_time ?? s.delivery_time, precisa_agencia: /latam|azul|buslog/i.test((s.company && s.company.name) || ''),
  })).filter(s => !s.erro && Number.isFinite(s.preco) && s.preco > 0 && !s.precisa_agencia).sort((a, b) => a.preco - b.preco);
  return { pacote: pq, pacotes: np, opcoes };
}
async function cotar(id) {
  const o = pedido(id); if (!o) throw Object.assign(new Error('Pedido não encontrado.'), { status: 404 });
  if (o.dest.postal_code.length !== 8) throw Object.assign(new Error('O pedido não tem CEP de entrega válido.'), { status: 400 });
  const r = await cotarRaw(o.dest.postal_code, o.qtd, o.unit_price);
  return { ...r, valor_cobrado: o.shipping_fee || 0, servico_pedido: o.me_servico_id || null, servico_pedido_nome: o.shipping_service || null };
}

// ---------- frete no checkout (cliente / revendedor) ----------
const cacheFrete = new Map();
const aoVivo = () => !!token() && embalagem().me_ao_vivo === '1' && remetente().postal_code.length === 8;
const comAcrescimo = p => { const c = embalagem(); return +(p * (1 + (num(c.me_pct) || 0) / 100) + (num(c.me_margem) || 0)).toFixed(2); };
const MAX_OPCOES = 4;
// Opções de frete para mostrar ao comprador. Se o Melhor Envio estiver fora do ar ou desligado, cai no frete fixo.
async function opcoesFrete(cep, qtd) {
  const fixo = { origem: 'fixo', opcoes: [{ id: 0, nome: 'Frete fixo', empresa: null, preco: db.freteFixo(), prazo: null }] };
  cep = dig(cep); qtd = Math.floor(Number(qtd));
  if (cep.length !== 8 || !(qtd >= 1)) return fixo;
  if (!aoVivo()) return fixo;
  const chave = cep + '|' + qtd + '|' + Object.values(embalagem()).join(','), hit = cacheFrete.get(chave);
  if (hit && Date.now() - hit.t < 15 * 60 * 1000) return hit.d;
  try {
    const r = await cotarRaw(cep, qtd, precoUnit(qtd));
    if (!r.opcoes.length) return { ...fixo, aviso: 'Sem frete disponível para este CEP; usando o frete fixo.' };
    const d = { origem: 'melhor_envio', pacotes: r.pacotes, opcoes: r.opcoes.slice(0, MAX_OPCOES).map(o => ({ id: o.id, nome: o.nome, empresa: o.empresa, prazo: o.prazo, preco: comAcrescimo(o.preco) })) };
    cacheFrete.set(chave, { t: Date.now(), d }); if (cacheFrete.size > 500) cacheFrete.delete(cacheFrete.keys().next().value);
    return d;
  } catch (e) { console.warn('[Melhor Envio] cotação falhou, usando frete fixo:', e.message); return { ...fixo, aviso: 'Não consegui calcular o frete agora; usando o frete fixo.' }; }
}
// Escolhe o frete que será cobrado no pedido (o servidor recalcula; nunca confia no valor vindo da tela).
async function resolverFrete(cep, qtd, servicoId) {
  const r = await opcoesFrete(cep, qtd);
  const o = r.opcoes.find(x => String(x.id) === String(servicoId)) || r.opcoes[0];
  return { preco: o.preco, nome: [o.empresa, o.nome].filter(Boolean).join(' ').slice(0, 30), servicoId: r.origem === 'fixo' ? null : o.id, origem: r.origem };
}
const limite = new Map();
function limitar(req, res, next) {
  const k = req.ip, agora = Date.now(), L = (limite.get(k) || []).filter(t => agora - t < 60000);
  if (L.length >= 20) return res.status(429).json({ error: 'Muitas consultas. Tente de novo em instantes.' });
  L.push(agora); limite.set(k, L); if (limite.size > 2000) limite.clear(); next();
}
router.post('/api/frete/cotar', limitar, async (req, res) => {
  const b = req.body || {}, qtd = Math.floor(Number(b.qtd));
  if (dig(b.cep).length !== 8) return res.status(400).json({ error: 'Informe o CEP com 8 números.' });
  if (!(qtd >= 1 && qtd <= 100000)) return res.status(400).json({ error: 'Informe a quantidade de placas.' });
  res.json(await opcoesFrete(b.cep, qtd));
});
router.opcoesFrete = opcoesFrete; router.resolverFrete = resolverFrete;

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
// Guarda o código no pedido. Ele só vira o rastreio visível (e o pedido "Enviado") quando o envio foi liberado.
function guardarRastreio(id, codigo) {
  db.prepare('UPDATE orders SET me_rastreio=? WHERE id=?').run(codigo, id);
  const o = db.prepare('SELECT status, me_liberar FROM orders WHERE id=?').get(id);
  if (o && (o.me_liberar === 1 || o.status === 'enviado')) aplicarRastreio(id, codigo);
}
function aplicarRastreio(id, codigo) {
  if (db.prepare('SELECT 1 FROM orders WHERE tracking_code=? AND id<>?').get(codigo, id)) return false; // código já usado em outro pedido
  // Marca o pedido como enviado quando o código chega (pagos/em produção).
  const r = db.prepare(`UPDATE orders SET tracking_code=?, status='enviado', enviado_at=COALESCE(enviado_at, datetime('now')),
    producao_at=COALESCE(producao_at, datetime('now')) WHERE id=? AND status IN ('pago','em_producao','enviado')`).run(codigo, id);
  if (r.changes) pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'status_enviado', detalhe: codigo + ' (Melhor Envio)' });
  return r.changes > 0;
}
async function comprar(id, servico, docDest, nomeServ, opts = {}) {
  const liberar = opts.liberar === false ? 0 : 1;
  const o = pedido(id); if (!o) throw Object.assign(new Error('Pedido não encontrado.'), { status: 404 });
  if (!['pago', 'em_producao'].includes(o.status)) throw Object.assign(new Error('Só dá para comprar etiqueta de pedidos pagos que ainda não foram enviados.'), { status: 409 });
  if (o.me_id) throw Object.assign(new Error('Este pedido já tem etiqueta comprada. Use "Atualizar rastreio" ou "Abrir etiqueta".'), { status: 409 });
  if (pacotesDe(o.qtd) > 1) throw Object.assign(new Error(`Este pedido tem ${o.qtd} placas e precisa de ${pacotesDe(o.qtd)} caixas (limite de ${embalagem().me_caixa} placas por caixa). Compre as etiquetas no painel do Melhor Envio e informe o rastreio aqui.`), { status: 409 });
  servico = parseInt(servico, 10); if (!servico) throw Object.assign(new Error('Escolha o serviço de frete.'), { status: 400 });
  const rem = remetente(), falta = faltaRemetente(rem);
  if (falta.length) throw Object.assign(new Error('Complete os dados do remetente: ' + falta.join(', ') + '.'), { status: 400 });
  const d = o.dest; for (const [k, n] of [['address', 'rua'], ['number', 'número'], ['district', 'bairro'], ['city', 'cidade'], ['state_abbr', 'UF']]) {
    if (!d[k]) throw Object.assign(new Error(`O endereço do pedido está sem ${n}. Complete antes de comprar a etiqueta.`), { status: 400 });
  }
  // Reserva a compra (evita duas compras ao mesmo tempo para o mesmo pedido).
  const claim = db.prepare("UPDATE orders SET me_status='comprando', me_erro=NULL, me_liberar=? WHERE id=? AND me_id IS NULL AND (me_status IS NULL OR me_status='falhou')").run(liberar, id);
  if (!claim.changes) throw Object.assign(new Error('Já existe uma compra de etiqueta em andamento para este pedido.'), { status: 409 });
  try {
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
  db.prepare('UPDATE orders SET me_status=?, custo_frete_real=COALESCE(?, custo_frete_real) WHERE id=?').run('comprada', Number.isFinite(preco) ? preco : null, id);
  return await finalizar(id, meId, servico, nomeServ || nome(carrinho, compra), preco);
  } catch (e) {
    db.prepare("UPDATE orders SET me_erro=?, me_status=CASE WHEN me_id IS NULL THEN 'falhou' ELSE me_status END WHERE id=?").run(String(e.message).slice(0, 300), id);
    throw e;
  }
}
// Conclui uma etiqueta que ficou no carrinho ou sem geração (por exemplo depois de recarregar o saldo).
async function concluir(id) {
  const o = pedido(id); if (!o || !o.me_id) throw Object.assign(new Error('Este pedido não tem etiqueta no carrinho.'), { status: 409 });
  let preco = NaN;
  if (o.me_status === 'carrinho') { const c = await api('POST', '/shipment/checkout', { orders: [o.me_id] }); preco = num(c.purchase && c.purchase.price); }
  return finalizar(o.id, o.me_id, o.me_servico_id, null, preco);
}
const nome = (carrinho, compra) => (carrinho && carrinho.service && carrinho.service.name) || (carrinho && carrinho.service_name) || null;
async function finalizar(id, meId, servicoId, servicoNome, preco) {
  await api('POST', '/shipment/generate', { orders: [meId] });
  let url = null;
  try { const pr = await api('POST', '/shipment/print', { mode: 'public', orders: [meId] }); url = pr.url || null; } catch { /* a etiqueta pode ser aberta depois */ }
  db.prepare('UPDATE orders SET me_status=?, me_etiqueta_url=COALESCE(?, me_etiqueta_url), shipping_service=COALESCE(?, shipping_service), custo_frete_real=COALESCE(?, custo_frete_real) WHERE id=?')
    .run('gerada', url, servicoNome ? String(servicoNome).slice(0, 30) : null, Number.isFinite(preco) ? preco : null, id);
  let codigo = null; try { codigo = (await rastrear(id)).codigo; } catch { /* o código pode demorar alguns minutos */ }
  if (codigo) guardarRastreio(id, codigo);
  db.prepare('UPDATE orders SET me_erro=NULL, me_tent=0 WHERE id=?').run(id);
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
    if (['me_margem', 'me_pct'].includes(k)) { const n = num(v || '0'); if (!(n >= 0 && n <= 1000)) return res.status(400).json({ error: 'Acréscimo inválido.' }); v = String(n); }
    if (k === 'me_caixa') { const n = parseInt(v, 10); if (!(n >= 1)) return res.status(400).json({ error: 'Placas por caixa inválido.' }); v = String(n); }
    if (k === 'me_ao_vivo' || k === 'me_auto') v = v === '1' || v === 'true' ? '1' : '0';
    if (k === 'me_tel') v = dig(v); if (k === 'me_seguro') v = v === '1' || v === 'true' ? '1' : '0';
    putSet.run(k, v);
  }
  res.json({ ok: true, config: embalagem() });
});
router.post('/api/admin/orders/:id/melhor-envio/cotar', requireAdmin, async (req, res) => { try { res.json(await cotar(Number(req.params.id))); } catch (e) { erro(res, e); } });
router.post('/api/admin/orders/:id/melhor-envio/comprar', requireAdmin, async (req, res) => { try { res.json(await comprar(Number(req.params.id), (req.body || {}).servico, (req.body || {}).documento, (req.body || {}).nome)); } catch (e) { erro(res, e); } });
router.post('/api/admin/orders/:id/melhor-envio/concluir', requireAdmin, async (req, res) => {
  try { await concluir(Number(req.params.id)); res.json({ ok: true, ...(await respostaPedido(Number(req.params.id))) }); } catch (e) { erro(res, e); }
});
const respostaPedido = async id => { const o = pedido(id); return { etiqueta_url: o && o.me_etiqueta_url, codigo: o && o.me_rastreio, order: pedidos.decorar(db.prepare('SELECT * FROM orders WHERE id=?').get(id)) }; };
router.post('/api/admin/orders/:id/melhor-envio/rastrear', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id), r = await rastrear(id);
    if (r.codigo) guardarRastreio(id, r.codigo);
    res.json({ ok: true, codigo: r.codigo, status: r.status, order: pedidos.decorar(db.prepare('SELECT * FROM orders WHERE id=?').get(id)) });
  } catch (e) { erro(res, e); }
});
// Libera o envio: o código guardado vira o rastreio do pedido (o cliente passa a ver) e o pedido fica "Enviado".
router.post('/api/admin/orders/:id/melhor-envio/liberar', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id), o = pedido(id);
    if (!o || !o.me_id) return res.status(409).json({ error: 'Este pedido não tem etiqueta do Melhor Envio.' });
    if (!['pago', 'em_producao'].includes(o.status)) return res.status(409).json({ error: 'Só dá para liberar o envio de pedidos pagos que ainda não foram enviados.' });
    let cod = o.me_rastreio; if (!cod) cod = (await rastrear(id)).codigo;
    if (!cod) return res.status(409).json({ error: 'O Melhor Envio ainda não gerou o código de rastreio. Tente de novo em alguns minutos.' });
    db.prepare('UPDATE orders SET me_rastreio=?, me_liberar=1 WHERE id=?').run(cod, id);
    if (!aplicarRastreio(id, cod)) return res.status(409).json({ error: 'Este código de rastreio já foi usado em outro pedido.' });
    res.json({ ok: true, codigo: cod, order: pedidos.decorar(db.prepare('SELECT * FROM orders WHERE id=?').get(id)) });
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
// ---------- compra automática ao confirmar o pagamento ----------
async function autoComprar(id) {
  if (embalagem().me_auto !== '1' || !token()) return;
  const o = pedido(id);
  if (!o || !o.me_servico_id || !['pago', 'em_producao'].includes(o.status)) return;
  if (o.me_id && !['carrinho', 'comprada'].includes(o.me_status)) return;
  try {
    if (o.me_id) await concluir(id); else await comprar(id, o.me_servico_id, '', o.shipping_service, { liberar: false });
    console.log(`[Melhor Envio] etiqueta comprada automaticamente para o pedido #${id}`);
  } catch (e) {
    db.prepare('UPDATE orders SET me_erro=?, me_tent=me_tent+1 WHERE id=?').run(String(e.message).slice(0, 300), id);
    pedidos.registrarEvento({ origem: 'melhor_envio', order_id: id, resultado: 'etiqueta_auto_falhou', detalhe: String(e.message).slice(0, 200) });
    console.warn(`[Melhor Envio] compra automática falhou no pedido #${id}:`, e.message);
  }
}
// A cada 5 minutos: tenta de novo as compras que falharam (ex.: sem saldo) e busca rastreios que ainda não saíram.
async function tentarPendentes() {
  if (!token() || embalagem().me_auto !== '1') return;
  const ids = db.prepare(`SELECT id FROM orders WHERE status IN ('pago','em_producao') AND me_servico_id IS NOT NULL AND me_tent < 12
    AND ((me_id IS NULL AND (me_status IS NULL OR me_status='falhou')) OR me_status IN ('carrinho','comprada')) ORDER BY id LIMIT 5`).all();
  for (const r of ids) await autoComprar(r.id);
  const semCodigo = db.prepare("SELECT id FROM orders WHERE status IN ('pago','em_producao') AND me_id IS NOT NULL AND me_status='gerada' AND me_rastreio IS NULL LIMIT 5").all();
  for (const r of semCodigo) { try { const x = await rastrear(r.id); if (x.codigo) guardarRastreio(r.id, x.codigo); } catch { /* tenta no próximo ciclo */ } }
}
setTimeout(() => tentarPendentes().catch(() => {}), 60 * 1000).unref();
setInterval(() => tentarPendentes().catch(() => {}), 5 * 60 * 1000).unref();
router.autoComprar = autoComprar; router.tentarPendentes = tentarPendentes;
module.exports = router;
