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
  const parcRec = db.prepare("SELECT COALESCE(SUM(r.valor),0) AS s FROM order_recebimentos r JOIN orders o ON o.id = r.order_id WHERE o.status IN ('pago','em_producao','enviado','entregue')").get().s;
  const faturamento = Math.round((db.prepare("SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE status IN ('pago','em_producao','enviado','entregue') AND a_receber = 0 AND id NOT IN (SELECT order_id FROM order_recebimentos)").get().s + parcRec) * 100) / 100;
  const pendentes = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='aguardando_pagamento'").get().n;
  const placas = db.prepare('SELECT COUNT(*) AS n FROM plates WHERE order_id IS NOT NULL').get().n;
  const ativas = db.prepare("SELECT COUNT(*) AS n FROM plates WHERE status='ativa'").get().n;
  const aReceber = Math.round((db.prepare("SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE status='aguardando_pagamento' OR (a_receber = 1 AND status IN ('pago','em_producao','enviado','entregue'))").get().s
    - db.prepare("SELECT COALESCE(SUM(r.valor),0) AS s FROM order_recebimentos r JOIN orders o ON o.id = r.order_id WHERE o.a_receber = 1 AND o.status IN ('pago','em_producao','enviado','entregue')").get().s) * 100) / 100;
  const pagos = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('pago','em_producao','enviado','entregue') AND a_receber = 0").get().n;
  const freteCobrado = db.prepare("SELECT COALESCE(SUM(shipping_fee),0) AS s FROM orders WHERE status IN ('pago','em_producao','enviado','entregue') AND a_receber = 0").get().s;
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

// Cortesia: gerador de links ilimitado e biosite sem cobrança para este revendedor (ligar/desligar).
router.post('/resellers/:id/cortesia', (req, res) => {
  const rev = db.prepare('SELECT id, name FROM resellers WHERE id = ?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Revendedor não encontrado.' });
  const on = (req.body || {}).ativo ? 1 : 0;
  db.prepare('UPDATE resellers SET cortesia = ? WHERE id = ?').run(on, rev.id);
  pedidos.registrarEvento({ origem: 'admin', resultado: on ? 'cortesia_ligada' : 'cortesia_desligada', detalhe: rev.name });
  res.json({ ok: true, cortesia: on });
});

// Zerar as placas de teste de uma conta: apaga só as placas SEM pedido (as de teste). Placas de pedidos reais nunca são tocadas.
router.post('/resellers/:id/zerar-placas-teste', (req, res) => {
  const rev = db.prepare('SELECT id, name FROM resellers WHERE id = ?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Revendedor não encontrado.' });
  const ids = db.prepare('SELECT id FROM plates WHERE reseller_id = ? AND order_id IS NULL').all(rev.id).map(p => p.id);
  if (req.body && req.body.somente_contar) return res.json({ ok: true, total: ids.length });
  db.transaction(() => ids.forEach(id => {
    db.prepare("UPDATE qr_estoque SET status='livre', plate_id=NULL, usado_em=NULL WHERE plate_id = ?").run(id);
    db.prepare('DELETE FROM plate_reads WHERE plate_id = ?').run(id);
    db.prepare('UPDATE sales SET plate_id = NULL WHERE plate_id = ?').run(id);
    db.prepare('DELETE FROM plates WHERE id = ?').run(id);
  }))();
  pedidos.registrarEvento({ origem: 'admin', resultado: 'placas_teste_zeradas', detalhe: `${rev.name}: ${ids.length} placa(s)` });
  res.json({ ok: true, total: ids.length });
});

// Serviço "Link de Avaliação do Google": assinantes, faturamento e uso.
router.get('/google-servico', (req, res) => {
  const gl = require('./google-plano.js');
  const rs = db.prepare(`SELECT r.id, r.name, r.email, r.gl_plano, r.gl_ate, r.created_at, r.cortesia,
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
  const ativos = rs.filter(x => x.vigente && !x.cortesia);
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

// Convite do grupo/comunidade de ofertas no WhatsApp. O WhatsApp não permite adicionar pessoas sozinho: o revendedor entra clicando no convite.
const gSet = db.prepare('SELECT valor FROM settings WHERE chave = ?'), gPut = db.prepare('INSERT INTO settings (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor');
const gGet = (k, d = '') => { const r = gSet.get(k); return r ? r.valor : d; };
// Grupo atual de ofertas (80 pessoas): vira o convite padrão; se o admin trocar o link no painel, a troca vale.
db.prepare("INSERT OR IGNORE INTO settings (chave, valor) VALUES ('grupo_link', 'https://chat.whatsapp.com/LE4mSgrx5q3L52520KZJ7c')").run();
router.get('/grupo', (req, res) => {
  const t = db.prepare("SELECT COUNT(*) n, SUM(grupo_clicou_em IS NOT NULL) c FROM resellers").get();
  res.json({ link: gGet('grupo_link'), nome: gGet('grupo_nome', 'Grupo de ofertas NexTap'), texto: gGet('grupo_texto', 'Receba as ofertas e promoções diárias das placas NexTap em primeira mão.'),
    msg: gGet('grupo_msg', 'Oi, {nome}! 👋 Aqui é da NexTap. Criamos o grupo de ofertas diárias das placas NFC para os revendedores. Entra por aqui: {link}'), total: t.n, clicaram: t.c || 0 });
});
router.post('/resellers/:id/convidado', (req, res) => {
  const r = db.prepare("UPDATE resellers SET grupo_convidado_em = COALESCE(grupo_convidado_em, datetime('now')) WHERE id = ?").run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Revendedor não encontrado.' });
  res.json({ ok: true });
});
router.put('/grupo', (req, res) => {
  const b = req.body || {}, link = String(b.link || '').trim();
  if (link && !/^https:\/\/(chat\.whatsapp\.com\/[A-Za-z0-9_-]{10,}|(www\.)?whatsapp\.com\/channel\/[A-Za-z0-9_-]{6,})\/?(\?.*)?$/.test(link)) return res.status(400).json({ error: 'Link inválido. Use o link de convite do grupo (https://chat.whatsapp.com/…) ou do canal (https://whatsapp.com/channel/…).' });
  gPut.run('grupo_link', link);
  if (b.nome !== undefined) gPut.run('grupo_nome', String(b.nome).trim().slice(0, 80) || 'Grupo de ofertas NexTap');
  if (b.texto !== undefined) gPut.run('grupo_texto', String(b.texto).trim().slice(0, 200));
  if (b.msg !== undefined) gPut.run('grupo_msg', String(b.msg).trim().slice(0, 500));
  res.json({ ok: true });
});
router.get('/resellers', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.name, r.email, r.whatsapp, r.addr_city, r.addr_state, r.created_at, r.cortesia, r.grupo_clicou_em, r.grupo_convidado_em,
      (SELECT COUNT(*) FROM orders o WHERE o.reseller_id=r.id) AS pedidos,
      ((SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.reseller_id=r.id AND o.a_receber=0 AND o.status IN ('pago','em_producao','enviado','entregue') AND o.id NOT IN (SELECT order_id FROM order_recebimentos))
       + (SELECT COALESCE(SUM(x.valor),0) FROM order_recebimentos x JOIN orders o ON o.id = x.order_id WHERE o.reseller_id=r.id AND o.status IN ('pago','em_producao','enviado','entregue'))) AS gasto,
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
  const b = req.body || {}, qa = Number(b.qty_azul) || 0, qp = Number(b.qty_preta) || 0;
  // Demais modelos (Pix, Redes sociais, Instagram, WhatsApp…): [{ produto_id, qty }]
  const itens = [];
  for (const it of (Array.isArray(b.itens) ? b.itens : [])) {
    const pid = Number(it && it.produto_id), q = Number(it && it.qty) || 0;
    if (!q) continue;
    if (!Number.isInteger(pid) || !Number.isInteger(q) || q < 0 || q > 5000) return res.status(400).json({ error: 'Quantidade inválida em um dos modelos.' });
    const p = db.prepare("SELECT id, nome FROM produtos WHERE id = ? AND categoria LIKE 'Placas%'").get(pid);
    if (!p) return res.status(400).json({ error: 'Um dos modelos escolhidos não existe no catálogo.' });
    const ja = itens.find(x => x.produto_id === pid);
    if (ja) ja.qty += q; else itens.push({ produto_id: p.id, nome: p.nome, qty: q });
  }
  const qo = itens.reduce((s, x) => s + x.qty, 0), qtd = qa + qp + qo;
  if (!Number.isInteger(qa) || !Number.isInteger(qp) || qa < 0 || qp < 0 || qtd < 1 || qtd > 5000) return res.status(400).json({ error: 'Informe quantas placas de cada modelo (ao menos 1).' });
  const obs = String(b.obs || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  let unit = String(b.unit_price ?? '').trim() === '' ? null : lerValor(b.unit_price);
  if (unit === false || (unit !== null && (unit < 0 || unit > 1000))) return res.status(400).json({ error: 'Preço por placa inválido. Use reais, ex.: 17,50.' });
  if (unit === null) { const t = db.prepare('SELECT * FROM price_tiers ORDER BY min_qty').all(); const f = t.find(x => qtd >= x.min_qty && qtd <= x.max_qty); unit = f ? f.unit_price : (t.length ? (qtd > t[t.length - 1].max_qty ? t[t.length - 1].unit_price : t[0].unit_price) : 25); }
  const total = Math.round(unit * qtd * 100) / 100;
  const id = db.transaction(() => {
    const n = db.prepare(`INSERT INTO orders (reseller_id, qty_azul, qty_preta, qty_outras, unit_price, total, status, payment_method, shipping_fee, custo_frete_real, mp_fee, mp_net, a_receber)
      VALUES (?, ?, ?, ?, ?, ?, 'aguardando_pagamento', 'pix', 0, 0, 0, ?, ?)`).run(rev.id, qa, qp, qo, unit, total, total, b.a_receber === false || b.a_receber === 0 || b.a_receber === '0' ? 0 : 1).lastInsertRowid;
    const insIt = db.prepare('INSERT INTO order_items (order_id, produto_id, nome, qty) VALUES (?, ?, ?, ?)');
    itens.forEach(x => insIt.run(n, x.produto_id, x.nome, x.qty));
    pedidos.marcarPago(n, { manual: true, nota: 'Liberação interna (pago por fora, entregue em mãos)' + (obs ? ' · ' + obs : '') });
    db.prepare("UPDATE orders SET status='entregue', producao_at=datetime('now'), enviado_at=datetime('now'), entregue_at=datetime('now') WHERE id=?").run(n);
    return n;
  })();
  pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'placas_liberadas', detalhe: `${rev.name}: ${qa} azul + ${qp} preta` + itens.map(x => ` + ${x.qty} ${x.nome}`).join('') + ` a ${unit} = ${total}` + (obs ? ' · ' + obs : '') });
  res.json(resposta(id));
});

// Endereço de entrega do pedido (usado na etiqueta). Pode ser corrigido a qualquer momento antes de comprar a etiqueta.
router.put('/orders/:id/endereco', (req, res) => {
  const o = pegar(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const b = req.body || {}, t = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const cep = String(b.cep || '').replace(/\D/g, ''), uf = t(b.state, 2).toUpperCase();
  const e = { name: t(b.name, 120), phone: String(b.phone || '').replace(/\D/g, '').slice(0, 13), street: t(b.street, 150), number: t(b.number, 20) || 'S/N',
    complement: t(b.complement, 80), district: t(b.district, 80), city: t(b.city, 80) };
  if (cep.length !== 8) return res.status(400).json({ error: 'CEP inválido: informe os 8 números.' });
  if (!e.street) return res.status(400).json({ error: 'Informe a rua.' });
  if (!e.district) return res.status(400).json({ error: 'Informe o bairro.' });
  if (!e.city) return res.status(400).json({ error: 'Informe a cidade.' });
  if (!/^[A-Z]{2}$/.test(uf)) return res.status(400).json({ error: 'Informe a UF com 2 letras (ex.: CE).' });
  const doc = String(b.doc || '').replace(/\D/g, '');
  if (doc && doc.length !== 11 && doc.length !== 14) return res.status(400).json({ error: 'CPF/CNPJ inválido.' });
  db.prepare(`UPDATE orders SET ship_name = COALESCE(NULLIF(?, ''), ship_name), ship_phone = COALESCE(NULLIF(?, ''), ship_phone), ship_cep = ?, ship_street = ?, ship_number = ?,
    ship_complement = ?, ship_district = ?, ship_city = ?, ship_state = ?, ship_doc = COALESCE(NULLIF(?, ''), ship_doc),
    me_erro = CASE WHEN me_erro LIKE '%endere%' OR me_erro LIKE '%CEP%' THEN NULL ELSE me_erro END WHERE id = ?`)
    .run(e.name, e.phone, cep, e.street, e.number, e.complement, e.district, e.city, uf, doc, o.id);
  pedidos.registrarEvento({ origem: 'admin', order_id: o.id, resultado: 'endereco_editado', detalhe: `${e.street}, ${e.number} - ${e.city}/${uf} (${cep})` });
  res.json(resposta(o.id));
});
// Recebi o dinheiro de um pedido "a receber": passa a contar no faturamento e no lucro a partir de hoje.
// Se já houve recebimentos parciais, registra só o que falta.
const restante = o => Math.round((o.total - db.prepare('SELECT COALESCE(SUM(valor),0) s FROM order_recebimentos WHERE order_id = ?').get(o.id).s) * 100) / 100;
router.post('/orders/:id/recebido', (req, res) => {
  const o = pegar(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!o.a_receber) return res.status(409).json({ error: 'Este pedido não está marcado como a receber.' });
  db.transaction(() => {
    const ja = db.prepare('SELECT COUNT(*) n FROM order_recebimentos WHERE order_id = ?').get(o.id).n;
    const falta = restante(o);
    if (ja && falta > 0) db.prepare("INSERT INTO order_recebimentos (order_id, valor, obs) VALUES (?, ?, 'Saldo restante')").run(o.id, falta);
    db.prepare("UPDATE orders SET a_receber = 0, recebido_em = datetime('now'), paid_at = datetime('now') WHERE id = ?").run(o.id);
  })();
  pedidos.registrarEvento({ origem: 'admin', order_id: o.id, resultado: 'recebido', detalhe: `R$ ${o.total}` });
  res.json(resposta(o.id));
});
// Recebimento PARCIAL: registra quanto entrou e a data; o pedido segue "a receber" pelo restante. Quando o restante zera, vira recebido.
router.post('/orders/:id/recebimento', (req, res) => {
  const o = pegar(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!o.a_receber) return res.status(409).json({ error: 'Este pedido não está marcado como a receber.' });
  const b = req.body || {}, falta = restante(o);
  const valor = lerValor(b.valor);
  if (valor === false || valor === null || !(valor > 0)) return res.status(400).json({ error: 'Informe o valor recebido, ex.: 150,00.' });
  if (valor > falta + 0.004) return res.status(400).json({ error: `O valor passa do que falta receber (R$ ${falta.toFixed(2).replace('.', ',')}).` });
  let data = null;
  if (b.data) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b.data));
    const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!m || d.getUTCMonth() !== +m[2] - 1 || d.getTime() > Date.now() + 864e5) return res.status(400).json({ error: 'Data inválida.' });
    // hoje (Brasília) usa o horário real; outro dia fica às 12h de Brasília
    data = b.data === new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10) ? null : `${m[1]}-${m[2]}-${m[3]} 15:00:00`;
  }
  const obs = String(b.obs || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  db.transaction(() => {
    db.prepare("INSERT INTO order_recebimentos (order_id, valor, data, obs) VALUES (?, ?, COALESCE(?, datetime('now')), ?)").run(o.id, Math.round(valor * 100) / 100, data, obs);
    if (restante(o) <= 0.004) db.prepare("UPDATE orders SET a_receber = 0, recebido_em = datetime('now'), paid_at = datetime('now') WHERE id = ?").run(o.id);
  })();
  pedidos.registrarEvento({ origem: 'admin', order_id: o.id, resultado: 'recebimento_parcial', detalhe: `R$ ${valor}${obs ? ' · ' + obs : ''}` });
  res.json(resposta(o.id));
});
// Desfazer um recebimento parcial lançado por engano (se o pedido já estava quitado, volta a ficar "a receber").
router.delete('/orders/recebimento/:rid', (req, res) => {
  const r = db.prepare('SELECT * FROM order_recebimentos WHERE id = ?').get(req.params.rid);
  if (!r) return res.status(404).json({ error: 'Recebimento não encontrado.' });
  db.transaction(() => {
    db.prepare('DELETE FROM order_recebimentos WHERE id = ?').run(r.id);
    db.prepare("UPDATE orders SET a_receber = 1, recebido_em = NULL WHERE id = ?").run(r.order_id);
  })();
  pedidos.registrarEvento({ origem: 'admin', order_id: r.order_id, resultado: 'recebimento_desfeito', detalhe: `R$ ${r.valor}` });
  res.json(resposta(r.order_id));
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

// Muda o modelo de uma placa e ajusta a contagem do pedido de origem (usado na troca de modelo e na permuta de placas)
function trocarModelo(pl, novo) {
  const velho = pl.color, ehCor = c => c === 'azul' || c === 'preta';
  let prod = ehCor(novo) ? null : db.prepare("SELECT id, nome FROM produtos WHERE nome = ?").get(novo);
    db.prepare('UPDATE plates SET color = ? WHERE id = ?').run(novo, pl.id);
    db.prepare('UPDATE qr_estoque SET cor = ? WHERE plate_id = ?').run(novo, pl.id);
    if (pl.order_id) {
      const o = db.prepare('SELECT qty_azul, qty_preta, qty_outras FROM orders WHERE id = ?').get(pl.order_id);
      if (o) {
        // tira 1 do modelo antigo
        if (velho === 'azul' && o.qty_azul > 0) db.prepare('UPDATE orders SET qty_azul = qty_azul - 1 WHERE id = ?').run(pl.order_id);
        else if (velho === 'preta' && o.qty_preta > 0) db.prepare('UPDATE orders SET qty_preta = qty_preta - 1 WHERE id = ?').run(pl.order_id);
        else if (!ehCor(velho)) {
          const it = db.prepare('SELECT id, qty FROM order_items WHERE order_id = ? AND nome = ?').get(pl.order_id, velho);
          if (it) { if (it.qty > 1) db.prepare('UPDATE order_items SET qty = qty - 1 WHERE id = ?').run(it.id); else db.prepare('DELETE FROM order_items WHERE id = ?').run(it.id); }
          if (o.qty_outras > 0) db.prepare('UPDATE orders SET qty_outras = qty_outras - 1 WHERE id = ?').run(pl.order_id);
        }
        // põe 1 no modelo novo
        if (novo === 'azul') db.prepare('UPDATE orders SET qty_azul = qty_azul + 1 WHERE id = ?').run(pl.order_id);
        else if (novo === 'preta') db.prepare('UPDATE orders SET qty_preta = qty_preta + 1 WHERE id = ?').run(pl.order_id);
        else if (prod) {
          const it = db.prepare('SELECT id FROM order_items WHERE order_id = ? AND nome = ?').get(pl.order_id, prod.nome);
          if (it) db.prepare('UPDATE order_items SET qty = qty + 1 WHERE id = ?').run(it.id);
          else db.prepare('INSERT INTO order_items (order_id, produto_id, nome, qty) VALUES (?, ?, ?, 1)').run(pl.order_id, prod.id, prod.nome);
          db.prepare('UPDATE orders SET qty_outras = qty_outras + 1 WHERE id = ?').run(pl.order_id);
        }
      }
    }
}
// Trocar o MODELO de uma placa já emitida (ex.: cadastrada como "azul", mas é a do Instagram).
// Muda o modelo da placa, o do QR no estoque e a contagem do pedido de origem (azul/preta/outros modelos), sem mexer em valores.
router.put('/plates/:id/modelo', (req, res) => {
  const pl = db.prepare('SELECT id, order_id, color, tracking_code FROM plates WHERE id = ?').get(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Placa não encontrada.' });
  const novo = String((req.body || {}).modelo || '').trim();
  let prod = null;
  if (novo !== 'azul' && novo !== 'preta') {
    prod = db.prepare("SELECT id, nome FROM produtos WHERE nome = ? AND categoria LIKE 'Placas%'").get(novo);
    if (!prod) return res.status(400).json({ error: 'Modelo não encontrado no catálogo.' });
  }
  if (novo === pl.color) return res.json({ ok: true, color: novo });
  const velho = pl.color;
  db.transaction(() => {
    trocarModelo(pl, novo);
    pedidos.registrarEvento({ origem: 'admin', order_id: pl.order_id || null, resultado: 'modelo_placa_trocado', detalhe: `placa ${pl.tracking_code || pl.id}: "${velho}" → "${novo}"` });
  })();
  res.json({ ok: true, color: novo });
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

// Pedidos com placas faltando (o pedido tem X placas e foram geradas menos): por modelo
function faltasDoPedido(o) {
  const esperado = {}; if (o.qty_azul) esperado.azul = o.qty_azul; if (o.qty_preta) esperado.preta = o.qty_preta;
  for (const it of db.itensPedido(o.id)) esperado[it.nome] = (esperado[it.nome] || 0) + it.qty;
  const tem = {}; for (const r of db.prepare("SELECT color, COUNT(*) AS n FROM plates WHERE order_id = ? GROUP BY color").all(o.id)) tem[r.color] = r.n;
  const falta = {}; for (const [m, n] of Object.entries(esperado)) if (n > (tem[m] || 0)) falta[m] = n - (tem[m] || 0);
  return falta;
}
router.get('/pedidos/faltando-placas', (req, res) => {
  const L = db.prepare(`SELECT o.*, r.name AS revendedor FROM orders o JOIN resellers r ON r.id = o.reseller_id WHERE o.status IN ('pago','em_producao') ORDER BY o.id DESC LIMIT 300`).all();
  const livres = db.prepare("SELECT numero, cor FROM qr_estoque WHERE status = 'livre' AND plate_id IS NULL").all().map(q => ({ ...q, n: Number(String(q.numero).replace(/\D/g, '')) }));
  const num = c => Number(String(c || '').replace(/\D/g, ''));
  // Sugestão: para cada modelo que falta, os QR livres do estoque mais perto dos números que o pedido já tem (de preferência do mesmo modelo)
  const sugerir = (o, falta) => {
    const meus = db.prepare('SELECT tracking_code FROM plates WHERE order_id = ?').all(o.id).map(p => num(p.tracking_code)).filter(Boolean), usados = new Set(), out = [];
    const dist = q => meus.length ? Math.min(...meus.map(m => Math.abs(m - q.n))) : q.n;
    for (const [modelo, qtd] of Object.entries(falta)) {
      const cand = livres.filter(q => !usados.has(q.numero)).sort((a, b) => (a.cor === modelo ? 0 : 1) - (b.cor === modelo ? 0 : 1) || dist(a) - dist(b));
      for (const q of cand.slice(0, qtd)) { usados.add(q.numero); out.push(q.numero); }
    }
    return out;
  };
  res.json(L.map(o => { const falta = faltasDoPedido(o); return { id: o.id, revendedor: o.revendedor, status: o.status, falta, sugestao: Object.keys(falta).length ? sugerir(o, falta) : [] }; }).filter(o => Object.keys(o.falta).length));
});
// Completar um pedido com placas que estão no estoque de QR (ex.: #02691 e #02692 eram dele e voltaram ao estoque)
router.post('/pedidos/:id/completar', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const norm = v => { const d = String(v || '').replace(/\D/g, ''); return d && d.length <= 8 ? '#' + d.padStart(5, '0') : null; };
  const nums = [...new Set((Array.isArray(req.body.numeros) ? req.body.numeros : String(req.body.numeros || '').split(/[\s,;]+/)).map(norm).filter(Boolean))];
  if (!nums.length) return res.status(400).json({ error: 'Informe os números das placas do estoque, por exemplo #02691 #02692.' });
  const falta = faltasDoPedido(o), totalFalta = Object.values(falta).reduce((a, b) => a + b, 0);
  if (!totalFalta) return res.status(400).json({ error: `O pedido #${o.id} já está completo.` });
  if (nums.length > totalFalta) return res.status(400).json({ error: `O pedido #${o.id} só tem ${totalFalta} placa(s) faltando.` });
  const erros = [], plano = [], restante = { ...falta };
  for (const n of nums) {
    const q = db.prepare('SELECT * FROM qr_estoque WHERE numero = ?').get(n);
    if (!q) { erros.push(`${n} não está no estoque de QR.`); continue; }
    if (q.plate_id || q.status !== 'livre') { const pl = q.plate_id && db.prepare('SELECT p.tracking_code, r.name FROM plates p JOIN resellers r ON r.id = p.reseller_id WHERE p.id = ?').get(q.plate_id); erros.push(`${n} não está livre${pl ? ` (é de ${pl.name})` : ''}.`); continue; }
    const modelo = restante[q.cor] ? q.cor : Object.keys(restante).find(m => restante[m] > 0);
    restante[modelo]--; plano.push({ q, modelo, aviso: modelo !== q.cor ? `${n} estava no estoque como "${q.cor}" e entra como "${modelo}".` : '' });
  }
  if (erros.length) return res.status(400).json({ error: erros.join(' ') });
  if (req.body.aplicar !== true) return res.json({ ok: true, aplicado: false, falta, itens: plano.map(x => ({ numero: x.q.numero, modelo: x.modelo, aviso: x.aviso })) });
  db.transaction(() => {
    for (const x of plano) {
      const r = db.prepare("INSERT INTO plates (reseller_id, order_id, code, color, status, cost) VALUES (?, ?, ?, ?, 'estoque', ?)").run(o.reseller_id, o.id, x.q.code, x.modelo, o.unit_price);
      db.prepare('UPDATE plates SET tracking_code = ? WHERE id = ?').run(x.q.numero, r.lastInsertRowid);
      db.prepare("UPDATE qr_estoque SET status = 'usada', usado_em = datetime('now'), plate_id = ?, cor = ? WHERE id = ?").run(r.lastInsertRowid, x.modelo, x.q.id);
    }
    pedidos.registrarEvento({ origem: 'admin', order_id: o.id, resultado: 'pedido_completado_estoque', detalhe: plano.map(x => `${x.q.numero} (${x.modelo})`).join(', ') });
  })();
  res.json({ ok: true, aplicado: true, total: plano.length, falta: faltasDoPedido(o) });
});

// Renumerar várias placas de uma vez: linhas [{de, para}] (código atual → novo). aplicar=false só confere (prévia).
router.post('/placas/renumerar', (req, res) => {
  const b = req.body || {}, linhas = Array.isArray(b.linhas) ? b.linhas : [];
  if (!linhas.length) return res.status(400).json({ error: 'Cole ao menos uma linha, por exemplo: #00133 → #001746' });
  if (linhas.length > 2000) return res.status(400).json({ error: 'No máximo 2000 linhas por vez.' });
  const norm = v => { const d = String(v || '').replace(/\D/g, ''); return d && d.length <= 8 ? '#' + d.padStart(5, '0') : null; };
  const porCodigo = new Map(db.prepare('SELECT p.id, p.tracking_code, p.reseller_id, p.status, p.order_id, p.color, p.code, r.name AS revendedor, o.status AS pedido_status FROM plates p LEFT JOIN resellers r ON r.id = p.reseller_id LEFT JOIN orders o ON o.id = p.order_id').all().map(p => [p.tracking_code, p]));
  const reservados = new Set(db.prepare("SELECT numero FROM qr_estoque WHERE plate_id IS NULL").all().map(r => r.numero));
  // "Trocar por placa do estoque": a placa passa a usar o QR (número e link) de uma placa livre do estoque; o QR antigo volta ao estoque.
  const usarEstoque = b.estoque === true;
  const livres = new Map(db.prepare("SELECT id, numero, code, cor FROM qr_estoque WHERE status = 'livre' AND plate_id IS NULL").all().map(r => [r.numero, r]));
  const itens = [], erros = [], avisos = [], vistosDe = new Set(), vistosPara = new Set();
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
    if (dono && !mudando.has(x.para)) {
      // Permuta: o número novo é de outra placa (de outro revendedor) que ainda não foi configurada nem enviada → as duas trocam de lugar
      if (dono.status === 'ativa') return erros.push(`O código ${x.para} (novo da placa ${x.de}) é de uma placa já configurada (${dono.revendedor || 'outro revendedor'}). Não dá para trocar.`);
      if (['enviado', 'entregue'].includes(dono.pedido_status)) return erros.push(`O código ${x.para} (novo da placa ${x.de}) é de uma placa já enviada (${dono.revendedor || 'outro revendedor'}). Não dá para trocar.`);
      if (vistosPara.has(x.de)) return erros.push(`Não dá para trocar ${x.de} ↔ ${x.para}: o código ${x.de} já vai para outra placa da lista.`);
      const meu = porCodigo.get(x.de);
      if (usarEstoque && String(meu.color) !== String(dono.color) && b.modelo !== true) return erros.push(`Modelo diferente: a placa ${x.de} é "${meu.color}" e a ${x.para} é "${dono.color}". Para trocar o modelo junto, marque "Permitir trocar o modelo".`);
      x.permuta = dono; vistosPara.add(x.de);
      avisos.push(usarEstoque ? `Troca: a placa física ${x.para} (com o QR dela${meu.color !== dono.color ? ', modelo "' + dono.color + '"' : ''}) vai para ${meu.revendedor || 'o revendedor de ' + x.de}, e a ${x.de} vai para ${dono.revendedor || 'o outro revendedor'}.` : `Troca de número: a placa de ${dono.revendedor || 'outro revendedor'} que era ${x.para} passa a ser ${x.de}.`);
      return;
    }
    if (reservados.has(x.para)) {
      if (!usarEstoque) return erros.push(`O código ${x.para} (novo da placa ${x.de}) está no estoque de QR. Para usar essa placa do estoque, marque "Trocar por placas do estoque".`);
      const q = livres.get(x.para); if (!q) return erros.push(`O código ${x.para} não está livre no estoque de QR.`);
      const pl = db.prepare('SELECT id, color, status, code FROM plates WHERE id = ?').get(x.id);
      if (String(pl.color) !== String(q.cor)) {
        if (b.modelo !== true) return erros.push(`Modelo diferente: a placa ${x.de} é "${pl.color}" e o ${x.para} do estoque é "${q.cor}". Para trocar o modelo junto, marque "Permitir trocar o modelo".`);
        avisos.push(`A placa ${x.de} muda de "${pl.color}" para "${q.cor}": o estoque de "${pl.color}" ganha 1 e o de "${q.cor}" perde 1.`);
      }
      x.estoque = q; x.codigo_antigo = pl.code; x.cor_antiga = pl.color;
      if (pl.status === 'ativa') avisos.push(`A placa ${x.de} já está configurada: o QR/NFC antigo dela deixará de funcionar. Só continue se a placa física antiga não foi entregue.`);
      if (!db.prepare('SELECT 1 FROM qr_estoque WHERE plate_id = ?').get(x.id)) avisos.push(`A placa ${x.de} é anterior ao estoque de QR: ela será cadastrada no estoque como livre (${pl.color}).`);
    }
  });
  const alvo = itens.filter(x => x.de !== x.para);
  if (erros.length || b.aplicar !== true) return res.json({ ok: !erros.length, aplicado: false, total: alvo.length, erros: erros.slice(0, 50), avisos: avisos.slice(0, 20), itens: alvo.slice(0, 50).map(x => ({ de: x.de, para: x.para, estoque: !!x.estoque, permuta: x.permuta ? (x.permuta.revendedor || true) : false })) });
  let loteTroca = null;
  db.transaction(() => {
    alvo.filter(x => x.permuta).forEach(x => {
      const a = db.prepare('SELECT id, order_id, color, tracking_code, code FROM plates WHERE id = ?').get(x.id), o = db.prepare('SELECT id, order_id, color, tracking_code, code FROM plates WHERE id = ?').get(x.permuta.id);
      const qa = db.prepare('SELECT id FROM qr_estoque WHERE plate_id = ?').get(a.id), qo = db.prepare('SELECT id FROM qr_estoque WHERE plate_id = ?').get(o.id);
      db.prepare('UPDATE plates SET tracking_code = ?, code = ? WHERE id = ?').run('~a' + a.id, '~a' + a.id, a.id);   // libera os únicos
      db.prepare('UPDATE plates SET tracking_code = ?, code = ? WHERE id = ?').run('~o' + o.id, '~o' + o.id, o.id);
      if (usarEstoque) {   // troca a placa FÍSICA inteira: número, QR (link) e modelo; o estoque de QR acompanha
        db.prepare('UPDATE plates SET tracking_code = ?, code = ? WHERE id = ?').run(o.tracking_code, o.code, a.id);
        db.prepare('UPDATE plates SET tracking_code = ?, code = ? WHERE id = ?').run(a.tracking_code, a.code, o.id);
        if (qa) db.prepare('UPDATE qr_estoque SET plate_id = NULL WHERE id = ?').run(qa.id);
        if (qo) db.prepare('UPDATE qr_estoque SET plate_id = ? WHERE id = ?').run(a.id, qo.id);
        if (qa) db.prepare('UPDATE qr_estoque SET plate_id = ? WHERE id = ?').run(o.id, qa.id);
        if (a.color !== o.color) { trocarModelo(a, o.color); trocarModelo(o, a.color); }
      } else {   // só o número troca
        db.prepare('UPDATE plates SET tracking_code = ?, code = ? WHERE id = ?').run(o.tracking_code, a.code, a.id);
        db.prepare('UPDATE plates SET tracking_code = ?, code = ? WHERE id = ?').run(a.tracking_code, o.code, o.id);
        db.prepare('UPDATE qr_estoque SET numero = ? WHERE plate_id = ?').run(o.tracking_code, a.id);
        db.prepare('UPDATE qr_estoque SET numero = ? WHERE plate_id = ?').run(a.tracking_code, o.id);
      }
    });
    alvo.splice(0, alvo.length, ...alvo.filter(x => !x.permuta));
    alvo.filter(x => x.estoque).forEach(x => { // troca pelo QR do estoque: devolve o QR antigo e passa a usar o novo (número + link)
      const velho = db.prepare('SELECT tracking_code, code, color FROM plates WHERE id = ?').get(x.id);
      const devolvida = db.prepare("UPDATE qr_estoque SET status = 'livre', plate_id = NULL, usado_em = NULL WHERE plate_id = ?").run(x.id).changes;
      if (!devolvida && velho.tracking_code && !db.prepare('SELECT 1 FROM qr_estoque WHERE numero = ? OR code = ?').get(velho.tracking_code, velho.code)) { // placa antiga (anterior ao estoque): entra no estoque como livre
        if (!loteTroca) loteTroca = Number(db.prepare("INSERT INTO qr_lotes (qtd_azul, qtd_preta, origem, observacao) VALUES (0, 0, 'troca', 'Placas devolvidas por troca')").run().lastInsertRowid);
        db.prepare("INSERT INTO qr_estoque (numero, code, cor, lote_id, status) VALUES (?, ?, ?, ?, 'livre')").run(velho.tracking_code, velho.code, velho.color, loteTroca);
      }
      db.prepare("UPDATE qr_estoque SET status = 'usada', plate_id = ?, usado_em = datetime('now') WHERE id = ?").run(x.id, x.estoque.id);
      db.prepare('UPDATE plates SET tracking_code = ?, code = ?, color = ? WHERE id = ?').run(x.para, x.estoque.code, x.estoque.cor, x.id);
    });
    alvo.splice(0, alvo.length, ...alvo.filter(x => !x.estoque));
    alvo.forEach(x => { // passo 1: libera os números (trocas entre placas não colidem)
      db.prepare('UPDATE plates SET tracking_code = ? WHERE id = ?').run('~' + x.id, x.id);
      db.prepare('UPDATE qr_estoque SET numero = ? WHERE plate_id = ?').run('~' + x.id, x.id);
    });
    alvo.forEach(x => {
      db.prepare('UPDATE plates SET tracking_code = ? WHERE id = ?').run(x.para, x.id);
      db.prepare('UPDATE qr_estoque SET numero = ? WHERE plate_id = ?').run(x.para, x.id);
    });
    pedidos.registrarEvento({ origem: 'admin', resultado: 'placas_renumeradas', detalhe: `${itens.filter(x => x.de !== x.para).length} placa(s) (${itens.filter(x => x.estoque).length} trocada(s) pelo estoque, ${itens.filter(x => x.permuta).length} permuta(s) entre revendedores): ` + itens.filter(x => x.de !== x.para).slice(0, 8).map(x => `${x.de}→${x.para}`).join(', ') });
  })();
  res.json({ ok: true, aplicado: true, total: itens.filter(x => x.de !== x.para).length, erros: [] });
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
  const promo = require('./promocao.js').get();
  if (promo && promo.estado === 'ativa') return res.status(409).json({ error: `A promoção "${promo.nome}" está ativa e controla a tabela de preços. Mude os preços dela (menu Promoção) ou encerre a promoção antes de editar a tabela normal.` });
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


// ---------- Aquisição: de cada mês de cadastro, quantos entraram, quantos compraram e quanto renderam ----------
// Cadastro em horário de Brasília (UTC−3). Exclui contas de cortesia e a conta de teste. O gasto de marketing é digitado por mês.
router.get('/aquisicao', (req, res) => {
  const fin = require('./financeiro.js');
  const cfg = fin.configuracao();
  const r2 = fin.r2;
  const PAGOS = ['pago', 'em_producao', 'enviado', 'entregue'];
  const revs = db.prepare(`SELECT id, name, addr_state, datetime(created_at,'-3 hours') AS cad FROM resellers WHERE cortesia = 0 AND name != 'Conta de teste NexTap'`).all();
  const ords = db.prepare(`SELECT o.*, datetime(COALESCE(o.paid_at,o.created_at),'-3 hours') AS dt FROM orders o WHERE o.status IN ('pago','em_producao','enviado','entregue') ORDER BY COALESCE(o.paid_at,o.created_at), o.id`).all();
  const recebidoPor = {};
  for (const x of db.prepare('SELECT order_id, SUM(valor) v FROM order_recebimentos GROUP BY order_id').all()) recebidoPor[x.order_id] = x.v;
  const porRev = {};
  for (const o of ords) (porRev[o.reseller_id] = porRev[o.reseller_id] || []).push(o);
  const dias = (a, b) => Math.max(0, Math.round((new Date(b.replace(' ', 'T') + 'Z') - new Date(a.replace(' ', 'T') + 'Z')) / 864e5));
  const meses = {}, estados = {}, diario = {};
  const hoje = fin.hojeBR(), corte = new Date(Date.now() - 45 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Bahia' });
  for (const r of revs) {
    const m = r.cad.slice(0, 7), dia = r.cad.slice(0, 10);
    const M = meses[m] = meses[m] || { mes: m, cadastros: 0, compraram: 0, d7: 0, receita_1o: 0, receita_total: 0, lucro: 0, placas: 0, dias_soma: 0, recompra: 0 };
    const my = porRev[r.id] || [];
    M.cadastros++;
    const uf = (r.addr_state || '—').toUpperCase().slice(0, 2);
    const E = estados[uf] = estados[uf] || { uf, cadastros: 0, compraram: 0, receita: 0 };
    E.cadastros++;
    if (dia >= corte) { const D = diario[dia] = diario[dia] || { dia, cadastros: 0, novos_compradores: 0 }; D.cadastros++; }
    if (!my.length) continue;
    M.compraram++; E.compraram++;
    const p = my[0];
    M.receita_1o += p.total; M.dias_soma += dias(r.cad, p.dt); if (dias(r.cad, p.dt) <= 7) M.d7++;
    if (my.length > 1) M.recompra++;
    for (const o of my) { const f = o.a_receber ? Math.min(1, (recebidoPor[o.id] || 0) / (o.total || 1)) : 1; M.receita_total += o.total * f; M.lucro += fin.custosDoPedido(o, cfg).lucro * f; M.placas += o.qty_azul + o.qty_preta + (o.qty_outras || 0); E.receita += o.total * f; }
    const dp = p.dt.slice(0, 10);
    if (dp >= corte) { const D = diario[dp] = diario[dp] || { dia: dp, cadastros: 0, novos_compradores: 0 }; D.novos_compradores++; }
  }
  const out = Object.values(meses).sort((a, b) => b.mes.localeCompare(a.mes)).map(M => {
    const gasto = Number(db.cfg('mkt_' + M.mes, 0)) || 0;
    const rec = r2(M.receita_total), luc = r2(M.lucro);
    return { mes: M.mes, cadastros: M.cadastros, compraram: M.compraram, taxa: M.cadastros ? r2(M.compraram / M.cadastros * 100) : 0,
      compraram_7d: M.d7, recompra: M.recompra, dias_ate_comprar: M.compraram ? r2(M.dias_soma / M.compraram) : null,
      ticket_1o: M.compraram ? r2(M.receita_1o / M.compraram) : null, receita: rec, lucro: luc, placas: M.placas,
      gasto, custo_por_cadastro: gasto && M.cadastros ? r2(gasto / M.cadastros) : null, custo_por_comprador: gasto && M.compraram ? r2(gasto / M.compraram) : null,
      roas: gasto ? r2(rec / gasto) : null, lucro_apos_mkt: gasto ? r2(luc - gasto) : null };
  });
  const dd = []; for (let i = 44; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Bahia' }); dd.push(diario[d] || { dia: d, cadastros: 0, novos_compradores: 0 }); }
  const total = db.prepare('SELECT COUNT(*) n FROM resellers').get().n;
  const nTeste = db.prepare("SELECT COUNT(*) n FROM resellers WHERE name = 'Conta de teste NexTap'").get().n;
  const nCort = db.prepare("SELECT COUNT(*) n FROM resellers WHERE cortesia = 1 AND name != 'Conta de teste NexTap'").get().n;
  const resumo = { total, teste: nTeste, cortesia: nCort, contados: revs.length, esperado: total - nTeste - nCort };
  res.json({ resumo, meses: out, diario: dd, estados: Object.values(estados).map(e => ({ ...e, receita: r2(e.receita), taxa: e.cadastros ? r2(e.compraram / e.cadastros * 100) : 0 })).sort((a, b) => b.cadastros - a.cadastros).slice(0, 12), hoje });
});

router.put('/aquisicao/gasto', (req, res) => {
  const mes = String(req.body.mes || ''), v = Number(String(req.body.valor ?? '').replace(',', '.'));
  if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Mês inválido.' });
  if (!(v >= 0)) return res.status(400).json({ error: 'Valor inválido.' });
  db.setCfg('mkt_' + mes, v);
  res.json({ ok: true });
});

// Fornecedores, estoque, despesas, custos e lucro estimado
router.use('/gestao', require('./routes-gestao.js'));

module.exports = router;
