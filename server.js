require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// Sem JWT_SECRET o login quebra em runtime (jwt.sign lança erro). Melhor falhar já no boot,
// com uma mensagem clara nos logs do Railway.
if (!process.env.JWT_SECRET) {
  console.error('ERRO: a variável de ambiente JWT_SECRET não está definida. Configure em Variables no Railway.');
  process.exit(1);
}
if (!process.env.MP_ACCESS_TOKEN) console.warn('AVISO: MP_ACCESS_TOKEN não definido — pagamentos ficarão indisponíveis.');
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) console.warn('AVISO: ADMIN_EMAIL/ADMIN_PASSWORD não definidos — login de admin desativado.');

const app = express();
app.set('trust proxy', 1); // Railway fica atrás de um proxy

// CORS: se FRONTEND_URL estiver definido, aceita só ele (mais seguro); vírgula separa vários domínios.
const origins = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : {}));
app.use(express.json({ limit: '1mb' }));

// Health check (Railway usa para saber se o deploy subiu)
app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/resellers', require('./routes/resellers'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/admin', require('./routes/admin'));
app.use('/', require('./routes/public')); // /r/:code — link do QR Code / NFC da placa e /api/public/stats

// Site (/), painel do revendedor (/revendedor) e painel admin (/admin) — servidos pelo próprio backend,
// no mesmo domínio da API, então não há problema de CORS.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// 404 e erro genérico em JSON (evita devolver stack trace e HTML para o frontend)
app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  console.error('Erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`NexTap backend rodando na porta ${PORT}`));
