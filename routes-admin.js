const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./database.js');
const senha = require('./senha.js');
const pedidos = require('./pedidos.js');
const { requireAdmin } = require('./auth-middleware.js');

const router = express.Router();
router.use(requireAdmin);

router.get('/overview', (req, res) => {
  const revendedores = db.prepare('SELECT COUNT(*) AS n FROM resellers').get().n;
  const faturamento = db.prepare("SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE status IN ('pago','em_producao','enviado','entregue')").get().s;
  const pendentes = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='aguardando_pagamento'").get().n;
  const placas = db.prepare('SELECT COUNT(*) AS n FROM plates WHERE order_id IS NOT NULL').get().n;
  const ativas = db.prepare("SELECT COUNT(*) AS n FROM plates WHERE status='ativa'").get().n;
  const aReceber = db.prepare("SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE status='aguardando_pagamento'").get().s;
  const pagos = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('pago','em_producao','enviado','entregue')").get().n;
  const freteCobrado = db.prepare("SELECT COALESCE(SUM(shipping_fee),0) AS s FROM orders WHERE status IN ('pago','em_producao','enviado','entregue')").get().s;
  res.json({ revendedores, faturamento, frete_cobrado: freteCobrado, a_receber: aReceber, pendentes, pagos, placas, ativas, persistente: db.meta.persistente });
});

// Gera um link de redefinição de senha (vale 24h) para o fornecedor enviar ao revendedor, por exemplo no WhatsApp.
router.post('/resellers/:id/reset-link', (req, res) => {
  const r = db.prepare('SELECT id, name FROM resellers WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Revendedor não encontrado.' });
  const link = senha.criarLink(req, r.id, 24);
  res.json({ link, token: link.split('?reset=')[1], nome: r.name });
});

// Define a senha direto (sem e-mail nem link): o fornecedor passa a nova senha ao revendedor.
router.post('/resellers/:id/definir-senha', async (req, res) => {
  const r = db.prepare('SELECT id, name FROM resellers WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Revendedor não encontrado.' });
  const pw = String((req.body || {}).senha || '');
  if (pw.length < 6) return res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres.' });
  db.prepare('UPDATE resellers SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(pw, 10), r.id);
  senha.consumir(r.id);
  res.json({ ok: true, nome: r.name });
});

// Conta de teste: cria (ou atualiza a senha de) uma conta com placas de teste já prontas para NFC/QR.
router.post('/contas-teste', async (req, res) => {
  const b = req.body || {};
  const em = String(b.email || '').toLowerCase().trim(), pw = String(b.senha || '');
  if (!/^\S+@\S+\.\S+$/.test(em)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
  if (pw.length < 6) return res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres.' });
  const hash = await bcrypt.hash(pw, 10);
  let r = db.prepare('SELECT id FROM resellers WHERE lower(email) = ?').get(em), criada = false;
  if (r) db.prepare('UPDATE resellers SET password_hash = ? WHERE id = ?').run(hash, r.id);
  else { r = { id: Number(db.prepare('INSERT INTO resellers (name, email, whatsapp, password_hash) VALUES (?, ?, ?, ?)').run('Conta de teste NexTap', em, '', hash).lastInsertRowid) }; criada = true; }
  const base = (process.env.SITE_HOST ? 'https://' + process.env.SITE_HOST.replace(/^https?:\/\//, '') : `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const placas = pedidos.criarPlacasTeste(r.id, b.placas || 6).map(p => ({ ...p, url: `${base}/r/${p.code}` }));
  res.json({ id: r.id, email: em, criada, placas, painel: base + '/revendedor/' });
});

// Serviço "Link de Avaliação do Google": assinantes, faturamento e uso.
router.get('/google-servico', (req, res) => {
  const gl = require('./google-plano.js');
  const rs = db.prepare(`SELECT r.id, r.name, r.email, r.gl_plano, r.gl_ate, r.created_at,
      (SELECT COUNT(*) FROM gl_links l WHERE l.reseller_id = r.id) AS links,
      (SELECT COALESCE(SUM(valor),0) FROM gl_pagamentos p WHERE p.reseller_id = r.id AND p.status='pago') AS pago,
      (SELECT COUNT(*) FROM gl_pagamentos p WHERE p.reseller_id = r.id AND p.status='pago') AS pagamentos,
      (SELECT MAX(pago_em) FROM gl_pagamentos p WHERE p.reseller_id = r.id AND p.status='pago') AS ultimo_pagamento
    FROM resellers r WHERE r.gl_plano IS NOT NULL OR EXISTS (SELECT 1 FROM gl_links l WHERE l.reseller_id = r.id)
    ORDER BY (r.gl_ate IS NOT NULL) DESC, r.gl_ate DESC, links DESC`).all()
    .map(x => { const e = gl.estado(x.id); return { ...x, plano_atual: e.plano, vigente: !!e.ate, limite: e.limite }; });
  const q = sql => db.prepare(sql).get();
  const mes = q("SELECT COALESCE(SUM(valor),0) AS s FROM gl_pagamentos WHERE status='pago' AND strftime('%Y-%m',pago_em)=strftime('%Y-%m','now')").s;
  const total = q("SELECT COALESCE(SUM(valor),0) AS s FROM gl_pagamentos WHERE status='pago'").s;
  const ativos = rs.filter(x => x.vigente);
  const mrr = ativos.reduce((s, x) => s + (gl.PLANOS[x.plano_atual] ? gl.PLANOS[x.plano_atual].preco : 0), 0);
  const vencendo = ativos.filter(x => x.gl_ate && x.gl_ate <= db.prepare("SELECT datetime('now','+7 days') AS d").get().d).length;
  const contas = q('SELECT COUNT(DISTINCT reseller_id) AS n FROM gl_links').n;
  const links = q('SELECT COUNT(*) AS n FROM gl_links').n;
  const pendentes = q("SELECT COUNT(*) AS n FROM gl_pagamentos WHERE status='pendente' AND criado_em > datetime('now','-1 day')").n;
  res.json({ resumo: { faturamento_mes: mes, faturamento_total: total, mrr, assinantes_ativos: ativos.length, vencendo_7d: vencendo, contas_usando: contas, links_gerados: links, pix_pendentes: pendentes }, assinantes: rs });
});

// Baixa uma cópia completa do banco (arquivo .db) — guarde no seu computador de vez em quando.
router.get('/backup', (req, res) => {
  try {
    const arquivo = db.copiaTemporaria();
    const nome = `nextap-backup-${new Date().toISOString().slice(0, 10)}.db`;
    res.download(arquivo, nome, () => fs.unlink(arquivo, () => {}));
  } catch (e) {
    console.error('[DB] Falha ao gerar backup para download:', e.message);
    res.status(500).json({ error: 'Não foi possível gerar o backup agora.' });
  }
});

// Situação do armazenamento, contagens e backups (tela "Dados e backups").
router.get('/sistema', (req, res) => {
  res.json({
    dados_persistentes: db.meta.persistente,
    integridade: db.integridade(),
    contagens: db.contagens(),
    backups: db.listarBackups(),
  });
});

// Restaurar a partir de um backup que já está guardado no servidor (pasta backups/ do Volume).
router.post('/restore-local', (req, res) => {
  const { nome, modo } = req.body || {};
  const arquivo = path.join(db.meta.backupDir, path.basename(String(nome || '')));
  if (!/\.db$/.test(arquivo) || !fs.existsSync(arquivo)) return res.status(404).json({ error: 'Backup não encontrado no servidor.' });
  if (!['substituir', 'revendedores'].includes(modo)) return res.status(400).json({ error: 'Escolha como restaurar.' });
  try { res.json(db.restaurar(arquivo, modo)); }
  catch (e) { console.error('[DB] Falha ao restaurar:', e.message); res.status(400).json({ error: e.message }); }
});

// Restaurar a partir de um arquivo .db enviado pelo painel (o backup que você baixou).
router.post('/restore', express.raw({ type: () => true, limit: '80mb' }), (req, res) => {
  const modo = String(req.query.modo || '');
  if (!['substituir', 'revendedores'].includes(modo)) return res.status(400).json({ error: 'Escolha como restaurar.' });
  if (!Buffer.isBuffer(req.body) || req.body.length < 512) return res.status(400).json({ error: 'Nenhum arquivo recebido.' });
  const tmp = path.join(os.tmpdir(), `restore-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    fs.writeFileSync(tmp, req.body);
    res.json(db.restaurar(tmp, modo));
  } catch (e) {
    console.error('[DB] Falha ao restaurar upload:', e.message);
    res.status(400).json({ error: e.message });
  } finally { fs.unlink(tmp, () => {}); }
});

// Lista de revendedores em planilha (CSV abre no Excel/Google Planilhas) — outra forma de guardar uma cópia.
const csvCel = v => {
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // evita fórmulas maliciosas ao abrir no Excel
  return '"' + t.replace(/"/g, '""') + '"';
};
router.get('/export/revendedores', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.name, r.email, r.whatsapp, r.created_at,
      r.addr_cep, r.addr_street, r.addr_number, r.addr_complement, r.addr_district, r.addr_city, r.addr_state, r.addr_country,
      (SELECT COUNT(*) FROM orders o WHERE o.reseller_id = r.id) AS pedidos,
      (SELECT COUNT(*) FROM plates p WHERE p.reseller_id = r.id) AS placas
    FROM resellers r ORDER BY r.id`).all();
  const cab = ['ID', 'Nome', 'E-mail', 'WhatsApp', 'Cadastro', 'CEP', 'Rua', 'Número', 'Complemento', 'Bairro', 'Cidade', 'UF', 'País', 'Pedidos', 'Placas'];
  const linhas = rows.map(r => [r.id, r.name, r.email, r.whatsapp, r.created_at, r.addr_cep, r.addr_street, r.addr_number,
    r.addr_complement, r.addr_district, r.addr_city, r.addr_state, r.addr_country, r.pedidos, r.placas].map(csvCel).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="nextap-revendedores-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\ufeff' + [cab.map(csvCel).join(';'), ...linhas].join('\r\n'));
});

// Cadastro manual de um revendedor (para reativar quem já tinha conta): cria a conta e devolve o link para ele escolher a senha.
router.post('/resellers', async (req, res) => {
  const { name, email, whatsapp } = req.body || {};
  const em = String(email || '').toLowerCase().trim();
  if (!String(name || '').trim() || !em.includes('@')) return res.status(400).json({ error: 'Informe nome e e-mail válidos.' });
  if (db.prepare('SELECT 1 FROM resellers WHERE lower(email) = ?').get(em)) return res.status(409).json({ error: 'Já existe um revendedor com esse e-mail.' });
  const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10); // senha aleatória; ele define a dele pelo link
  const info = db.prepare('INSERT INTO resellers (name, email, whatsapp, password_hash) VALUES (?, ?, ?, ?)')
    .run(String(name).trim().slice(0, 120), em, String(whatsapp || '').trim().slice(0, 30), hash);
  res.json({ id: info.lastInsertRowid, link: senha.criarLink(req, info.lastInsertRowid, 72) });
});

router.get('/resellers', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.name, r.email, r.whatsapp, r.addr_city, r.addr_state, r.created_at,
      (SELECT COUNT(*) FROM orders o WHERE o.reseller_id=r.id) AS pedidos,
      (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.reseller_id=r.id AND o.status IN ('pago','em_producao','enviado','entregue')) AS gasto,
      (SELECT COUNT(*) FROM plates p WHERE p.reseller_id=r.id) AS placas,
      (SELECT COUNT(*) FROM sales s WHERE s.reseller_id=r.id) AS vendas
    FROM resellers r ORDER BY r.id DESC
  `).all();
  res.json(rows);
});

router.get('/orders', (req, res) => {
  const rows = db.prepare(`
    SELECT o.*, r.name AS reseller_name, r.email AS reseller_email
    FROM orders o JOIN resellers r ON r.id = o.reseller_id
    ORDER BY o.id DESC
  `).all();
  res.json(rows.map(pedidos.decorar));
});

// Frete fixo cobrado em cada pedido (R$). Vale na hora para novos pedidos; pedidos já feitos não mudam.
router.get('/frete', (req, res) => res.json({ frete: db.freteFixo() }));
router.put('/frete', (req, res) => {
  const v = Number(String((req.body || {}).valor).replace(',', '.'));
  if (!Number.isFinite(v) || v < 0 || v > 500) return res.status(400).json({ error: 'Informe um valor entre R$ 0,00 e R$ 500,00.' });
  db.prepare("INSERT INTO settings (chave, valor) VALUES ('frete_fixo', ?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor").run(v.toFixed(2));
  pedidos.registrarEvento({ origem: 'admin', resultado: 'frete_alterado', detalhe: 'R$ ' + v.toFixed(2) });
  res.json({ frete: db.freteFixo() });
});

// Cancelar (só pedido que ainda não foi pago). As demais etapas têm rotas próprias, abaixo.
router.put('/orders/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (status !== 'cancelado') return res.status(400).json({ error: 'Use os botões de produção, envio e entrega.' });
  const o = db.prepare('SELECT status FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (o.status !== 'aguardando_pagamento') {
    return res.status(409).json({ error: 'Só dá para cancelar pedidos que ainda aguardam pagamento. Para um pedido já pago, faça o estorno no Mercado Pago.' });
  }
  db.prepare("UPDATE orders SET status='cancelado' WHERE id=?").run(req.params.id);
  pedidos.registrarEvento({ origem: 'admin', order_id: Number(req.params.id), resultado: 'status_cancelado' });
  res.json({ ok: true });
});

// Custo real do envio (o que você pagou aos Correios). Vazio = não informado (null); inválido = false.
function lerCusto(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  let t = String(v).replace(/R\$|\s/g, '');            // aceita "R$ 32,85", "32,85", "32.85" e "1.234,56"
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 5000 ? Math.round(n * 100) / 100 : false;
}
function lerValor(v) { // aceita "R$ 1.234,56", "1234,56", "1234.56"
  let t = String(v).replace(/R\$|\s/g, ''); if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t); return Number.isFinite(n) ? Math.round(n * 100) / 100 : false;
}
router.put('/orders/:id/custo-frete', (req, res) => {
  const v = lerCusto((req.body || {}).valor);
  if (v === false) return res.status(400).json({ error: 'Valor inválido.' });
  const r = db.prepare('UPDATE orders SET custo_frete_real = ? WHERE id = ?').run(v, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Pedido não encontrado.' });
  res.json({ ok: true });
});

// Corrigir os valores de um pedido já feito/pago (preço por placa, frete cobrado, total, taxa do Mercado Pago, forma de pagamento).
// Também corrige a quantidade de placas azuis/pretas (cria ou remove placas sem uso). O status do pedido não muda. Fica registrado em Dados e backups.
router.put('/orders/:id/valores', (req, res) => {
  const o = pegar(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (o.status === 'aguardando_pagamento') return res.status(400).json({ error: 'Pedido ainda não pago: o valor está preso ao pagamento do Mercado Pago. Cancele e refaça, ou confirme o pagamento antes de editar.' });
  const b = req.body || {};
  const num = (v, max = 1000000) => { if (v === undefined || v === null || String(v).trim() === '') return null; const n = lerValor(v); return n !== false && n >= 0 && n <= max ? n : false; };
  const unit = num(b.unit_price), frete = num(b.shipping_fee), total = num(b.total), taxa = num(b.mp_fee);
  const qa = b.qty_azul === undefined || b.qty_azul === '' ? o.qty_azul : Number(b.qty_azul), qp = b.qty_preta === undefined || b.qty_preta === '' ? o.qty_preta : Number(b.qty_preta);
  if (!Number.isInteger(qa) || !Number.isInteger(qp) || qa < 0 || qp < 0 || qa > 100000 || qp > 100000) return res.status(400).json({ error: 'Quantidade de placas inválida.' });
  const custoPago = b.custo_frete === undefined ? undefined : lerCusto(b.custo_frete);
  if (custoPago === false) return res.status(400).json({ error: 'Frete pago inválido. Informe um valor em reais (ex.: 24,46) ou deixe em branco.' });
  if (unit === false || frete === false || total === false || taxa === false) return res.status(400).json({ error: 'Valor inválido. Use números em reais, ex.: 18,90.' });
  const qty = qa + qp + (o.qty_outras || 0);
  if (qty < 1) return res.status(400).json({ error: 'O pedido precisa ter ao menos 1 placa.' });
  const u = unit !== null ? unit : o.unit_price, f = frete !== null ? frete : (o.shipping_fee || 0);
  const t = total !== null ? total : Math.round((qty * u + f) * 100) / 100;
  if (t <= 0) return res.status(400).json({ error: 'O total do pedido precisa ser maior que zero.' });
  const metodo = ['pix', 'credit_card'].includes(b.payment_method) ? b.payment_method : o.payment_method;
  const antes = `preço ${o.unit_price}, frete ${o.shipping_fee || 0}, total ${o.total}, taxa MP ${o.mp_fee ?? '—'}`;
  try {
    db.transaction(() => {
      if (qa !== o.qty_azul) pedidos.ajustarPlacas(o.id, 'azul', qa);
      if (qp !== o.qty_preta) pedidos.ajustarPlacas(o.id, 'preta', qp);
      db.prepare('UPDATE orders SET qty_azul=?, qty_preta=?, unit_price=?, shipping_fee=?, total=?, payment_method=?, mp_fee=?, mp_net=? WHERE id=?')
        .run(qa, qp, u, f, t, metodo, taxa, taxa !== null ? Math.round((t - taxa) * 100) / 100 : null, o.id);
      if (custoPago !== undefined) db.prepare('UPDATE orders SET custo_frete_real=? WHERE id=?').run(custoPago, o.id);
      if (qa !== o.qty_azul || qp !== o.qty_preta) db.prepare('DELETE FROM declaracoes WHERE order_id = ?').run(o.id); // a declaração de conteúdo é refeita sozinha com as quantidades novas
    })();
  } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  pedidos.registrarEvento({ origem: 'admin', order_id: o.id, resultado: 'valores_editados', detalhe: `antes: azul ${o.qty_azul}, preta ${o.qty_preta}, ${antes} → depois: azul ${qa}, preta ${qp}, preço ${u}, frete ${f}, total ${t}, taxa MP ${taxa ?? '—'}` });
  res.json(resposta(o.id));
});

// Excluir pedido (qualquer status, inclusive já pago). Fica registrado em Dados e backups.
router.delete('/orders/:id', (req, res) => {
  try { res.json({ ok: true, ...pedidos.excluirPedido(Number(req.params.id), { forcar: !!(req.body && req.body.forcar) }) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, placas_em_uso: e.placas_em_uso }); }
});

// ---- Pedido recebido (pago) → Produção → Enviado (com código dos Correios) → Entregue ----
const pegar = id => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const resposta = id => ({ ok: true, order: pedidos.decorar(pegar(id)) });

function iniciarProducao(id) {
  const r = db.prepare("UPDATE orders SET status='em_producao', producao_at=datetime('now') WHERE id=? AND status='pago'").run(id);
  if (r.changes) pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'status_em_producao' });
  return r.changes > 0;
}

router.post('/orders/:id/producao', (req, res) => {
  const id = Number(req.params.id);
  if (!pegar(id)) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!iniciarProducao(id)) return res.status(409).json({ error: 'A produção só pode começar em pedidos pagos que ainda não entraram em produção.' });
  res.json(resposta(id));
});

// Vários de uma vez (produzir em lote).
router.post('/orders-producao-lote', (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 200) : [];
  if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos um pedido.' });
  const iniciados = db.transaction(() => ids.filter(iniciarProducao).length)();
  res.json({ iniciados, ignorados: ids.length - iniciados });
});

// Liberar placas na conta de um revendedor SEM cobrança de checkout (ex.: o seu perfil pessoal): cria um pedido interno já pago,
// entregue em mãos, com o preço da tabela (ou o que você definir). Sem taxa do Mercado Pago e sem frete. Entra no financeiro normalmente.
router.post('/resellers/:id/liberar-placas', (req, res) => {
  const rev = db.prepare('SELECT id, name FROM resellers WHERE id = ?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Revendedor não encontrado.' });
  const b = req.body || {}, qa = Number(b.qty_azul) || 0, qp = Number(b.qty_preta) || 0, qtd = qa + qp;
  if (!Number.isInteger(qa) || !Number.isInteger(qp) || qa < 0 || qp < 0 || qtd < 1 || qtd > 5000) return res.status(400).json({ error: 'Informe quantas placas azuis e/ou pretas (ao menos 1).' });
  let unit = String(b.unit_price ?? '').trim() === '' ? null : lerValor(b.unit_price);
  if (unit === false || (unit !== null && (unit < 0 || unit > 1000))) return res.status(400).json({ error: 'Preço por placa inválido. Use reais, ex.: 17,50.' });
  if (unit === null) { const t = db.prepare('SELECT * FROM price_tiers ORDER BY min_qty').all(); const f = t.find(x => qtd >= x.min_qty && qtd <= x.max_qty); unit = f ? f.unit_price : (t.length ? (qtd > t[t.length - 1].max_qty ? t[t.length - 1].unit_price : t[0].unit_price) : 25); }
  const total = Math.round(unit * qtd * 100) / 100;
  const id = db.transaction(() => {
    const n = db.prepare(`INSERT INTO orders (reseller_id, qty_azul, qty_preta, unit_price, total, status, payment_method, shipping_fee, custo_frete_real, mp_fee, mp_net)
      VALUES (?, ?, ?, ?, ?, 'aguardando_pagamento', 'pix', 0, 0, 0, ?)`).run(rev.id, qa, qp, unit, total, total).lastInsertRowid;
    pedidos.marcarPago(n, { manual: true, nota: 'Liberação interna (pago por fora, entregue em mãos)' });
    db.prepare("UPDATE orders SET status='entregue', producao_at=datetime('now'), enviado_at=datetime('now'), entregue_at=datetime('now') WHERE id=?").run(n);
    return n;
  })();
  pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'placas_liberadas', detalhe: `${rev.name}: ${qa} azul + ${qp} preta a ${unit} = ${total}` });
  res.json(resposta(id));
});

// Lançar um orçamento aprovado e já pago como pedido: cria o pedido pago (gera as placas) e coloca em produção.
router.post('/orcamentos/:id/lancar', (req, res) => {
  const orc = db.prepare('SELECT * FROM orcamentos WHERE id = ?').get(req.params.id);
  if (!orc) return res.status(404).json({ error: 'Orçamento não encontrado.' });
  const b = req.body || {}, nota = `Orçamento N ${String(orc.id).padStart(4, '0')}`;
  const ja = db.prepare('SELECT id FROM orders WHERE payment_note LIKE ?').get(nota + '%');
  if (ja) return res.status(409).json({ error: `Este orçamento já foi lançado como pedido #${String(ja.id).padStart(5, '0')}.` });
  const rev = db.prepare('SELECT id FROM resellers WHERE id = ?').get(Number(b.reseller_id));
  if (!rev) return res.status(400).json({ error: 'Escolha o revendedor que vai receber as placas.' });
  const qa = Number(b.qty_azul) || 0, qp = Number(b.qty_preta) || 0;
  if (!Number.isInteger(qa) || !Number.isInteger(qp) || qa < 0 || qp < 0 || qa + qp < 1) return res.status(400).json({ error: 'Informe quantas placas azuis e/ou pretas (ao menos 1).' });
  const itens = JSON.parse(orc.itens || '[]'), sub = itens.reduce((a, i) => a + i.qtd * i.unit, 0);
  const total = Math.round((sub + orc.frete - orc.desconto) * 100) / 100, frete = orc.frete || 0;
  const unit = Math.round(((total - frete) / (qa + qp)) * 100) / 100;
  const metodo = ['pix', 'credit_card'].includes(b.payment_method) ? b.payment_method : 'pix';
  const id = db.transaction(() => {
    const n = db.prepare(`INSERT INTO orders (reseller_id, qty_azul, qty_preta, unit_price, total, status, payment_method, shipping_fee, ship_name, ship_phone, ship_cep, ship_city, ship_state)
      VALUES (?, ?, ?, ?, ?, 'aguardando_pagamento', ?, ?, ?, ?, ?, ?, ?)`).run(rev.id, qa, qp, unit, total, metodo, frete, orc.cliente_nome, orc.cliente_tel || null, orc.cliente_cep || null, orc.cliente_cidade || null, orc.cliente_uf || null).lastInsertRowid;
    pedidos.marcarPago(n, { manual: true, nota: nota + ' (pago fora do checkout)' });
    iniciarProducao(n);
    return n;
  })();
  pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'orcamento_lancado', detalhe: `${nota} → pedido #${id}, ${qa} azul + ${qp} preta, total ${total}` });
  db.prepare("UPDATE orcamentos SET status='aprovado', atualizado_em=datetime('now') WHERE id=?").run(orc.id);
  res.json(resposta(id));
});

// Marcar como enviado, com o código de rastreio dos Correios.
router.post('/orders/:id/enviar', (req, res) => {
  const id = Number(req.params.id);
  const o = pegar(id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!['pago', 'em_producao'].includes(o.status)) {
    return res.status(409).json({ error: o.status === 'aguardando_pagamento' ? 'Este pedido ainda não foi pago. Confirme o pagamento antes de enviar.' : 'Este pedido não está na fila de envio.' });
  }
  const r = pedidos.lerRastreio(req.body);
  if (r.erro) return res.status(400).json({ error: r.erro });
  const outro = db.prepare('SELECT id FROM orders WHERE tracking_code = ? AND id <> ?').get(r.codigo, id);
  if (outro) return res.status(409).json({ error: `Este código de rastreio já foi usado no pedido #${String(outro.id).padStart(5, '0')}.` });
  const custo = lerCusto((req.body || {}).custo_frete);
  if (custo === false) return res.status(400).json({ error: 'Custo do frete inválido. Informe um valor em reais (ex.: 18,90) ou deixe em branco.' });
  db.prepare(`UPDATE orders SET status='enviado', enviado_at=datetime('now'), producao_at=COALESCE(producao_at, datetime('now')),
    tracking_code=?, shipping_service=?, custo_frete_real=COALESCE(?, custo_frete_real) WHERE id=?`).run(r.codigo, r.servico || null, custo, id);
  pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'status_enviado', detalhe: r.codigo });
  res.json(resposta(id));
});

// Corrigir o código/serviço de um pedido que já foi enviado.
router.put('/orders/:id/rastreio', (req, res) => {
  const id = Number(req.params.id);
  const o = pegar(id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!['enviado', 'entregue'].includes(o.status)) return res.status(409).json({ error: 'Só dá para editar o rastreio de pedidos enviados.' });
  const r = pedidos.lerRastreio(req.body);
  if (r.erro) return res.status(400).json({ error: r.erro });
  const outro = db.prepare('SELECT id FROM orders WHERE tracking_code = ? AND id <> ?').get(r.codigo, id);
  if (outro) return res.status(409).json({ error: `Este código de rastreio já foi usado no pedido #${String(outro.id).padStart(5, '0')}.` });
  const custo = lerCusto((req.body || {}).custo_frete);
  if (custo === false) return res.status(400).json({ error: 'Custo do frete inválido. Informe um valor em reais (ex.: 18,90) ou deixe em branco.' });
  db.prepare('UPDATE orders SET tracking_code=?, shipping_service=?, custo_frete_real=COALESCE(?, custo_frete_real) WHERE id=?').run(r.codigo, r.servico || null, custo, id);
  pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'rastreio_alterado', detalhe: r.codigo });
  res.json(resposta(id));
});

// Entregue. (Também vale para entrega em mãos, sem código de rastreio.)
router.post('/orders/:id/entregar', (req, res) => {
  const id = Number(req.params.id);
  const o = pegar(id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!['pago', 'em_producao', 'enviado'].includes(o.status)) return res.status(409).json({ error: 'Este pedido não pode ser marcado como entregue agora.' });
  db.prepare("UPDATE orders SET status='entregue', entregue_at=datetime('now') WHERE id=?").run(id);
  pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'status_entregue' });
  res.json(resposta(id));
});

// Desfaz a última etapa (para corrigir um clique errado).
router.post('/orders/:id/voltar', (req, res) => {
  const id = Number(req.params.id);
  const o = pegar(id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const sql = {
    em_producao: "UPDATE orders SET status='pago', producao_at=NULL WHERE id=?",
    enviado: "UPDATE orders SET status='em_producao', enviado_at=NULL, tracking_code=NULL, shipping_service=NULL WHERE id=?",
    entregue: "UPDATE orders SET status='enviado', entregue_at=NULL WHERE id=?",
  }[o.status];
  if (!sql) return res.status(409).json({ error: 'Não há etapa para desfazer neste pedido.' });
  db.prepare(sql).run(id);
  pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'etapa_desfeita', detalhe: o.status });
  res.json(resposta(id));
});

// Confere no Mercado Pago se o pagamento deste pedido já caiu (não depende do webhook).
router.post('/orders/:id/conferir', async (req, res) => {
  try { res.json(await pedidos.conferirPedido(Number(req.params.id), 'admin')); }
  catch (e) { console.error('[PAGAMENTO] conferência manual falhou:', e.message); res.status(502).json({ error: 'Não consegui falar com o Mercado Pago agora. Tente de novo em instantes.' }); }
});

// Confere todos os pedidos que aguardam pagamento.
router.post('/orders-conferir-todos', async (req, res) => {
  try { res.json(await pedidos.conferirPendentes(60, 'admin')); }
  catch (e) { res.status(502).json({ error: 'Não consegui falar com o Mercado Pago agora.' }); }
});

// Confirmação manual (ex.: o dinheiro entrou por outro meio). Exige uma observação para ficar registrado.
router.post('/orders/:id/confirmar-pagamento', (req, res) => {
  const nota = String((req.body || {}).observacao || '').trim().slice(0, 300);
  if (nota.length < 3) return res.status(400).json({ error: 'Descreva como o pagamento foi recebido (ex.: "Pix direto na conta em 02/10").' });
  const o = db.prepare('SELECT status FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!['aguardando_pagamento', 'cancelado'].includes(o.status)) return res.status(409).json({ error: 'Este pedido já está pago.' });
  pedidos.marcarPago(Number(req.params.id), { manual: true, nota });
  pedidos.registrarEvento({ origem: 'admin', order_id: Number(req.params.id), resultado: 'pago_manual', detalhe: nota });
  res.json({ ok: true });
});

// Pagamentos aprovados no Mercado Pago que não têm pedido no sistema (para o financeiro bater com o que você recebeu).
router.get('/mp-sem-pedido', async (req, res) => {
  try { res.json(await pedidos.pagamentosSemPedido()); }
  catch (e) { console.error('[PAGAMENTO] busca no MP falhou:', e.message); res.status(502).json({ error: 'Não consegui consultar o Mercado Pago agora.' }); }
});

// Últimas notificações/conferências de pagamento (para entender o que aconteceu com cada pedido).
router.get('/payment-events', (req, res) => {
  res.json(db.prepare('SELECT * FROM payment_events ORDER BY id DESC LIMIT 60').all());
});

// Editar o código (número) de uma placa. O revendedor passa a ver o novo código assim que abrir/atualizar "Minhas placas".
router.put('/plates/:id/codigo', (req, res) => {
  const pl = db.prepare('SELECT id, tracking_code FROM plates WHERE id = ?').get(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Placa não encontrada.' });
  const d = String((req.body || {}).codigo || '').replace(/\D/g, '');
  if (!d || d.length > 8) return res.status(400).json({ error: 'Informe o código com até 8 números, por exemplo 133 ou #00133.' });
  const codigo = '#' + d.padStart(5, '0');
  if (codigo === pl.tracking_code) return res.json({ ok: true, tracking_code: codigo });
  if (db.prepare('SELECT 1 FROM plates WHERE tracking_code = ? AND id <> ?').get(codigo, pl.id)) return res.status(409).json({ error: `O código ${codigo} já é de outra placa.` });
  if (db.prepare('SELECT 1 FROM qr_estoque WHERE numero = ? AND (plate_id IS NULL OR plate_id <> ?)').get(codigo, pl.id)) return res.status(409).json({ error: `O código ${codigo} já está reservado no estoque de QR.` });
  db.transaction(() => {
    db.prepare('UPDATE plates SET tracking_code = ? WHERE id = ?').run(codigo, pl.id);
    db.prepare('UPDATE qr_estoque SET numero = ? WHERE plate_id = ?').run(codigo, pl.id); // mantém o estoque de QR coerente com a placa
    pedidos.registrarEvento({ origem: 'admin', resultado: 'codigo_placa_editado', detalhe: `placa ${pl.id}: ${pl.tracking_code} → ${codigo}` });
  })();
  res.json({ ok: true, tracking_code: codigo });
});

// Renumerar várias placas de uma vez: linhas [{de, para}] (código atual → novo). aplicar=false só confere (prévia).
router.post('/placas/renumerar', (req, res) => {
  const b = req.body || {}, linhas = Array.isArray(b.linhas) ? b.linhas : [];
  if (!linhas.length) return res.status(400).json({ error: 'Cole ao menos uma linha, por exemplo: #00133 → #001746' });
  if (linhas.length > 2000) return res.status(400).json({ error: 'No máximo 2000 linhas por vez.' });
  const norm = v => { const d = String(v || '').replace(/\D/g, ''); return d && d.length <= 8 ? '#' + d.padStart(5, '0') : null; };
  const porCodigo = new Map(db.prepare('SELECT id, tracking_code, reseller_id FROM plates').all().map(p => [p.tracking_code, p]));
  const reservados = new Set(db.prepare("SELECT numero FROM qr_estoque WHERE plate_id IS NULL").all().map(r => r.numero));
  const itens = [], erros = [], vistosDe = new Set(), vistosPara = new Set();
  linhas.forEach((l, i) => {
    const de = norm(l && l.de), para = norm(l && l.para), n = i + 1;
    if (!de || !para) return erros.push(`Linha ${n}: código inválido.`);
    const pl = porCodigo.get(de);
    if (!pl) return erros.push(`Linha ${n}: não existe placa com o código ${de}.`);
    if (vistosDe.has(de)) return erros.push(`Linha ${n}: a placa ${de} aparece mais de uma vez.`);
    if (vistosPara.has(para)) return erros.push(`Linha ${n}: o código ${para} aparece mais de uma vez como novo.`);
    vistosDe.add(de); vistosPara.add(para);
    itens.push({ id: pl.id, de, para });
  });
  const mudando = new Set(itens.map(x => x.de));
  itens.forEach(x => {
    if (x.de === x.para) return;
    const dono = porCodigo.get(x.para);
    if (dono && !mudando.has(x.para)) erros.push(`O código ${x.para} (novo da placa ${x.de}) já é de outra placa que não está na lista.`);
    if (reservados.has(x.para)) erros.push(`O código ${x.para} (novo da placa ${x.de}) está reservado no estoque de QR.`);
  });
  const alvo = itens.filter(x => x.de !== x.para);
  if (erros.length || b.aplicar !== true) return res.json({ ok: !erros.length, aplicado: false, total: alvo.length, erros: erros.slice(0, 50), itens: alvo.slice(0, 50) });
  db.transaction(() => {
    alvo.forEach(x => { // passo 1: libera os números (trocas entre placas não colidem)
      db.prepare('UPDATE plates SET tracking_code = ? WHERE id = ?').run('~' + x.id, x.id);
      db.prepare('UPDATE qr_estoque SET numero = ? WHERE plate_id = ?').run('~' + x.id, x.id);
    });
    alvo.forEach(x => {
      db.prepare('UPDATE plates SET tracking_code = ? WHERE id = ?').run(x.para, x.id);
      db.prepare('UPDATE qr_estoque SET numero = ? WHERE plate_id = ?').run(x.para, x.id);
    });
    pedidos.registrarEvento({ origem: 'admin', resultado: 'placas_renumeradas', detalhe: `${alvo.length} placa(s): ` + alvo.slice(0, 8).map(x => `${x.de}→${x.para}`).join(', ') });
  })();
  res.json({ ok: true, aplicado: true, total: alvo.length, erros: [] });
});

router.get('/plates', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, r.name AS reseller_name
    FROM plates p JOIN resellers r ON r.id = p.reseller_id
    ORDER BY p.id DESC
  `).all();
  const base = require('./exportar-placas.js').baseUrl(req); // mesmo endereço que vai no QR/NFC (SITE_HOST)
  res.json(rows.map(p => ({ ...p, link: `${base}/r/${p.code}` })));
});

router.get('/price-tiers', (req, res) => {
  res.json(db.prepare('SELECT * FROM price_tiers ORDER BY min_qty').all());
});

router.post('/price-tiers', (req, res) => {
  const { tiers } = req.body || {};
  if (!Array.isArray(tiers) || !tiers.length) return res.status(400).json({ error: 'Tabela inválida.' });
  const valid = tiers.every(t =>
    Number.isInteger(t.min_qty) && Number.isInteger(t.max_qty) &&
    t.min_qty >= 1 && t.max_qty >= t.min_qty &&
    typeof t.unit_price === 'number' && t.unit_price > 0);
  if (!valid) return res.status(400).json({ error: 'Faixas inválidas (quantidades inteiras e preço maior que zero).' });
  const del = db.prepare('DELETE FROM price_tiers');
  const ins = db.prepare('INSERT INTO price_tiers (min_qty, max_qty, unit_price) VALUES (?, ?, ?)');
  const tx = db.transaction((list) => {
    del.run();
    list.forEach(t => ins.run(t.min_qty, t.max_qty, t.unit_price));
  });
  tx(tiers);
  res.json({ ok: true });
});

// Fornecedores, estoque, despesas, custos e lucro estimado
router.use('/gestao', require('./routes-gestao.js'));

module.exports = router;
