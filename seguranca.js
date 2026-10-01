// Segurança básica — ARQUIVO NOVO (sem dependências extras). Monte no server.js logo após o express.json().
//  1) Cabeçalhos de segurança (HTTPS forçado nos navegadores, anti-clickjacking, anti-sniffing...).
//  2) Limite de tentativas por IP nas rotas sensíveis (login, admin, cadastro, recuperação de senha, restauração),
//     contra adivinhação de senha e abuso. O webhook do Mercado Pago, o /r/:code (QR/NFC) e o resto NÃO são limitados.
const JANELA = 15 * 60 * 1000;
const REGRAS = [
  { m: 'POST', p: '/api/auth/login',        max: 10, janela: JANELA },
  { m: 'POST', p: '/api/auth/admin-login',  max: 5,  janela: JANELA },
  { m: 'POST', p: '/api/auth/forgot',       max: 5,  janela: JANELA },
  { m: 'POST', p: '/api/auth/reset',        max: 10, janela: JANELA },
  { m: 'POST', p: '/api/auth/register',     max: 10, janela: 60 * 60 * 1000 },
  { m: 'POST', p: '/api/admin/restore',     max: 10, janela: 60 * 60 * 1000 },
  { m: 'POST', p: '/api/admin/backup-email', max: 10, janela: 60 * 60 * 1000 },
];
const usos = new Map(); // chave -> { n, ate }

setInterval(() => { const t = Date.now(); for (const [k, v] of usos) if (v.ate <= t) usos.delete(k); }, 10 * 60 * 1000).unref();

module.exports = function seguranca(req, res, next) {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000'); // 180 dias

  const regra = REGRAS.find(r => r.m === req.method && r.p === req.path);
  if (!regra) return next();
  const chave = regra.p + '|' + req.ip;
  const agora = Date.now();
  let u = usos.get(chave);
  if (!u || u.ate <= agora) { u = { n: 0, ate: agora + regra.janela }; usos.set(chave, u); }
  u.n++;
  if (u.n > regra.max) {
    const seg = Math.ceil((u.ate - agora) / 1000);
    res.setHeader('Retry-After', String(seg));
    return res.status(429).json({ error: `Muitas tentativas. Aguarde ${Math.ceil(seg / 60)} minuto(s) e tente de novo.` });
  }
  next();
};
