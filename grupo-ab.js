// Teste A/B do convite do grupo de ofertas no WhatsApp.
// Cada convite leva um link curto rastreável (/g/<id><a|b><assinatura>) que marca o clique e redireciona para o grupo.
// Assim dá para saber qual mensagem faz mais gente entrar.
const crypto = require('crypto');
const db = require('./database.js');

const lerS = db.prepare('SELECT valor FROM settings WHERE chave = ?');
const gravarS = db.prepare('INSERT INTO settings (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor');
const ler = (k, d = '') => { const r = lerS.get(k); return r ? r.valor : d; };

const MSG_A = 'Oi, {nome}! 👋 Aqui é da NexTap.\n\nCriamos um grupo no WhatsApp só para os revendedores das placas NFC. Lá você recebe:\n\n✅ Ofertas e lotes com desconto antes de todo mundo\n✅ Artes e vídeos prontos para divulgar\n✅ Dicas de quem já está vendendo as placas\n✅ Novidades e lançamentos de modelos\n\nÉ gratuito e você sai quando quiser.\n\nToque para entrar: {link}';
const MSG_B = 'Oi, {nome}, tudo bem? Aqui é o Luiz, da NexTap. 😊\n\nVocê já está vendendo as placas NFC ou ainda está começando?\n\nCriei um grupo só para os revendedores, com artes prontas para divulgar, dicas de venda e as ofertas da semana em primeira mão.\n\nEntra por aqui, é gratuito: {link}';

// Primeira vez: liga o teste com as duas mensagens novas (a mensagem antiga fica guardada como referência).
if (!lerS.get('grupo_ab_v1')) {
  db.transaction(() => {
    const antiga = lerS.get('grupo_msg');
    if (antiga) gravarS.run('grupo_msg_antiga', antiga.valor);
    gravarS.run('grupo_msg', MSG_A);
    gravarS.run('grupo_msg_b', MSG_B);
    gravarS.run('grupo_ab_ativo', '1');
    gravarS.run('grupo_ab_inicio', new Date().toISOString().slice(0, 19).replace('T', ' '));
    gravarS.run('grupo_ab_v1', '1');
  })();
}

const segredo = () => process.env.JWT_SECRET || 'nextap-grupo';
const assinatura = id => crypto.createHmac('sha256', segredo()).update('grupo:' + id).digest('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 5).toLowerCase();
const RX = /^(\d{1,7})([ab])([a-z0-9]{5})$/;
function decodificar(cod) {
  const m = RX.exec(String(cod || '').toLowerCase());
  if (!m || assinatura(Number(m[1])) !== m[3]) return null;
  return { id: Number(m[1]), variante: m[2] };
}
const ROBO = /whatsapp|facebookexternalhit|facebot|bot\b|crawler|spider|preview|slack|telegram|twitter|discord|curl|wget/i;

// Clique no link do convite: marca (se não for robô de pré-visualização) e manda para o grupo.
function clique(cod, userAgent) {
  const link = ler('grupo_link');
  const d = decodificar(cod);
  if (d && !ROBO.test(String(userAgent || ''))) {
    db.prepare(`UPDATE resellers SET grupo_variante = COALESCE(grupo_variante, ?),
      grupo_clicou_via = CASE WHEN grupo_clicou_em IS NULL THEN 'convite' ELSE grupo_clicou_via END,
      grupo_clicou_em = COALESCE(grupo_clicou_em, datetime('now')) WHERE id = ?`).run(d.variante, d.id);
  }
  return link;
}

// Teste de duas proporções (confiança de que a diferença não é sorte)
function confianca(c1, n1, c2, n2) {
  if (n1 < 5 || n2 < 5) return 0;
  const p1 = c1 / n1, p2 = c2 / n2, p = (c1 + c2) / (n1 + n2), se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return 0;
  const z = Math.abs(p1 - p2) / se;
  const t = 1 / (1 + 0.2316419 * z), phi = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - phi * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.round(Math.max(0, Math.min(99.9, (2 * cdf - 1) * 100)) * 10) / 10;
}

function resultados() {
  const linha = v => db.prepare(`SELECT COUNT(*) AS enviados,
      SUM(grupo_clicou_em IS NOT NULL) AS entraram,
      SUM(grupo_clicou_via = 'convite') AS pelo_link,
      SUM(EXISTS (SELECT 1 FROM orders o WHERE o.reseller_id = r.id AND o.status IN ('pago','em_producao','enviado','entregue') AND o.created_at >= r.grupo_convidado_em)) AS compraram
    FROM resellers r WHERE grupo_variante = ? AND grupo_convidado_em IS NOT NULL`).get(v);
  const a = linha('a'), b = linha('b');
  for (const x of [a, b]) { for (const k of ['entraram', 'pelo_link', 'compraram']) x[k] = x[k] || 0; x.taxa = x.enviados ? Math.round((1000 * x.entraram) / x.enviados) / 10 : 0; }
  const antes = db.prepare("SELECT COUNT(*) AS enviados, SUM(grupo_clicou_em IS NOT NULL) AS entraram FROM resellers WHERE grupo_convidado_em IS NOT NULL AND grupo_variante IS NULL").get();
  antes.entraram = antes.entraram || 0; antes.taxa = antes.enviados ? Math.round((1000 * antes.entraram) / antes.enviados) / 10 : 0;
  const conf = confianca(a.entraram, a.enviados, b.entraram, b.enviados);
  const lider = a.taxa === b.taxa ? '' : a.taxa > b.taxa ? 'a' : 'b';
  return { ativo: ler('grupo_ab_ativo') === '1', a, b, antes, confianca: conf, lider, vencedora: conf >= 95 && Math.min(a.enviados, b.enviados) >= 20 ? lider : '' };
}

// Encerra o teste: a mensagem escolhida vira a mensagem única do convite.
function escolher(v) {
  if (!['a', 'b'].includes(v)) throw new Error('Escolha a mensagem A ou B.');
  db.transaction(() => {
    if (v === 'b') gravarS.run('grupo_msg', ler('grupo_msg_b'));
    gravarS.run('grupo_ab_ativo', '0');
  })();
}

module.exports = { assinatura, decodificar, clique, resultados, escolher, confianca, MSG_A, MSG_B };
