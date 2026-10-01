// Backup EXTERNO por e-mail — ARQUIVO NOVO. Protege os dados mesmo se o Volume/serviço do Railway for perdido.
//
// O que faz: sempre que algo mudar no banco (novo revendedor, pedido, placa, venda...), envia ao e-mail do admin
// uma cópia do banco (.db) + uma planilha dos revendedores (.csv: nome, e-mail, WhatsApp, cadastro).
// No máximo 1 e-mail por hora e só quando houve mudança. Usa o mesmo Resend do "esqueci a senha".
//
// Variáveis (Railway → Variables):  RESEND_API_KEY e MAIL_FROM (já usadas), e opcionalmente
//   BACKUP_EMAIL_TO  (padrão: ADMIN_EMAIL)   |   BACKUP_EMAIL_DESLIGADO=1 para desativar
// Atenção: o .db contém e-mails, telefones e hashes de senha — use um e-mail só seu e protegido.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./database.js');
const { requireAdmin } = require('./auth-middleware.js');

const router = express.Router();
const ESTADO = path.join(db.meta.backupDir, 'ultimo-envio-externo.json');
const INTERVALO_MIN_MS = 60 * 60 * 1000;   // no máximo 1 e-mail por hora
const VERIFICAR_A_CADA_MS = 10 * 60 * 1000; // confere mudanças a cada 10 min

const destino = () => (process.env.BACKUP_EMAIL_TO || process.env.ADMIN_EMAIL || '').trim();
const configurado = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM && destino()) && process.env.BACKUP_EMAIL_DESLIGADO !== '1';

function assinatura() {
  const h = crypto.createHash('sha256');
  ['SELECT * FROM resellers ORDER BY id',
   'SELECT id, status, paid_at, total FROM orders ORDER BY id',
   'SELECT id, status, destination_url, client_name FROM plates ORDER BY id',
   'SELECT * FROM sales ORDER BY id',
   'SELECT * FROM price_tiers ORDER BY id'].forEach(s => h.update(JSON.stringify(db.prepare(s).all())));
  return h.digest('hex');
}

function lerEstado() { try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch (e) { return {}; } }
function gravarEstado(o) { try { fs.mkdirSync(db.meta.backupDir, { recursive: true }); fs.writeFileSync(ESTADO, JSON.stringify(o)); } catch (e) { /* ok */ } }

const csvCel = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
function csvRevendedores() {
  const rows = db.prepare(`SELECT r.id, r.name, r.email, r.whatsapp, r.created_at,
      (SELECT COUNT(*) FROM orders o WHERE o.reseller_id=r.id) AS pedidos,
      (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.reseller_id=r.id AND o.status IN ('pago','enviado','entregue')) AS total_pago
    FROM resellers r ORDER BY r.id`).all();
  const cab = ['id', 'nome', 'email', 'whatsapp', 'cadastro', 'pedidos', 'total_pago'];
  return '\ufeff' + [cab.join(';')].concat(rows.map(r => [r.id, r.name, r.email, r.whatsapp, r.created_at, r.pedidos, r.total_pago].map(csvCel).join(';'))).join('\r\n');
}

async function enviar(motivo) {
  if (!configurado()) return { ok: false, motivo: 'Configure RESEND_API_KEY, MAIL_FROM e (opcional) BACKUP_EMAIL_TO.' };
  const copia = db.copiaTemporaria();
  try {
    const dia = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const n = db.prepare('SELECT COUNT(*) AS n FROM resellers').get().n;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [destino()],
        subject: `NexTap — backup automático (${n} revendedores)`,
        html: `<p>Cópia de segurança da NexTap (${motivo}).</p><p>Anexos: <b>nextap-${dia}.db</b> (restaure em <i>/admin/restaurar</i>) e <b>revendedores-${dia}.csv</b> (contatos).</p><p><b>Guarde este e-mail:</b> contém dados pessoais dos revendedores.</p>`,
        attachments: [
          { filename: `nextap-${dia}.db`, content: fs.readFileSync(copia).toString('base64') },
          { filename: `revendedores-${dia}.csv`, content: Buffer.from(csvRevendedores(), 'utf8').toString('base64') },
        ],
      }),
    });
    if (!r.ok) { const t = (await r.text()).slice(0, 200); console.error('[BACKUP-EXT] Falha:', r.status, t); return { ok: false, motivo: `Resend respondeu ${r.status}: ${t}` }; }
    console.log(`[BACKUP-EXT] Backup enviado por e-mail (${motivo}).`);
    return { ok: true };
  } finally { fs.unlink(copia, () => {}); }
}

async function verificar() {
  if (!configurado()) return;
  try {
    const est = lerEstado();
    const sig = assinatura();
    if (sig === est.assinatura) return;                                   // nada mudou
    if (est.enviado_em && Date.now() - est.enviado_em < INTERVALO_MIN_MS) return; // já enviou há pouco
    const r = await enviar(est.assinatura ? 'houve alterações nos dados' : 'primeiro backup externo');
    if (r.ok) gravarEstado({ assinatura: sig, enviado_em: Date.now() });
  } catch (e) { console.error('[BACKUP-EXT] Erro:', e.message); }
}

// Envio manual para testar (admin): POST /api/admin/backup-email
router.post('/backup-email', requireAdmin, async (req, res) => {
  try {
    const r = await enviar('envio manual');
    if (r.ok) gravarEstado({ assinatura: assinatura(), enviado_em: Date.now() });
    res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true, enviado_para: destino() } : { error: r.motivo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

if (configurado()) {
  console.log(`[BACKUP-EXT] Ativo: backups por e-mail para ${destino()}.`);
  setTimeout(verificar, 60 * 1000).unref();                  // 1 min após ligar
  setInterval(verificar, VERIFICAR_A_CADA_MS).unref();
} else {
  console.warn('[BACKUP-EXT] Desativado (faltam RESEND_API_KEY / MAIL_FROM). Configure para ter cópia fora do Railway.');
}

module.exports = router;
module.exports._teste = { enviar, verificar, assinatura, csvRevendedores };
