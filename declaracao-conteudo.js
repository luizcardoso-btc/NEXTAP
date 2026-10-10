// Declaração de conteúdo em PDF — ARQUIVO NOVO. Não altera nenhum arquivo existente.
// - Gera o PDF de cada pedido PAGO automaticamente (confere a cada minuto) e guarda no Volume (pasta "declaracoes").
// - Admin: página /admin/declaracao (lista os pedidos, baixa o PDF, edita os dados do remetente).
// - API (exige login de admin): /api/admin/declaracao/...
// Dados do remetente ficam na tabela existente "settings" (chaves rem_*), então não há migração nem tabela alterada.
const express = require('express');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const db = require('./database.js');
const { requireAdmin } = require('./auth-middleware.js');

const router = express.Router();

// ---------- armazenamento ----------
const pasta = path.join(path.dirname(db.meta.arquivo), 'declaracoes');
fs.mkdirSync(pasta, { recursive: true });
db.exec(`CREATE TABLE IF NOT EXISTS declaracoes (
  order_id INTEGER PRIMARY KEY, arquivo TEXT NOT NULL, gerada_em TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Registro da NF-e de cada pedido (número/chave da nota emitida no seu emissor). Só guarda; não emite nada.
db.exec(`CREATE TABLE IF NOT EXISTS nfe_pedido (
  order_id INTEGER PRIMARY KEY, numero TEXT, serie TEXT, chave TEXT, protocolo TEXT,
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
)`);
const nfeDe = id => db.prepare('SELECT numero, serie, chave, protocolo, atualizado_em FROM nfe_pedido WHERE order_id = ?').get(id) || null;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- configuração (tabela settings) ----------
const CHAVES = {
  rem_nome: '', rem_doc: '', rem_cep: '', rem_rua: '', rem_numero: '', rem_complemento: '', rem_bairro: '',
  rem_cidade: '', rem_uf: '',
  decl_descricao: 'Placa NFC de avaliação do Google',
  decl_peso_unit_kg: '0.1',
  decl_modo: 'com_nfe', // com_nfe = mercadoria acompanha NF-e | nao_contribuinte = texto padrão dos Correios
};
const getSet = db.prepare('SELECT valor FROM settings WHERE chave = ?');
const putSet = db.prepare(`INSERT INTO settings (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`);
function lerConfig() {
  const c = {};
  for (const k of Object.keys(CHAVES)) { const r = getSet.get(k); c[k] = r ? r.valor : CHAVES[k]; }
  return c;
}
const limpa = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------- formatação ----------
const BRL = n => 'R$ ' + Number(n || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const dataBR = d => (d ? new Date(String(d).replace(' ', 'T') + 'Z') : new Date())
  .toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const numPedido = id => '#' + String(id).padStart(5, '0');
const cepFmt = c => { const d = String(c || '').replace(/\D/g, ''); return d.length === 8 ? d.slice(0, 5) + '-' + d.slice(5) : (c || ''); };
const docFmt = v => {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return v || '';
};
const endereco = (rua, num, comp, bairro) =>
  [rua, num && 'nº ' + num, comp, bairro].filter(Boolean).join(', ');

// ---------- dados do pedido ----------
function dadosPedido(orderId) {
  const o = db.prepare(`SELECT o.*, r.name AS r_nome, r.email AS r_email, r.whatsapp AS r_whats,
      r.addr_cep, r.addr_street, r.addr_number, r.addr_complement, r.addr_district, r.addr_city, r.addr_state
    FROM orders o JOIN resellers r ON r.id = o.reseller_id WHERE o.id = ?`).get(orderId);
  if (!o) return null;
  // Destinatário: endereço de entrega do pedido; se vier vazio, usa o endereço cadastrado do revendedor.
  const entrega = o.ship_street || o.ship_cep;
  return {
    pedido: o,
    dest: {
      nome: o.ship_name || o.r_nome,
      cep: entrega ? o.ship_cep : o.addr_cep,
      rua: entrega ? o.ship_street : o.addr_street,
      numero: entrega ? o.ship_number : o.addr_number,
      complemento: entrega ? o.ship_complement : o.addr_complement,
      bairro: entrega ? o.ship_district : o.addr_district,
      cidade: entrega ? o.ship_city : o.addr_city,
      uf: entrega ? o.ship_state : o.addr_state,
    },
  };
}

// ---------- PDF ----------
function gerarPdf(orderId) {
  const d = dadosPedido(orderId);
  if (!d) throw new Error('Pedido não encontrado.');
  const cfg = lerConfig();
  const { pedido: o, dest } = d;

  const itens = [];
  if (o.qty_azul > 0) itens.push({ desc: `${cfg.decl_descricao} (cor azul)`, qtd: o.qty_azul });
  if (o.qty_preta > 0) itens.push({ desc: `${cfg.decl_descricao} (cor preta)`, qtd: o.qty_preta });
  itens.forEach(i => { i.unit = Number(o.unit_price) || 0; i.total = i.unit * i.qtd; });
  const qtdTotal = itens.reduce((s, i) => s + i.qtd, 0);
  const valorTotal = itens.reduce((s, i) => s + i.total, 0);
  const peso = qtdTotal * (Number(cfg.decl_peso_unit_kg) || 0);

  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Declaração de conteúdo ${numPedido(orderId)}`, Author: cfg.rem_nome || 'NexTap' } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const pronto = new Promise(res => doc.on('end', () => res(Buffer.concat(chunks))));

  const L = 40, W = doc.page.width - 80;
  const faixa = (titulo) => {
    doc.moveDown(0.6);
    const y = doc.y;
    doc.rect(L, y, W, 18).fill('#e5e7eb');
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(10).text(titulo, L + 6, y + 5, { width: W - 12 });
    doc.y = y + 24; doc.x = L;
  };
  const campo = (rotulo, valor, x, y, w) => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#555').text(rotulo, x, y, { width: w });
    doc.font('Helvetica').fontSize(10).fillColor('#111').text(valor || '—', x, y + 10, { width: w });
  };
  const bloco = (p) => {
    const y = doc.y;
    campo('NOME / RAZÃO SOCIAL', p.nome, L, y, W * 0.62);
    campo('CPF / CNPJ', docFmt(p.doc), L + W * 0.64, y, W * 0.36);
    campo('ENDEREÇO', endereco(p.rua, p.numero, p.complemento, p.bairro), L, y + 30, W * 0.62);
    campo('CEP', cepFmt(p.cep), L + W * 0.64, y + 30, W * 0.36);
    campo('CIDADE / UF', [p.cidade, p.uf].filter(Boolean).join(' / '), L, y + 60, W * 0.62);
    doc.y = y + 88; doc.x = L;
  };

  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111').text('DECLARAÇÃO DE CONTEÚDO', L, 40, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor('#555')
    .text(`Pedido NexTap ${numPedido(orderId)}  ·  emitida em ${dataBR()}`, L, doc.y + 2, { width: W, align: 'center' });
  doc.x = L;

  faixa('REMETENTE');
  bloco({ nome: cfg.rem_nome, doc: cfg.rem_doc, cep: cfg.rem_cep, rua: cfg.rem_rua, numero: cfg.rem_numero,
          complemento: cfg.rem_complemento, bairro: cfg.rem_bairro, cidade: cfg.rem_cidade, uf: cfg.rem_uf });

  faixa('DESTINATÁRIO');
  bloco({ nome: dest.nome, doc: '', cep: dest.cep, rua: dest.rua, numero: dest.numero, complemento: dest.complemento,
          bairro: dest.bairro, cidade: dest.cidade, uf: dest.uf });

  faixa('IDENTIFICAÇÃO DOS BENS');
  const col = [W * 0.08, W * 0.52, W * 0.10, W * 0.15, W * 0.15];
  const cab = ['ITEM', 'CONTEÚDO', 'QUANT.', 'VALOR UNIT.', 'VALOR TOTAL'];
  const linha = (cels, bold, fundo) => {
    const y = doc.y;
    if (fundo) doc.rect(L, y, W, 20).fill(fundo);
    let x = L;
    cels.forEach((t, i) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#111')
        .text(String(t), x + 4, y + 6, { width: col[i] - 8, align: i >= 2 ? 'right' : 'left', lineBreak: false });
      x += col[i];
    });
    doc.rect(L, y, W, 20).lineWidth(0.5).strokeColor('#9ca3af').stroke();
    doc.y = y + 20; doc.x = L;
  };
  linha(cab, true, '#f3f4f6');
  itens.forEach((i, n) => linha([n + 1, i.desc, i.qtd, BRL(i.unit), BRL(i.total)]));
  linha(['', 'TOTAL', qtdTotal, '', BRL(valorTotal)], true, '#f9fafb');
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(10).fillColor('#111')
    .text(`Peso total estimado: ${peso.toFixed(2).replace('.', ',')} kg`, L, doc.y, { width: W });

  faixa('DECLARAÇÃO');
  const texto = cfg.decl_modo === 'nao_contribuinte'
    ? 'Declaro que não me enquadro no conceito de contribuinte previsto no art. 4º da Lei Complementar nº 87/1996, uma vez que não realizo, com habitualidade ou em volume que caracterize intuito comercial, operações de circulação de mercadoria, ainda que se iniciem no exterior, ou estou dispensado da emissão da nota fiscal por força da legislação tributária vigente, responsabilizando-me, nos termos da lei e a quem de direito, por informações inverídicas.'
    : 'Declaro que a mercadoria acima é acompanhada de Nota Fiscal Eletrônica (NF-e) emitida pelo remetente, e que as informações aqui prestadas são verdadeiras, responsabilizando-me, nos termos da lei e a quem de direito, por informações inverídicas.';
  doc.font('Helvetica').fontSize(9).fillColor('#111').text(texto, L, doc.y, { width: W, align: 'justify' });
  doc.moveDown(0.5);
  doc.text('Declaro ainda que não estou postando conteúdo cuja proibição de envio está prevista na legislação postal.', L, doc.y, { width: W, align: 'justify' });

  if (cfg.decl_modo !== 'nao_contribuinte') {
    doc.moveDown(0.8);
    const nf = nfeDe(orderId);
    if (nf && (nf.numero || nf.chave)) {
      doc.font('Helvetica-Bold').fontSize(9).text(`NF-e nº ${nf.numero || '—'}${nf.serie ? '  ·  série ' + nf.serie : ''}`, L, doc.y, { width: W });
      doc.font('Helvetica').fontSize(8).text(`Chave de acesso: ${nf.chave || '—'}`, L, doc.y + 2, { width: W });
    } else {
      doc.font('Helvetica-Bold').fontSize(9).text('NF-e nº ________________   Chave de acesso: ____________________________________________', L, doc.y, { width: W });
    }
  }

  doc.moveDown(2.2);
  const y = doc.y;
  doc.font('Helvetica').fontSize(10).text(`${cfg.rem_cidade || '____________________'}, ${dataBR()}`, L, y, { width: W * 0.45 });
  doc.moveTo(L + W * 0.52, y + 14).lineTo(L + W, y + 14).lineWidth(0.7).strokeColor('#111').stroke();
  doc.fontSize(8).fillColor('#555').text('Assinatura do remetente', L + W * 0.52, y + 18, { width: W * 0.48, align: 'center' });

  doc.end();
  return pronto;
}

// ---------- gravação ----------
async function gerarEGuardar(orderId) {
  const buf = await gerarPdf(orderId);
  const nome = `declaracao-pedido-${String(orderId).padStart(5, '0')}.pdf`;
  fs.writeFileSync(path.join(pasta, nome + '.tmp'), buf);
  fs.renameSync(path.join(pasta, nome + '.tmp'), path.join(pasta, nome)); // gravação segura
  db.prepare(`INSERT INTO declaracoes (order_id, arquivo, gerada_em) VALUES (?, ?, datetime('now'))
              ON CONFLICT(order_id) DO UPDATE SET arquivo = excluded.arquivo, gerada_em = excluded.gerada_em`).run(orderId, nome);
  return path.join(pasta, nome);
}

// Pedidos pagos (pago, em produção, enviado, entregue) que ainda não têm declaração.
const PAGOS = `('pago','em_producao','enviado','entregue')`;
async function gerarPendentes() {
  const ids = db.prepare(`SELECT id FROM orders WHERE status IN ${PAGOS}
    AND id NOT IN (SELECT order_id FROM declaracoes) ORDER BY id`).all().map(r => r.id);
  let n = 0;
  for (const id of ids) {
    try { await gerarEGuardar(id); n++; } catch (e) { console.error(`[DECLARAÇÃO] pedido ${id}:`, e.message); }
  }
  if (n) console.log(`[DECLARAÇÃO] ${n} declaração(ões) gerada(s) automaticamente.`);
  return n;
}
setTimeout(() => gerarPendentes().catch(() => {}), 10 * 1000).unref();
setInterval(() => gerarPendentes().catch(() => {}), 60 * 1000).unref();

// ---------- API do admin ----------
const api = express.Router();
api.use(requireAdmin);

api.get('/config', (req, res) => res.json(lerConfig()));
api.put('/config', (req, res) => {
  const b = req.body || {};
  const tam = { rem_nome: 120, rem_doc: 20, rem_cep: 9, rem_rua: 120, rem_numero: 12, rem_complemento: 60, rem_bairro: 60,
                rem_cidade: 60, rem_uf: 2, decl_descricao: 120 };
  db.transaction(() => {
    for (const k of Object.keys(tam)) if (b[k] !== undefined) putSet.run(k, limpa(b[k], tam[k]));
    if (b.decl_peso_unit_kg !== undefined) {
      const p = Number(String(b.decl_peso_unit_kg).replace(',', '.'));
      if (Number.isFinite(p) && p >= 0 && p <= 50) putSet.run('decl_peso_unit_kg', String(p));
    }
    if (['com_nfe', 'nao_contribuinte'].includes(b.decl_modo)) putSet.run('decl_modo', b.decl_modo);
  })();
  res.json(lerConfig());
});

api.get('/pedidos', (req, res) => {
  const rows = db.prepare(`SELECT o.id, o.status, o.qty_azul + o.qty_preta AS qtd, o.total, o.created_at, o.paid_at,
      r.name AS revendedor, o.ship_city, o.ship_state, d.gerada_em, n.numero AS nfe_numero, n.chave AS nfe_chave
    FROM orders o JOIN resellers r ON r.id = o.reseller_id LEFT JOIN declaracoes d ON d.order_id = o.id
    LEFT JOIN nfe_pedido n ON n.order_id = o.id
    WHERE o.status IN ${PAGOS} ORDER BY o.id DESC LIMIT 300`).all();
  res.json(rows.map(r => ({ ...r, numero: numPedido(r.id), tem_pdf: !!r.gerada_em, tem_nfe: !!(r.nfe_numero || r.nfe_chave) })));
});

// ---- NF-e: registro do número/chave e ficha de dados para emitir no seu emissor ----
const pagoOk = id => { const o = db.prepare('SELECT status FROM orders WHERE id = ?').get(id); return o && ['pago', 'em_producao', 'enviado', 'entregue'].includes(o.status); };

api.get('/nfe/:id', (req, res) => {
  const id = Number(req.params.id);
  const d = dadosPedido(id);
  if (!d) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const o = d.pedido;
  const itens = [];
  if (o.qty_azul > 0) itens.push({ desc: 'azul', qtd: o.qty_azul });
  if (o.qty_preta > 0) itens.push({ desc: 'preta', qtd: o.qty_preta });
  res.json({
    pedido: numPedido(id), status: o.status, destinatario: d.dest.nome, cidade: [d.dest.cidade, d.dest.uf].filter(Boolean).join('/'),
    qtd: o.qty_azul + o.qty_preta, valor_produtos: Math.round((o.qty_azul + o.qty_preta) * o.unit_price * 100) / 100,
    frete: o.shipping_fee || 0, nfe: nfeDe(id) || { numero: '', serie: '', chave: '', protocolo: '' },
    remetente_ok: !!lerConfig().rem_nome,
  });
});

api.put('/nfe/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!pagoOk(id)) return res.status(409).json({ error: 'O pedido precisa estar pago.' });
  const b = req.body || {};
  const numero = limpa(b.numero, 12).replace(/\D/g, '');
  const serie = limpa(b.serie, 5).replace(/\D/g, '');
  const chave = limpa(b.chave, 60).replace(/\D/g, '');
  const protocolo = limpa(b.protocolo, 20).replace(/\D/g, '');
  if (chave && chave.length !== 44) return res.status(400).json({ error: 'A chave de acesso tem 44 números. Confira e tente de novo.' });
  if (!numero && !chave && !serie && !protocolo) db.prepare('DELETE FROM nfe_pedido WHERE order_id = ?').run(id);
  else db.prepare(`INSERT INTO nfe_pedido (order_id, numero, serie, chave, protocolo, atualizado_em) VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(order_id) DO UPDATE SET numero = excluded.numero, serie = excluded.serie, chave = excluded.chave,
      protocolo = excluded.protocolo, atualizado_em = excluded.atualizado_em`).run(id, numero, serie, chave, protocolo);
  try { await gerarEGuardar(id); } catch (e) { /* o PDF é refeito no próximo download */ }
  res.json({ ok: true, nfe: nfeDe(id) || { numero: '', serie: '', chave: '', protocolo: '' } });
});

// Ficha para imprimir/consultar: reúne os dados do pedido na ordem em que os emissores pedem. NÃO é a nota fiscal.
api.get('/nfe/:id/ficha', (req, res) => {
  const id = Number(req.params.id);
  const d = dadosPedido(id);
  if (!d) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const cfg = lerConfig(), o = d.pedido, de = d.dest, nf = nfeDe(id) || {};
  const linhas = [];
  if (o.qty_azul > 0) linhas.push([`${cfg.decl_descricao} (cor azul)`, o.qty_azul]);
  if (o.qty_preta > 0) linhas.push([`${cfg.decl_descricao} (cor preta)`, o.qty_preta]);
  const pre = '<span style="color:#b91c1c">preencher</span>';
  const v = x => (x ? esc(x) : pre);
  const itens = linhas.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l[0])}</td><td>${pre}</td><td>${pre}</td><td>${l[1]}</td><td>UN</td><td>${BRL(o.unit_price)}</td><td>${BRL(l[1] * o.unit_price)}</td></tr>`).join('');
  const prod = linhas.reduce((s, l) => s + l[1] * o.unit_price, 0);
  res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Dados NF-e pedido ${numPedido(id)}</title>
<style>body{font:13px/1.45 Arial,sans-serif;margin:24px;color:#111}h1{font-size:17px;margin:0 0 4px}h2{font-size:13px;background:#e5e7eb;padding:4px 8px;margin:14px 0 0}table{width:100%;border-collapse:collapse}td,th{border:1px solid #9ca3af;padding:5px 8px;text-align:left;vertical-align:top}th{width:32%;background:#f3f4f6;font-weight:600}.i th{width:auto}.av{border:2px solid #b91c1c;padding:8px;margin:10px 0;font-weight:700;color:#b91c1c}@media print{.np{display:none}}</style></head><body>
<button class="np" onclick="print()" style="float:right;padding:8px 14px">Imprimir</button>
<h1>Ficha de dados para emissão da NF-e</h1><div>NexTap · Pedido ${numPedido(id)} · gerada em ${dataBR()}</div>
<div class="av">ESTA FICHA NÃO É A NF-e. Use estes dados no seu emissor de NF-e e depois registre o número e a chave da nota no painel.</div>
<h2>1. Emitente</h2><table><tr><th>Nome / razão social</th><td>${v(cfg.rem_nome)}</td></tr><tr><th>CPF / CNPJ</th><td>${v(docFmt(cfg.rem_doc))}</td></tr>
<tr><th>Endereço de origem</th><td>${v(endereco(cfg.rem_rua, cfg.rem_numero, cfg.rem_complemento, cfg.rem_bairro))}</td></tr><tr><th>Cidade / UF / CEP</th><td>${v([cfg.rem_cidade, cfg.rem_uf].filter(Boolean).join('/'))} · ${v(cepFmt(cfg.rem_cep))}</td></tr></table>
<h2>2. Destinatário</h2><table><tr><th>Nome / razão social</th><td>${v(de.nome)}</td></tr><tr><th>CPF / CNPJ</th><td>${pre}</td></tr>
<tr><th>Endereço</th><td>${v(endereco(de.rua, de.numero, de.complemento, de.bairro))}</td></tr><tr><th>Cidade / UF</th><td>${v([de.cidade, de.uf].filter(Boolean).join('/'))}</td></tr>
<tr><th>CEP</th><td>${v(cepFmt(de.cep))}</td></tr><tr><th>Telefone</th><td>${v(o.ship_phone || o.r_whats)}</td></tr><tr><th>E-mail</th><td>${v(o.r_email)}</td></tr></table>
<h2>3. Itens</h2><table class="i"><tr><th>#</th><th>Descrição</th><th>NCM</th><th>CFOP</th><th>Qtd</th><th>Un.</th><th>Valor unit.</th><th>Valor total</th></tr>${itens}
<tr><td colspan="7"><b>Valor dos produtos</b></td><td><b>${BRL(prod)}</b></td></tr><tr><td colspan="7">Frete cobrado</td><td>${BRL(o.shipping_fee || 0)}</td></tr></table>
<p style="font-size:11px;color:#555;margin:4px 0 0">NCM e CFOP: defina com o seu contador (dependem do enquadramento da venda). Não preenchi por conta própria.</p>
<h2>4. Transporte</h2><table><tr><th>Modalidade / serviço</th><td>${esc(o.shipping_service || 'Correios')}</td></tr><tr><th>Código de rastreio</th><td>${v(o.tracking_code)}</td></tr></table>
<h2>5. Informações adicionais</h2><table><tr><th>Referência</th><td>Pedido NexTap ${numPedido(id)}</td></tr><tr><th>Pagamento</th><td>${o.payment_method === 'pix' ? 'Pix' : o.payment_method === 'credit_card' ? 'Cartão de crédito' : pre}</td></tr></table>
<h2>6. Registro da nota emitida (guarde por 5 anos)</h2><table><tr><th>Número / série</th><td>${esc(nf.numero || '')} ${nf.serie ? '/ ' + esc(nf.serie) : ''}</td></tr><tr><th>Chave de acesso (44 dígitos)</th><td>${esc(nf.chave || '')}</td></tr><tr><th>Protocolo de autorização</th><td>${esc(nf.protocolo || '')}</td></tr></table>
</body></html>`);
});

router.get('/admin-declaracao.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'admin-declaracao.js')));

api.post('/gerar-pendentes', async (req, res) => res.json({ geradas: await gerarPendentes() }));

api.get('/pedido/:id.pdf', async (req, res) => {
  const id = Number(req.params.id);
  const o = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!['pago', 'em_producao', 'enviado', 'entregue'].includes(o.status)) {
    return res.status(409).json({ error: 'A declaração só é emitida depois que o pedido é pago.' });
  }
  try {
    const existe = db.prepare('SELECT arquivo FROM declaracoes WHERE order_id = ?').get(id);
    const caminho = (existe && !req.query.refazer && fs.existsSync(path.join(pasta, existe.arquivo)))
      ? path.join(pasta, existe.arquivo) : await gerarEGuardar(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(caminho)}"`);
    fs.createReadStream(caminho).pipe(res);
  } catch (e) {
    console.error('[DECLARAÇÃO] falha:', e.message);
    res.status(500).json({ error: 'Não foi possível gerar a declaração agora.' });
  }
});

router.use('/api/admin/declaracao', express.json({ limit: '100kb' }), api);
router.get(['/admin/declaracao', '/admin/declaracao/'], (req, res) =>
  res.sendFile(path.join(__dirname, 'declaracao.html')));

module.exports = router;
module.exports.gerarPendentes = gerarPendentes;
