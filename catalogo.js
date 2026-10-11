// Catálogo de produtos (esteira) — ARQUIVO NOVO. Não altera tabelas nem rotas existentes.
// - Tabela nova "produtos" (categorias: Placas NFC + QR, Displays). Os preços de venda ficam em branco até você definir.
// - Público: GET /api/public/catalogo (sem custo). Admin: /api/admin/catalogo e a página /admin/catalogo.
const express = require('express');
const path = require('path');
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

// Carga inicial: roda uma única vez (marcada em settings), assim o que você editar/excluir depois não volta.
const jaSemeou = db.prepare("SELECT valor FROM settings WHERE chave = 'catalogo_seed'").get();
if (!jaSemeou) {
  const P = 'Placas NFC + QR Code', D = 'Displays';
  const itens = [
    [P, 'Avaliações Google — azul e preta', 'NFC + QR Code · leva direto às avaliações do Google', '#1d4ed8', 13.5, 1],
    [P, 'Placa Pix — preta', 'NFC + QR Code · pagamento por Pix', '#111111', 13.5, 0],
    [P, 'Instagram — degradê', 'NFC + QR Code · abre o perfil no Instagram', '#d6249f', 13.5, 0],
    [P, 'Placa acrílica redes sociais 10×10', 'NFC + QR Code · acrílico 10×10 cm', '#7c3aed', 25, 0],
    [P, 'WhatsApp', 'NFC + QR Code · abre a conversa no WhatsApp', '#22c55e', 13.5, 0],
    [D, 'Display Google — preto', 'Display de balcão · avaliações do Google', '#111111', 21, 0],
    [D, 'Display Google — branco', 'Display de balcão · avaliações do Google', '#e5e7eb', 21, 0],
    [D, 'Display Instagram 10×14', 'Display de balcão 10×14 cm', '#d6249f', 21, 0],
    [D, 'Display Redes Sociais 10×14', 'Display de balcão 10×14 cm', '#7c3aed', 21, 0],
    [D, 'Display WhatsApp', 'Display de balcão · abre o WhatsApp', '#22c55e', 21, 0],
  ];
  const ins = db.prepare('INSERT INTO produtos (categoria, nome, descricao, cor, custo, pedido_ativo, ordem) VALUES (?,?,?,?,?,?,?)');
  db.transaction(() => {
    itens.forEach((x, i) => ins.run(x[0], x[1], x[2], x[3], x[4], x[5], i + 1));
    db.prepare("INSERT OR REPLACE INTO settings (chave, valor) VALUES ('catalogo_seed', '1')").run();
  })();
}

const router = express.Router();
const num = v => (v === '' || v === null || v === undefined || !isFinite(Number(v)) || Number(v) < 0) ? null : Math.round(Number(v) * 100) / 100;

// Público: só o que o cliente pode ver (sem custo). preco = null → "preço em breve".
router.get('/api/public/catalogo', (req, res) => {
  res.json(db.prepare('SELECT id, categoria, nome, descricao, cor, preco, pedido_ativo FROM produtos WHERE ativo = 1 ORDER BY ordem, id').all());
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
  db.prepare('UPDATE produtos SET nome=?, descricao=?, categoria=?, custo=?, preco=?, ativo=? WHERE id=?').run(
    nome, b.descricao !== undefined ? String(b.descricao).trim() : p.descricao,
    b.categoria !== undefined ? (String(b.categoria).trim() || p.categoria) : p.categoria,
    b.custo !== undefined ? (num(b.custo) ?? p.custo) : p.custo,
    b.preco !== undefined ? num(b.preco) : p.preco,
    b.ativo !== undefined ? (b.ativo ? 1 : 0) : p.ativo, id);
  res.json({ ok: true });
});
router.use('/api/admin/catalogo', express.json({ limit: '50kb' }), adm);

const arq = f => (req, res) => res.sendFile(path.join(__dirname, f));
router.get('/catalogo-front.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'catalogo-front.js')));
router.get(['/admin/catalogo', '/admin/catalogo/'], arq('catalogo.html'));

module.exports = router;
