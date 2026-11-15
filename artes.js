// Banco de artes: imagens de alta qualidade para a PRODUÇÃO das placas e para o SITE/CATÁLOGO.
// Dois caminhos para criar uma arte:
//   1) Grátis, pelo ChatGPT: o sistema monta o comando (prompt) pronto; você gera no ChatGPT e envia a imagem aqui.
//   2) Automático, pela API da OpenAI (OPENAI_API_KEY): botão "Gerar automático", com limite de gasto por mês.
// Admin: /api/admin/artes (a tela fica no Automazap)  ·  Automazap (Theo, no Prédio): /api/integracao/artes com X-Automazap-Secret.
// Montado ANTES do express.json global (as imagens passam de 1 MB).
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./database.js');
const { requireAdmin } = require('./auth-middleware.js');

db.exec(`CREATE TABLE IF NOT EXISTS artes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL DEFAULT '',
  destino TEXT NOT NULL DEFAULT 'catalogo',      -- placa | catalogo | marketing
  prompt TEXT NOT NULL DEFAULT '',
  arquivo TEXT NOT NULL,                         -- nome do arquivo na pasta do Volume (artes/)
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  origem TEXT NOT NULL DEFAULT 'upload',         -- chatgpt | api | upload
  produto_id INTEGER,                            -- usada como imagem deste produto do catálogo
  order_id INTEGER,                              -- arte de produção deste pedido (vai no ZIP do fornecedor)
  aprovada INTEGER NOT NULL DEFAULT 0,
  custo_usd REAL NOT NULL DEFAULT 0,
  enviado_por TEXT NOT NULL DEFAULT 'admin',     -- admin | theo
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_artes_destino ON artes(destino, id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_artes_pedido ON artes(order_id)');

const pasta = path.join(path.dirname(db.meta.arquivo), 'artes');
fs.mkdirSync(pasta, { recursive: true });
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const DESTINOS = ['placa', 'catalogo', 'marketing'];
const MAX = 10 * 1024 * 1024;
const getS = k => { const r = db.prepare('SELECT valor FROM settings WHERE chave = ?').get(k); return r ? r.valor : null; };
const setS = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (chave, valor) VALUES (?, ?)').run(k, String(v));
const url = a => '/artes-img/' + a.arquivo;
const pub = a => a && ({ ...a, url: url(a) });

// ---------- comandos (prompts) prontos ----------
const ESTILOS = {
  premium: 'estilo premium e sofisticado, fundo escuro com reflexos suaves, detalhes metálicos discretos',
  minimalista: 'estilo minimalista e claro, muito espaço em branco, tipografia limpa',
  neon: 'estilo tecnológico 2027, luzes de LED e neon suaves em azul e verde, ambiente moderno',
  black: 'estilo Black Friday, fundo preto, detalhes em dourado e verde, sensação de oferta exclusiva',
};
function montarPrompt(o = {}) {
  const destino = DESTINOS.includes(o.destino) ? o.destino : 'catalogo';
  const nomeP = String(o.produto || '').replace(/"/g, '').slice(0, 120).trim();
  const produto = !nomeP ? 'placa NFC + QR Code' : /^display/i.test(nomeP) ? `display de balcão NFC + QR Code (modelo "${nomeP}")` : /^(placa|cart)/i.test(nomeP) ? nomeP : `placa NFC + QR Code (modelo "${nomeP}")`;
  const um = /^display/i.test(produto) ? 'um' : 'uma';
  const cor = String(o.cor || '').slice(0, 60), texto = String(o.texto || '').slice(0, 120), negocio = String(o.negocio || '').slice(0, 120);
  const estilo = ESTILOS[o.estilo] || ESTILOS.premium, extra = String(o.extra || '').slice(0, 400);
  let p;
  if (destino === 'placa') {
    p = [`Arte final para IMPRESSÃO de ${um} ${produto}${cor ? ` na cor ${cor}` : ''}, formato quadrado, vista totalmente de frente (sem perspectiva, sem mockup, sem sombras, sem mãos).`,
      texto ? `Texto principal escrito exatamente assim, em português e sem erros: "${texto}". Fonte sem serifa, bold, muito legível de longe.` : 'Pouco texto, legível de longe.',
      negocio ? `Identidade do cliente: ${negocio}.` : '',
      'Deixe um quadrado BRANCO e vazio (cerca de 25% da largura) no canto inferior direito, reservado para o QR Code: não desenhe nenhum QR Code.',
      'Inclua um ícone de aproximação (símbolo NFC, ondas) perto da frase de chamada. Margem de segurança de 3 mm em todas as bordas.',
      `${estilo}. Cores chapadas e contraste alto, pronto para gráfica, alta resolução, bordas nítidas.`].filter(Boolean).join(' ');
  } else if (destino === 'catalogo') {
    p = [`Foto de produto profissional e realista de ${um} ${produto}${cor ? ` na cor ${cor}` : ''}, apoiada em um balcão${negocio ? ` de ${negocio}` : ' de loja'}.`,
      texto ? `Na placa aparece apenas o texto "${texto}", escrito corretamente em português.` : 'Sem textos inventados na placa.',
      'Um celular aproximando da placa, com a tela acendendo, mostrando o uso por NFC. Iluminação de estúdio suave, foco nítido na placa, fundo levemente desfocado.',
      `${estilo}. Formato quadrado, alta resolução, aparência de catálogo de e-commerce, sem marcas d'água e sem logotipos de terceiros.`].join(' ');
  } else {
    p = [`Imagem para post do Instagram da NexTap divulgando ${produto}${cor ? ` na cor ${cor}` : ''}.`,
      texto ? `Título grande na imagem, escrito exatamente assim em português: "${texto}".` : '',
      negocio ? `Cena em ${negocio}.` : 'Cena em um comércio local brasileiro, cliente aproximando o celular da placa.',
      `${estilo}. Composição limpa, alto contraste, pessoas reais e naturais, alta resolução, sem marcas d'água.`].filter(Boolean).join(' ');
  }
  if (extra) p += ' ' + extra;
  const tamanho = destino === 'marketing' ? '1024x1536' : '1024x1024';
  return { destino, prompt: p, tamanho, dica: destino === 'placa'
    ? 'No ChatGPT, peça a imagem no maior tamanho possível. Confira o texto letra por letra antes de mandar para a gráfica: a IA às vezes erra acentos.'
    : 'No ChatGPT, se não gostar, peça "faça outra versão mais realista" antes de baixar.' };
}

// ---------- gravação ----------
function salvar({ data, titulo, destino, prompt, origem, custo, enviado_por, produto_id, order_id }) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(data || ''));
  if (!m) { const e = new Error('Envie uma imagem JPG, PNG ou WebP.'); e.status = 400; throw e; }
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (buf.length < 100) { const e = new Error('Imagem vazia.'); e.status = 400; throw e; }
  if (buf.length > MAX) { const e = new Error('Imagem grande demais (máx. 10 MB).'); e.status = 400; throw e; }
  const nome = `a-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${EXT[m[1]]}`;
  fs.writeFileSync(path.join(pasta, nome), buf);
  const pid = Number(produto_id) || null, oid = Number(order_id) || null;
  const id = db.prepare(`INSERT INTO artes (titulo, destino, prompt, arquivo, mime, bytes, origem, custo_usd, enviado_por, produto_id, order_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(String(titulo || '').slice(0, 120) || 'Arte sem título', DESTINOS.includes(destino) ? destino : 'catalogo', String(prompt || '').slice(0, 4000), nome, m[1], buf.length,
      ['chatgpt', 'api', 'upload'].includes(origem) ? origem : 'upload', Number(custo) || 0, enviado_por === 'theo' ? 'theo' : 'admin',
      pid && db.prepare('SELECT 1 FROM produtos WHERE id = ?').get(pid) ? pid : null, oid && db.prepare('SELECT 1 FROM orders WHERE id = ?').get(oid) ? oid : null).lastInsertRowid;
  return pub(db.prepare('SELECT * FROM artes WHERE id = ?').get(id));
}

// ---------- geração automática (API da OpenAI) ----------
// Preço aproximado por imagem (US$), conforme qualidade e tamanho; serve para o limite mensal (o valor real está na conta da OpenAI).
const CUSTO = { low: [0.011, 0.016], medium: [0.042, 0.063], high: [0.167, 0.25] };
const mes = () => new Date().toISOString().slice(0, 7);
const gastoMes = () => db.prepare("SELECT COALESCE(SUM(custo_usd), 0) AS v, COUNT(*) AS n FROM artes WHERE origem = 'api' AND substr(criado_em, 1, 7) = ?").get(mes());
const limiteMes = () => { const v = parseFloat(getS('artes_limite_usd') || '0'); return isFinite(v) && v >= 0 ? v : 0; };
const apiLigada = () => (process.env.OPENAI_API_KEY || '').length > 20 && limiteMes() > 0;
function infoApi() { const g = gastoMes(); return { ligada: apiLigada(), modelo: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', limite_usd: limiteMes(), gasto_usd: Math.round(g.v * 1000) / 1000, geradas_mes: g.n, custos: CUSTO }; }
async function gerar({ prompt, destino, titulo, qualidade, tamanho, enviado_por, produto_id, order_id }) {
  if (!apiLigada()) { const e = new Error('Para gerar automático, coloque OPENAI_API_KEY no Railway (serviço do NexTap). Sem ela, use o comando no ChatGPT e envie a imagem.'); e.status = 400; throw e; }
  const q = ['low', 'medium', 'high'].includes(qualidade) ? qualidade : 'medium';
  const tam = ['1024x1024', '1024x1536', '1536x1024'].includes(tamanho) ? tamanho : '1024x1024';
  const custo = CUSTO[q][tam === '1024x1024' ? 0 : 1];
  const g = gastoMes(), lim = limiteMes();
  if (lim <= 0) { const e = new Error('A geração paga está desligada (limite US$ 0, custo zero). Use o comando no ChatGPT, que é grátis.'); e.status = 402; throw e; }
  if (g.v + custo > lim + 1e-9) { const e = new Error(`Limite do mês atingido: US$ ${g.v.toFixed(2)} de US$ ${lim.toFixed(2)}. Aumente o limite na sala do Theo (Prédio do Automazap), ou use o ChatGPT (grátis).`); e.status = 402; throw e; }
  const p = String(prompt || '').trim();
  if (p.length < 10) { const e = new Error('Escreva o comando da imagem.'); e.status = 400; throw e; }
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const r = await fetch(base + '/images/generations', {
    method: 'POST', signal: AbortSignal.timeout(180000),
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', prompt: p.slice(0, 4000), size: tam, quality: q, n: 1 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('A OpenAI recusou: ' + ((j.error && j.error.message) || r.status)); e.status = 502; throw e; }
  const b64 = j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) { const e = new Error('A OpenAI não devolveu a imagem.'); e.status = 502; throw e; }
  return salvar({ data: 'data:image/png;base64,' + b64, titulo, destino, prompt: p, origem: 'api', custo, enviado_por, produto_id, order_id });
}

// ---------- uso da arte ----------
function apagarArquivo(nome) { if (/^a-[\w-]+\.(png|jpg|webp)$/.test(nome)) fs.unlink(path.join(pasta, nome), () => {}); }
function atualizar(id, b) {
  const a = db.prepare('SELECT * FROM artes WHERE id = ?').get(id);
  if (!a) { const e = new Error('Arte não encontrada.'); e.status = 404; throw e; }
  const pid = b.produto_id === null || b.produto_id === '' ? null : b.produto_id !== undefined ? Number(b.produto_id) : a.produto_id;
  const oid = b.order_id === null || b.order_id === '' ? null : b.order_id !== undefined ? Number(String(b.order_id).replace(/\D/g, '')) : a.order_id;
  if (pid && !db.prepare('SELECT 1 FROM produtos WHERE id = ?').get(pid)) { const e = new Error('Produto não encontrado.'); e.status = 400; throw e; }
  if (oid && !db.prepare('SELECT 1 FROM orders WHERE id = ?').get(oid)) { const e = new Error(`Pedido #${String(oid).padStart(5, '0')} não encontrado.`); e.status = 400; throw e; }
  db.prepare('UPDATE artes SET titulo = ?, destino = ?, aprovada = ?, produto_id = ?, order_id = ? WHERE id = ?').run(
    b.titulo !== undefined ? String(b.titulo).slice(0, 120) : a.titulo, DESTINOS.includes(b.destino) ? b.destino : a.destino,
    b.aprovada !== undefined ? (b.aprovada ? 1 : 0) : a.aprovada, pid || null, oid || null, id);
  // "Usar no site": a arte vira a imagem do produto no catálogo (LP e checkout)
  if (b.usar_no_catalogo && pid) db.prepare('UPDATE produtos SET imagem = ? WHERE id = ?').run(url(a), pid);
  return pub(db.prepare('SELECT * FROM artes WHERE id = ?').get(id));
}
function remover(id) {
  const a = db.prepare('SELECT * FROM artes WHERE id = ?').get(id);
  if (!a) return false;
  db.prepare("UPDATE produtos SET imagem = '' WHERE imagem = ?").run(url(a));
  db.prepare('DELETE FROM artes WHERE id = ?').run(id); apagarArquivo(a.arquivo);
  return true;
}
function listar(q = {}) {
  const w = [], a = [];
  if (DESTINOS.includes(q.destino)) { w.push('a.destino = ?'); a.push(q.destino); }
  if (q.pedido) { w.push('a.order_id = ?'); a.push(Number(String(q.pedido).replace(/\D/g, '')) || 0); }
  const lim = Math.max(1, Math.min(200, parseInt(q.limite, 10) || 60));
  return db.prepare(`SELECT a.*, p.nome AS produto_nome FROM artes a LEFT JOIN produtos p ON p.id = a.produto_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ${lim}`).all(...a).map(pub);
}
// Artes de produção dos pedidos (para o ZIP do fornecedor): só as aprovadas, ou todas se nenhuma do pedido foi aprovada
function artesDosPedidos(ids) {
  const out = [];
  for (const oid of [...new Set(ids.filter(Boolean))]) {
    const l = db.prepare("SELECT * FROM artes WHERE order_id = ? AND destino = 'placa' ORDER BY aprovada DESC, id DESC").all(oid);
    const usar = l.some(x => x.aprovada) ? l.filter(x => x.aprovada) : l;
    for (const x of usar) { try { out.push({ nome: `artes/pedido-${String(oid).padStart(5, '0')}-arte-${x.id}.${EXT[x.mime]}`, dados: fs.readFileSync(path.join(pasta, x.arquivo)) }); } catch (e) { /* arquivo sumiu */ } }
  }
  return out;
}
const resumo = () => ({ total: db.prepare('SELECT COUNT(*) AS n FROM artes').get().n,
  por_destino: db.prepare('SELECT destino, COUNT(*) AS n FROM artes GROUP BY destino').all(),
  pedidos_sem_arte: db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE o.status IN ('pago','em_producao') AND NOT EXISTS (SELECT 1 FROM artes a WHERE a.order_id = o.id)`).get().n,
  api: infoApi() });

// ---------- rotas ----------
const router = express.Router();
const json = express.json({ limit: '15mb' });
router.use('/artes-img', express.static(pasta, { maxAge: '30d', immutable: true }));
const tratar = fn => async (req, res) => { try { res.json(await fn(req)); } catch (e) { if (!e.status) console.error('[ARTES]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Falha no banco de artes.' }); } };

const adm = express.Router();
adm.use(requireAdmin);
adm.get('/', tratar(req => ({ artes: listar(req.query), ...resumo(), produtos: db.prepare('SELECT id, nome, categoria, imagem FROM produtos ORDER BY ordem, id').all(), estilos: Object.keys(ESTILOS) })));
adm.post('/prompt', tratar(req => montarPrompt(req.body || {})));
adm.post('/', tratar(req => salvar({ ...(req.body || {}), enviado_por: 'admin' })));
adm.post('/gerar', tratar(req => gerar({ ...(req.body || {}), enviado_por: 'admin' })));
adm.put('/limite', tratar(req => { const v = parseFloat(String((req.body || {}).limite_usd).replace(',', '.')); if (!isFinite(v) || v < 0 || v > 1000) { const e = new Error('Limite entre 0 e 1000 dólares.'); e.status = 400; throw e; } setS('artes_limite_usd', v); return infoApi(); }));
adm.put('/:id', tratar(req => atualizar(Number(req.params.id), req.body || {})));
adm.delete('/:id', tratar(req => ({ ok: remover(Number(req.params.id)) })));
router.use('/api/admin/artes', json, adm);

// Integração com o Automazap (Theo): mesmo segredo do financeiro
const integ = express.Router();
integ.use((req, res, next) => {
  if (!require('./automazap.js').segredo().length) return res.status(503).json({ error: 'Integração com o Automazap ainda não conectada.' });
  if (!require('./automazap.js').autorizado(req)) return res.sendStatus(401);
  next();
});
integ.get('/', tratar(req => ({ artes: listar(req.query), ...resumo(), produtos: db.prepare('SELECT id, nome FROM produtos WHERE ativo = 1 ORDER BY ordem, id').all(), estilos: Object.keys(ESTILOS) })));
integ.post('/prompt', tratar(req => montarPrompt(req.body || {})));
integ.post('/', tratar(req => salvar({ ...(req.body || {}), enviado_por: 'theo' })));
integ.post('/gerar', tratar(req => gerar({ ...(req.body || {}), enviado_por: 'theo' })));
// O Theo (no Prédio do Automazap) administra o banco inteiro: aprovar, usar como foto do site, ligar a pedido, excluir e limite da API.
integ.put('/limite', tratar(req => { const v = parseFloat(String((req.body || {}).limite_usd).replace(',', '.')); if (!isFinite(v) || v < 0 || v > 1000) { const e = new Error('Limite entre 0 e 1000 dólares.'); e.status = 400; throw e; } setS('artes_limite_usd', String(v)); return infoApi(); }));
integ.put('/:id', tratar(req => atualizar(Number(req.params.id), req.body || {})));
integ.delete('/:id', tratar(req => ({ ok: remover(Number(req.params.id)) })));
router.use('/api/integracao/artes', json, integ);

// O banco de artes agora é administrado pelo Theo no Prédio do Automazap: o endereço antigo leva para lá.
router.get(['/admin/artes', '/admin/artes/'], (req, res) => {
  let az = ''; try { az = String(process.env.AUTOMAZAP_URL || getS('automazap_url') || '').replace(/\/+$/, ''); } catch (e) { /* sem conexão */ }
  res.redirect(302, /^https?:\/\//.test(az) ? az + '/#predio' : '/admin/');
});

module.exports = router;
Object.assign(module.exports, { montarPrompt, salvar, gerar, listar, atualizar, remover, artesDosPedidos, infoApi, pasta });
