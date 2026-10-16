// Prospecção de empresas locais (admin) — ARQUIVO NOVO.
// Cadastro das empresas, status do funil de vendas, histórico de contatos (visita, WhatsApp, ligação) e retorno agendado.
// Rotas: /api/admin/prospeccao (lista, cria, importa, edita, apaga, registra contato).
const express = require('express');
const db = require('./database.js');
const { requireAdmin } = require('./auth-middleware.js');

const router = express.Router();
const STATUS = ['novo', 'abordado', 'interessado', 'orcamento', 'fechado', 'perdido'];
const TIPOS = ['visita', 'whatsapp', 'ligacao', 'nota'];
const txt = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const data = v => (/^\d{4}-\d\d-\d\d$/.test(String(v || '')) ? v : null);
const digitos = v => String(v || '').replace(/\D/g, '');
const agora = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function campos(b) {
  b = b || {};
  const nome = txt(b.nome, 120);
  if (!nome) return { erro: 'Informe o nome da empresa.' };
  const status = STATUS.includes(b.status) ? b.status : 'novo';
  return { d: {
    nome, segmento: txt(b.segmento, 40), contato: txt(b.contato, 80), telefone: txt(b.telefone, 25), instagram: txt(b.instagram, 60).replace(/^@/, ''),
    endereco: txt(b.endereco, 160), bairro: txt(b.bairro, 60), obs: String(b.obs ?? '').trim().slice(0, 800),
    status, prox_contato: data(b.prox_contato), motivo_perda: status === 'perdido' ? txt(b.motivo_perda, 120) : '',
  } };
}

const LISTA = `SELECT p.*, (SELECT COUNT(*) FROM prospecto_hist h WHERE h.prospecto_id = p.id) AS contatos,
  (SELECT MAX(h.criado_em) FROM prospecto_hist h WHERE h.prospecto_id = p.id AND h.tipo <> 'nota') AS ultimo_contato FROM prospectos p`;

router.get('/api/admin/prospeccao', requireAdmin, (req, res) => {
  res.json(db.prepare(LISTA + ' ORDER BY p.atualizado_em DESC, p.id DESC LIMIT 2000').all());
});

router.post('/api/admin/prospeccao', requireAdmin, (req, res) => {
  const v = campos(req.body); if (v.erro) return res.status(400).json({ error: v.erro });
  const r = db.prepare(`INSERT INTO prospectos (nome, segmento, contato, telefone, instagram, endereco, bairro, obs, status, prox_contato, motivo_perda)
    VALUES (@nome, @segmento, @contato, @telefone, @instagram, @endereco, @bairro, @obs, @status, @prox_contato, @motivo_perda)`).run(v.d);
  res.json(db.prepare(LISTA + ' WHERE p.id = ?').get(r.lastInsertRowid));
});

// Cola uma lista: uma empresa por linha — "Nome; telefone; segmento; bairro" (separador ; ou tab ou |).
router.post('/api/admin/prospeccao/importar', requireAdmin, (req, res) => {
  const linhas = String((req.body || {}).texto || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 500);
  const segPadrao = txt((req.body || {}).segmento, 40);
  const tem = db.prepare('SELECT id, telefone FROM prospectos WHERE lower(nome) = lower(?)');
  const ins = db.prepare('INSERT INTO prospectos (nome, telefone, segmento, bairro) VALUES (?, ?, ?, ?)');
  let novos = 0, repetidos = 0;
  db.transaction(() => {
    for (const l of linhas) {
      const [nome, tel, seg, bairro] = l.split(/\s*[;\t|]\s*/).map(x => txt(x, 120));
      if (!nome) continue;
      const igual = tem.all(nome).some(p => !tel || !p.telefone || digitos(p.telefone) === digitos(tel));
      if (igual) { repetidos++; continue; }
      ins.run(nome, txt(tel, 25), txt(seg, 40) || segPadrao, txt(bairro, 60)); novos++;
    }
  })();
  res.json({ novos, repetidos });
});

router.get('/api/admin/prospeccao/:id', requireAdmin, (req, res) => {
  const p = db.prepare(LISTA + ' WHERE p.id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Empresa não encontrada.' });
  p.historico = db.prepare('SELECT id, tipo, texto, criado_em FROM prospecto_hist WHERE prospecto_id = ? ORDER BY id DESC LIMIT 200').all(p.id);
  res.json(p);
});

router.put('/api/admin/prospeccao/:id', requireAdmin, (req, res) => {
  const v = campos(req.body); if (v.erro) return res.status(400).json({ error: v.erro });
  const r = db.prepare(`UPDATE prospectos SET nome=@nome, segmento=@segmento, contato=@contato, telefone=@telefone, instagram=@instagram, endereco=@endereco,
    bairro=@bairro, obs=@obs, status=@status, prox_contato=@prox_contato, motivo_perda=@motivo_perda, atualizado_em=datetime('now') WHERE id=@id`).run({ ...v.d, id: Number(req.params.id) });
  if (!r.changes) return res.status(404).json({ error: 'Empresa não encontrada.' });
  res.json(db.prepare(LISTA + ' WHERE p.id = ?').get(req.params.id));
});

router.delete('/api/admin/prospeccao/:id', requireAdmin, (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM prospecto_hist WHERE prospecto_id = ?').run(req.params.id);
    db.prepare('DELETE FROM prospectos WHERE id = ?').run(req.params.id);
  })();
  res.json({ ok: true });
});

// Registra um contato (visita, WhatsApp, ligação) ou nota; opcionalmente muda o status e agenda o retorno.
router.post('/api/admin/prospeccao/:id/contato', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM prospectos WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Empresa não encontrada.' });
  const b = req.body || {};
  const tipo = TIPOS.includes(b.tipo) ? b.tipo : 'nota';
  const texto = String(b.texto ?? '').trim().slice(0, 800);
  const status = STATUS.includes(b.status) ? b.status : p.status;
  const prox = b.prox_contato === '' ? null : (data(b.prox_contato) || p.prox_contato);
  if (!texto && tipo === 'nota') return res.status(400).json({ error: 'Escreva a anotação.' });
  db.transaction(() => {
    db.prepare('INSERT INTO prospecto_hist (prospecto_id, tipo, texto, criado_em) VALUES (?, ?, ?, ?)').run(p.id, tipo, texto || 'Contato registrado', agora());
    // Quem ainda era "novo" e recebeu um contato passa a "abordado" automaticamente.
    const novoStatus = status === 'novo' && tipo !== 'nota' ? 'abordado' : status;
    db.prepare("UPDATE prospectos SET status = ?, prox_contato = ?, motivo_perda = ?, atualizado_em = datetime('now') WHERE id = ?")
      .run(novoStatus, prox, novoStatus === 'perdido' ? txt(b.motivo_perda, 120) || p.motivo_perda : '', p.id);
  })();
  res.json(db.prepare(LISTA + ' WHERE p.id = ?').get(p.id));
});

module.exports = router;
