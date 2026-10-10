/* Aba "Declaração e NF-e" e botões nos pedidos — ARQUIVO NOVO, carregado pelo admin.html.
   Usa as funções que o painel já tem (api, head, mo, cl, toast, baixarArq, E, R, pad5, draw...). */
var DECL = null, DCFG = null, DERR = '';
var DCAMPOS = [['rem_nome', 'Nome / razão social'], ['rem_doc', 'CPF / CNPJ'], ['rem_cep', 'CEP'], ['rem_rua', 'Rua'], ['rem_numero', 'Número'],
  ['rem_complemento', 'Complemento'], ['rem_bairro', 'Bairro'], ['rem_cidade', 'Cidade'], ['rem_uf', 'UF'],
  ['decl_descricao', 'Descrição do conteúdo'], ['decl_peso_unit_kg', 'Peso de cada placa (kg)']];

async function loadDecl() {
  DERR = '';
  try {
    var r = await Promise.all([api('/admin/declaracao/pedidos'), api('/admin/declaracao/config')]);
    DECL = r[0]; DCFG = r[1];
  } catch (e) { DECL = null; DCFG = null; DERR = e.message; }
  if (cur === 'decl') draw();
}

/* Botões ao lado do número do pedido (a lista de pedidos chama esta função). */
function docBtns(o) {
  if (['pago', 'em_producao', 'enviado', 'entregue'].indexOf(o.status) < 0) return '';
  return '<button class="btn s" onclick="baixarDecl(' + o.id + ')" title="Baixar a declaração de conteúdo em PDF">🧾 Declaração</button> '
    + '<button class="btn s" onclick="abrirNfe(' + o.id + ')" title="Ficha de dados e registro da NF-e">📄 NF-e</button>';
}

function baixarDecl(id) {
  baixarArq('/admin/declaracao/pedido/' + id + '.pdf?refazer=1', 'declaracao-pedido-' + pad5(id) + '.pdf');
}

async function abrirNfe(id) {
  try {
    var n = await api('/admin/declaracao/nfe/' + id);
    mo('<h3 style="margin:0">NF-e · pedido #' + pad5(id) + '</h3>'
      + '<p class="mut" style="margin:0">' + E(n.destinatario) + ' · ' + E(n.cidade) + ' · ' + n.qtd + ' placa(s) · produtos ' + R(n.valor_produtos) + (n.frete ? ' + frete ' + R(n.frete) : '') + '</p>'
      + (n.remetente_ok ? '' : '<div class="card" style="margin:0;border-color:#f59e0b"><small>Preencha os dados da sua empresa na aba <b>Declaração e NF-e</b> para a ficha sair completa.</small></div>')
      + '<button class="btn p" onclick="abrirFicha(' + id + ')">📄 Abrir ficha de dados para emitir a NF-e</button>'
      + '<small class="mut">Emita a nota no seu emissor e registre abaixo. O número e a chave entram sozinhos na declaração de conteúdo.</small>'
      + '<label>Número da NF-e<input id="nf_n" inputmode="numeric" value="' + E(n.nfe.numero) + '"></label>'
      + '<label>Série<input id="nf_s" inputmode="numeric" value="' + E(n.nfe.serie) + '"></label>'
      + '<label>Chave de acesso (44 números)<input id="nf_c" inputmode="numeric" value="' + E(n.nfe.chave) + '"></label>'
      + '<label>Protocolo de autorização (opcional)<input id="nf_p" inputmode="numeric" value="' + E(n.nfe.protocolo) + '"></label>'
      + '<div class="row"><button class="btn p" onclick="salvarNfe(' + id + ')">Salvar registro</button><button class="btn" onclick="cl()">Fechar</button></div>');
  } catch (e) { alert(e.message); }
}

async function salvarNfe(id) {
  try {
    await api('/admin/declaracao/nfe/' + id, { method: 'PUT', body: JSON.stringify({
      numero: document.getElementById('nf_n').value, serie: document.getElementById('nf_s').value,
      chave: document.getElementById('nf_c').value, protocolo: document.getElementById('nf_p').value }) });
    cl(); await loadDecl(); toast('Registro da NF-e salvo ✓');
  } catch (e) { alert(e.message); }
}

async function abrirFicha(id) {
  var w = window.open('', '_blank'); // abre já, para o navegador não bloquear
  try {
    var r = await fetch(API_BASE + '/admin/declaracao/nfe/' + id + '/ficha', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!r.ok) throw new Error('Não foi possível abrir a ficha agora.');
    var u = URL.createObjectURL(new Blob([await r.blob()], { type: 'text/html' }));
    if (w) w.location = u; else location.href = u;
  } catch (e) { if (w) w.close(); alert(e.message); }
}

async function salvarDecl() {
  var b = {};
  DCAMPOS.concat([['decl_modo']]).forEach(function (x) { b[x[0]] = document.getElementById('dc_' + x[0]).value; });
  try { await api('/admin/declaracao/config', { method: 'PUT', body: JSON.stringify(b) }); await loadDecl(); toast('Dados salvos ✓'); }
  catch (e) { alert(e.message); }
}

function vDecl() {
  head('Declaração de conteúdo e NF-e', 'Documentos de cada pedido pago, prontos para o envio.');
  if (DERR) return '<div class="card" style="border-color:#dc2626"><b>Não consegui carregar esta aba.</b><br><span class="mut">' + E(DERR) + '</span><div class="row"><button class="btn p" onclick="loadDecl()">Tentar de novo</button></div></div>';
  if (!DECL) return '<div class="card"><span class="mut">Carregando…</span></div>';
  var gerou = DECL.filter(function (p) { return p.tem_pdf; }).length;
  var comNf = DECL.filter(function (p) { return p.tem_nfe; }).length;
  var semRem = DCFG && !DCFG.rem_nome;
  var kpis = '<div class="k"><div><small>Pedidos pagos</small><b>' + DECL.length + '</b></div><div><small>Declarações geradas</small><b>' + gerou + '</b></div>'
    + '<div><small>NF-e registradas</small><b>' + comNf + '</b></div><div><small>Sem NF-e registrada</small><b style="color:' + (DECL.length - comNf ? '#b45309' : 'inherit') + '">' + (DECL.length - comNf) + '</b></div></div>';
  var aviso = semRem ? '<div class="card" style="border-color:#f59e0b"><b>Preencha os dados da sua empresa (remetente).</b><br><span class="mut">Sem eles, a declaração e a ficha da NF-e saem em branco no remetente.</span></div>' : '';
  var campos = DCAMPOS.map(function (x) { return '<label>' + x[1] + '<input id="dc_' + x[0] + '" value="' + E(DCFG[x[0]]) + '"></label>'; }).join('')
    + '<label>Texto da declaração<select id="dc_decl_modo"><option value="com_nfe"' + (DCFG.decl_modo === 'com_nfe' ? ' selected' : '') + '>Mercadoria acompanha NF-e</option><option value="nao_contribuinte"' + (DCFG.decl_modo === 'nao_contribuinte' ? ' selected' : '') + '>Não contribuinte (modelo dos Correios)</option></select></label>';
  var cfg = '<div class="card"><details' + (semRem ? ' open' : '') + '><summary style="cursor:pointer;font-weight:700">⚙ Dados do remetente (sua empresa)</summary>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:12px">' + campos + '</div>'
    + '<div class="row"><button class="btn p" onclick="salvarDecl()">Salvar dados</button></div></details></div>';
  var linhas = DECL.length ? DECL.map(function (p) {
    return '<tr><td><b>' + E(p.numero) + '</b></td><td>' + E(p.revendedor) + '</td><td>' + p.qtd + '</td><td>' + E([p.ship_city, p.ship_state].filter(Boolean).join('/') || '—') + '</td>'
      + '<td>' + (p.tem_nfe ? '<span class="st entregue">NF-e ' + E(p.nfe_numero || 'registrada') + '</span>' : '<span class="st pendente">sem NF-e</span>') + '</td>'
      + '<td style="white-space:nowrap"><button class="btn s p" onclick="baixarDecl(' + p.id + ')">🧾 Declaração (PDF)</button> <button class="btn s" onclick="abrirNfe(' + p.id + ')">📄 NF-e</button></td></tr>';
  }).join('') : '<tr><td colspan="6" class="mut">Nenhum pedido pago ainda.</td></tr>';
  return aviso + kpis + cfg + '<div class="card"><div class="tw"><table><tr><th>Pedido</th><th>Revendedor</th><th>Placas</th><th>Destino</th><th>NF-e</th><th>Documentos</th></tr>' + linhas + '</table></div>'
    + '<small class="mut">A declaração é gerada sozinha quando o pedido fica pago. A NF-e é emitida no seu emissor; aqui você pega a ficha de dados e registra o número e a chave.</small></div>';
}
