// Catálogo de produtos (esteira) — ARQUIVO NOVO. Não altera tabelas nem rotas existentes.
// - Tabela nova "produtos" (categorias: Placas NFC + QR, Displays). Os preços de venda ficam em branco até você definir.
// - Público: GET /api/public/catalogo (sem custo). Admin: /api/admin/catalogo e a página /admin/catalogo.
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./database.js');
const { requireAdmin } = require('./auth-middleware.js');

db.exec(`CREATE TABLE IF NOT EXISTS produtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  categoria TEXT NOT NULL,
  nome TEXT NOT NULL,
  descricao TEXT NOT NULL DEFAULT '',
  cor TEXT NOT NULL DEFAULT '#0f9d4e',
  custo REAL NOT NULL DEFAULT 0,
  preco REAL,
  ativo INTEGER NOT NULL DEFAULT 1,
  pedido_ativo INTEGER NOT NULL DEFAULT 0,
  ordem INTEGER NOT NULL DEFAULT 0
)`);

// Colunas novas (idempotente): imagem do produto e "preço segue a tabela atual de vendas".
const cols = db.prepare("PRAGMA table_info(produtos)").all().map(c => c.name);
if (!cols.includes('imagem')) db.exec("ALTER TABLE produtos ADD COLUMN imagem TEXT NOT NULL DEFAULT ''");
if (!cols.includes('usa_tabela')) {
  db.exec("ALTER TABLE produtos ADD COLUMN usa_tabela INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE produtos SET usa_tabela = 1 WHERE categoria LIKE 'Placas%'"); // placas NFC + QR seguem a tabela atual de vendas
}

// Carga inicial: roda uma única vez (marcada em settings), assim o que você editar/excluir depois não volta.
const jaSemeou = db.prepare("SELECT valor FROM settings WHERE chave = 'catalogo_seed'").get();
if (!jaSemeou) {
  const P = 'Placas NFC + QR Code', D = 'Displays';
  const itens = [
    [P, 'Avaliações Google — azul e preta', 'NFC + QR Code · leva direto às avaliações do Google', '#1d4ed8', 13.5, 1],
    [P, 'Placa Pix — preta', 'NFC + QR Code · pagamento por Pix', '#111111', 13.5, 1],
    [P, 'Instagram — degradê', 'NFC + QR Code · abre o perfil no Instagram', '#d6249f', 13.5, 1],
    [P, 'Placa acrílica redes sociais 10×10', 'NFC + QR Code · acrílico 10×10 cm', '#7c3aed', 25, 1],
    [P, 'WhatsApp', 'NFC + QR Code · abre a conversa no WhatsApp', '#22c55e', 13.5, 1],
    [D, 'Display Google — preto', 'Display de balcão · avaliações do Google', '#111111', 21, 0],
    [D, 'Display Google — branco', 'Display de balcão · avaliações do Google', '#e5e7eb', 21, 0],
    [D, 'Display Instagram 10×14', 'Display de balcão 10×14 cm', '#d6249f', 21, 0],
    [D, 'Display Redes Sociais 10×14', 'Display de balcão 10×14 cm', '#7c3aed', 21, 0],
    [D, 'Display WhatsApp', 'Display de balcão · abre o WhatsApp', '#22c55e', 21, 0],
  ];
  const ins = db.prepare('INSERT INTO produtos (categoria, nome, descricao, cor, custo, pedido_ativo, ordem, usa_tabela) VALUES (?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    itens.forEach((x, i) => ins.run(x[0], x[1], x[2], x[3], x[4], x[5], i + 1, x[0] === P ? 1 : 0));
    db.prepare("INSERT OR REPLACE INTO settings (chave, valor) VALUES ('catalogo_seed', '1')").run();
  })();
}

// Placas de restaurante (mesa e menu quadrada), com cardápio digital. Roda uma vez; se você já cadastrou com o mesmo nome, não duplica.
if (!db.prepare("SELECT 1 FROM settings WHERE chave = 'catalogo_restaurante_v1'").get()) {
  const ja = n => db.prepare('SELECT 1 FROM produtos WHERE nome = ?').get(n);
  const max = db.prepare('SELECT COALESCE(MAX(ordem),0) AS m FROM produtos').get().m;
  const ins = db.prepare("INSERT INTO produtos (categoria, nome, descricao, cor, custo, pedido_ativo, ordem, usa_tabela, ativo) VALUES ('Placas NFC + QR Code', ?, ?, ?, 13.5, 0, ?, 1, 0)");
  if (!ja('Placa Restaurante — mesa')) ins.run('Placa Restaurante — mesa', 'NFC + QR Code · cardápio digital, fidelidade, Wi-Fi e avaliações', '#16a34a', max + 1);
  if (!ja('Placa Menu — quadrada')) ins.run('Placa Menu — quadrada', 'NFC + QR Code · "Aproxime para ver o menu"', '#111111', max + 2);
  db.prepare("INSERT OR REPLACE INTO settings (chave, valor) VALUES ('catalogo_restaurante_v1', '1')").run();
}

// As placas de restaurante ainda não são vendidas no site: ficam ocultas até você ativar em Catálogo. Roda uma vez (não desfaz uma ativação futura).
if (!db.prepare("SELECT 1 FROM settings WHERE chave = 'catalogo_restaurante_oculto_v1'").get()) {
  db.prepare("UPDATE produtos SET ativo = 0, pedido_ativo = 0 WHERE nome IN ('Placa Restaurante — mesa', 'Placa Menu — quadrada')").run();
  db.prepare("INSERT OR REPLACE INTO settings (chave, valor) VALUES ('catalogo_restaurante_oculto_v1', '1')").run();
}

// Agora todas as placas NFC + QR são pedidas online (checkout do Mercado Pago). Roda uma vez; displays seguem sob consulta.
if (!db.prepare("SELECT 1 FROM settings WHERE chave = 'catalogo_placas_online'").get()) {
  db.prepare("UPDATE produtos SET pedido_ativo = 1 WHERE categoria LIKE 'Placas%' AND usa_tabela = 1").run();
  db.prepare("INSERT OR REPLACE INTO settings (chave, valor) VALUES ('catalogo_placas_online', '1')").run();
}

const pastaImg = path.join(path.dirname(db.meta.arquivo), 'catalogo-img');
fs.mkdirSync(pastaImg, { recursive: true });
const router = express.Router();
router.use('/catalogo-img', express.static(pastaImg, { maxAge: '30d', immutable: true }));
const num = v => (v === '' || v === null || v === undefined || !isFinite(Number(v)) || Number(v) < 0) ? null : Math.round(Number(v) * 100) / 100;

// Público: só o que o cliente pode ver (sem custo). preco = null → "preço em breve".
// usa_tabela = 1 → o preço é o da tabela atual de vendas (tiers), que vai junto na resposta.
router.get('/api/public/catalogo', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({
    produtos: db.prepare('SELECT id, categoria, nome, descricao, cor, preco, pedido_ativo, imagem, usa_tabela FROM produtos WHERE ativo = 1 ORDER BY ordem, id').all(),
    tiers: db.prepare('SELECT min_qty, max_qty, unit_price FROM price_tiers ORDER BY min_qty').all(),
  });
});

const adm = express.Router();
adm.use(requireAdmin);
adm.get('/', (req, res) => res.json(db.prepare('SELECT * FROM produtos ORDER BY ordem, id').all()));
adm.post('/', (req, res) => {
  const b = req.body || {};
  const nome = String(b.nome || '').trim(), categoria = String(b.categoria || '').trim();
  if (!nome || !categoria) return res.status(400).json({ error: 'Informe categoria e nome.' });
  const ordem = (db.prepare('SELECT COALESCE(MAX(ordem),0)+1 n FROM produtos').get().n);
  const r = db.prepare('INSERT INTO produtos (categoria, nome, descricao, cor, custo, preco, ordem) VALUES (?,?,?,?,?,?,?)')
    .run(categoria, nome, String(b.descricao || '').trim(), /^#[0-9a-f]{6}$/i.test(b.cor) ? b.cor : '#0f9d4e', num(b.custo) || 0, num(b.preco), ordem);
  res.json({ id: r.lastInsertRowid });
});
adm.put('/:id', (req, res) => {
  const id = Number(req.params.id), p = db.prepare('SELECT * FROM produtos WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'Produto não encontrado.' });
  const b = req.body || {};
  const nome = b.nome !== undefined ? String(b.nome).trim() : p.nome;
  if (!nome) return res.status(400).json({ error: 'O nome não pode ficar vazio.' });
  db.prepare('UPDATE produtos SET nome=?, descricao=?, categoria=?, custo=?, preco=?, ativo=?, usa_tabela=? WHERE id=?').run(
    nome, b.descricao !== undefined ? String(b.descricao).trim() : p.descricao,
    b.categoria !== undefined ? (String(b.categoria).trim() || p.categoria) : p.categoria,
    b.custo !== undefined ? (num(b.custo) ?? p.custo) : p.custo,
    b.preco !== undefined ? num(b.preco) : p.preco,
    b.ativo !== undefined ? (b.ativo ? 1 : 0) : p.ativo,
    b.usa_tabela !== undefined ? (b.usa_tabela ? 1 : 0) : p.usa_tabela, id);
  res.json({ ok: true });
});
// Imagem do produto: o painel manda a foto já reduzida (data URL). Salva no Volume e troca no site na hora.
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const apagaImg = url => { if (/^\/catalogo-img\/[\w.-]+$/.test(url || '')) fs.unlink(path.join(pastaImg, path.basename(url)), () => {}); };
adm.put('/:id/imagem', (req, res) => {
  const id = Number(req.params.id), p = db.prepare('SELECT imagem FROM produtos WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'Produto não encontrado.' });
  const b = req.body || {};
  if (b.remover) { apagaImg(p.imagem); db.prepare("UPDATE produtos SET imagem = '' WHERE id = ?").run(id); return res.json({ imagem: '' }); }
  if (typeof b.url === 'string' && b.url.trim()) { // link externo (https) em vez de arquivo
    const u = b.url.trim();
    if (!/^https:\/\/[^\s"'<>]+$/i.test(u)) return res.status(400).json({ error: 'Use um link https válido.' });
    apagaImg(p.imagem); db.prepare('UPDATE produtos SET imagem = ? WHERE id = ?').run(u, id); return res.json({ imagem: u });
  }
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
  if (!m) return res.status(400).json({ error: 'Envie uma imagem JPG, PNG ou WebP.' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) return res.status(400).json({ error: 'Imagem grande demais (máx. 3 MB).' });
  const nome = `p${id}-${Date.now()}.${EXT[m[1]]}`;
  fs.writeFileSync(path.join(pastaImg, nome), buf);
  apagaImg(p.imagem);
  const url = '/catalogo-img/' + nome;
  db.prepare('UPDATE produtos SET imagem = ? WHERE id = ?').run(url, id);
  res.json({ imagem: url });
});
router.use('/api/admin/catalogo', express.json({ limit: '4mb' }), adm);

const arq = f => (req, res) => res.sendFile(path.join(__dirname, f));
router.get('/catalogo-front.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'catalogo-front.js')));
router.get(['/admin/catalogo', '/admin/catalogo/'], arq('catalogo.html'));

module.exports = router;
