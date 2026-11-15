// Avisos para o Automazap (robô do Instagram) — ARQUIVO NOVO.
// Quando um lead que veio do robô cria conta, inicia um pedido ou paga, o Automazap fica sabendo:
// marca a etapa no funil, registra a venda sozinho e para de mandar follow-up para quem já comprou.
//
// Variáveis (nos dois serviços o segredo é o mesmo): AUTOMAZAP_URL (ex.: https://automazap-production.up.railway.app)
// e NEXTAP_WEBHOOK_SECRET (mínimo 16 caracteres). Sem elas, nada é enviado.
// Nunca atrapalha o cadastro nem o pagamento: roda depois, e qualquer falha só vai para o log.
const db = require('./database.js');
// O segredo e o endereço vêm das variáveis do Railway OU da conexão automática (botão "Conectar ao NexTap" no Automazap,
// que abre /admin/conectar-automazap aqui e troca o segredo sozinho). A variável, se existir, sempre vale.
const cfg = k => { try { const r = db.prepare('SELECT valor FROM settings WHERE chave = ?').get(k); return r ? r.valor : ''; } catch (e) { return ''; } };
const segredo = () => process.env.NEXTAP_WEBHOOK_SECRET || cfg('automazap_segredo') || '';
const urlAutomazap = () => String(process.env.AUTOMAZAP_URL || cfg('automazap_url') || '').replace(/\/+$/, '');

const LEAD_OK = /^[\w-]{6,40}$/;
const limparLead = v => (typeof v === 'string' && LEAD_OK.test(v) ? v : null);

function notificar(evento, dados) {
  const url = urlAutomazap(), seg = segredo();
  if (!url || seg.length < 16 || !dados || !dados.lead) return false;
  setImmediate(async () => {
    try {
      const r = await fetch(url + '/webhook/nextap', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Automazap-Secret': seg },
        body: JSON.stringify({ evento, ...dados }), signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) console.warn(`[AUTOMAZAP] aviso "${evento}" recusado: HTTP ${r.status}`);
    } catch (e) { console.warn(`[AUTOMAZAP] aviso "${evento}" não enviado:`, e.message); }
  });
  return true;
}

// Guarda de qual lead do robô veio este revendedor (só o primeiro: quem já tem não é trocado).
function vincularLead(resellerId, lead) {
  const l = limparLead(lead);
  if (!l) return null;
  const r = db.prepare('UPDATE resellers SET lead_token = ? WHERE id = ? AND lead_token IS NULL').run(l, resellerId);
  return r.changes ? l : null;
}
const leadDoRevendedor = id => (db.prepare('SELECT lead_token FROM resellers WHERE id = ?').get(id) || {}).lead_token || null;

function avisarPedido(evento, orderId) {
  const o = db.prepare('SELECT id, reseller_id, qty_azul, qty_preta, qty_outras, total FROM orders WHERE id = ?').get(orderId);
  if (!o) return false;
  return notificar(evento, { lead: leadDoRevendedor(o.reseller_id), pedido: o.id, qty: (o.qty_azul || 0) + (o.qty_preta || 0) + (o.qty_outras || 0), total: o.total });
}

// ---------- Financeiro para o Prédio do Automazap (somente leitura) ----------
// GET /api/integracao/financeiro com o cabeçalho X-Automazap-Secret = NEXTAP_WEBHOOK_SECRET.
// Usa o mesmo contador do painel admin (financeiro.js): nada é recalculado nem alterado aqui.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
function autorizado(req) {
  const seg = segredo();
  const a = Buffer.from(String(req.get('X-Automazap-Secret') || '')), b = Buffer.from(seg);
  return seg.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
const compacto = L => ({ periodo: L.periodo, pedidos: L.pedidos, placas: L.placas, receita_bruta: L.receita_bruta, custo_placas: L.custo_placas, icms: L.icms,
  taxas_mp: L.taxas_mp, custo_envio: L.custo_envio, lucro_bruto: L.lucro_bruto, despesas: L.despesas, lucro_final: L.lucro_final, margem_pct: L.margem_pct,
  lucro_por_placa: L.lucro_por_placa, ticket_medio: L.pedidos ? Math.round((L.receita_bruta / L.pedidos) * 100) / 100 : 0 });
router.get('/api/integracao/financeiro', (req, res) => {
  if (!segredo().length) return res.status(503).json({ error: 'Integração com o Automazap ainda não conectada.' });
  if (!autorizado(req)) return res.sendStatus(401);
  try {
    const F = require('./financeiro.js');
    const mes = F.lucro('month');
    const periodos = {}; for (const p of ['today', '7', '30', 'month', 'all']) periodos[p] = p === 'month' ? compacto(mes) : compacto(F.lucro(p));
    const um = (sql, ...a) => db.prepare(sql).get(...a);
    const status = db.prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(total), 0) AS valor FROM orders GROUP BY status').all();
    // Operação: pedidos pagos parados (sem produção/envio) e em produção há muitos dias
    const parados = db.prepare(`SELECT id, status, total, COALESCE(producao_at, paid_at, created_at) AS desde, ship_name FROM orders
      WHERE status IN ('pago', 'em_producao') ORDER BY desde LIMIT 50`).all()
      .map(o => ({ ...o, dias: Math.floor((Date.now() - Date.parse(String(o.desde).replace(' ', 'T') + 'Z')) / 864e5) }));
    const res_ = {
      gerado_em: Date.now(),
      periodos,
      mes: { alertas: mes.alertas, a_receber: mes.a_receber, estoque: mes.estoque, despesas_itens: (mes.despesas_itens || []).slice(0, 10),
        faixas: mes.faixas, pedidos_prejuizo: mes.pedidos_prejuizo.length, ponto_equilibrio_placas: mes.ponto_equilibrio_placas, config: mes.config },
      pedidos: { por_status: status, parados: parados.filter(o => o.dias >= 3).slice(0, 10), aguardando_pagamento_14d: um("SELECT COUNT(*) AS n FROM orders WHERE status = 'aguardando_pagamento' AND created_at >= datetime('now', '-14 days')").n },
      revendedores: { total: um('SELECT COUNT(*) AS n FROM resellers').n, novos_7d: um("SELECT COUNT(*) AS n FROM resellers WHERE created_at >= datetime('now', '-7 days')").n,
        compraram_30d: um("SELECT COUNT(DISTINCT reseller_id) AS n FROM orders WHERE status IN ('pago','em_producao','enviado','entregue') AND COALESCE(paid_at, created_at) >= datetime('now', '-30 days')").n },
    };
    res.json(res_);
  } catch (e) { console.error('[AUTOMAZAP] financeiro:', e.message); res.status(500).json({ error: 'Falha ao montar o financeiro.' }); }
});

// ---------- Conexão automática com o Automazap ----------
// O admin (logado) abre /admin/conectar-automazap?volta=<Automazap>&codigo=<código de uso único>.
// A página pede aqui o segredo (gera um se ainda não houver), guarda o endereço do Automazap e entrega o segredo
// ao Automazap junto com o código, que só ele conhece e vale 10 minutos.
const { requireAdmin } = require('./auth-middleware.js');
const path = require('path');
router.post('/api/admin/automazap/conectar', requireAdmin, (req, res) => {
  let volta;
  try { const u = new URL(String((req.body || {}).volta || '')); if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) throw new Error(); volta = u.origin; }
  catch (e) { return res.status(400).json({ error: 'Endereço do Automazap inválido.' }); }
  if (!process.env.NEXTAP_WEBHOOK_SECRET && !cfg('automazap_segredo')) db.prepare("INSERT OR REPLACE INTO settings (chave, valor) VALUES ('automazap_segredo', ?)").run(crypto.randomBytes(32).toString('hex'));
  if (!process.env.AUTOMAZAP_URL) db.prepare("INSERT OR REPLACE INTO settings (chave, valor) VALUES ('automazap_url', ?)").run(volta);
  if (!/^[\x21-\x7e]{16,200}$/.test(segredo())) return res.status(400).json({ error: 'A variável NEXTAP_WEBHOOK_SECRET do NexTap no Railway está inválida (precisa de 16 a 200 caracteres, sem espaços nem acentos). Corrija ou apague essa variável e tente de novo.' });
  res.json({ segredo: segredo(), base: (process.env.SITE_HOST ? 'https://' + process.env.SITE_HOST.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : `${req.protocol}://${req.get('host')}`), automazap: urlAutomazap() });
});
router.get('/api/admin/automazap/status', requireAdmin, (req, res) => res.json({ conectado: segredo().length >= 16 && !!urlAutomazap(), automazap: urlAutomazap(), por_variavel: !!process.env.NEXTAP_WEBHOOK_SECRET }));
router.get(['/admin/conectar-automazap', '/admin/conectar-automazap/'], (req, res) => res.sendFile(path.join(__dirname, 'conectar-automazap.html')));

module.exports = { notificar, vincularLead, leadDoRevendedor, avisarPedido, limparLead, router, autorizado, segredo };
