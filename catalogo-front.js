/* Catálogo de produtos na LP e no checkout do revendedor — ARQUIVO NOVO.
   Mostra os produtos em tabela por categoria. Preço de venda em branco = "Preço em breve". */
(function () {
  var CAT = null;
  var CSS = '.cx{margin-top:6px}.cx h3{margin:22px 0 8px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--pr2,var(--pr))}'
    + '.cx .li{display:grid;grid-template-columns:34px 1fr auto;gap:12px;align-items:center;padding:12px 4px;border-bottom:1px solid var(--br)}'
    + '.cx .sw{width:30px;height:30px;border-radius:9px;border:1px solid var(--br)}'
    + '.cx .nm{font-weight:700;font-size:15px;line-height:1.25}.cx .ds{font-size:12px;color:var(--mut);margin-top:2px}'
    + '.cx .pr{text-align:right;font-weight:800;white-space:nowrap}.cx .pr small{display:block;font-weight:600;font-size:11px;color:var(--mut)}'
    + '.cx .soon{font-weight:700;font-size:12px;padding:4px 10px;border-radius:99px;background:var(--soft);color:var(--mut)}'
    + '.cx .on{font-weight:700;font-size:12px;padding:4px 10px;border-radius:99px;background:var(--pr);color:#fff;text-decoration:none;display:inline-block}';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function brl(n) { return 'R$ ' + Number(n).toFixed(2).replace('.', ','); }

  function tabela(onde) { // onde: 'site' | 'rev'
    if (!CAT || !CAT.length) return '';
    var cats = [], por = {};
    CAT.forEach(function (p) { if (!por[p.categoria]) { por[p.categoria] = []; cats.push(p.categoria); } por[p.categoria].push(p); });
    return '<style>' + CSS + '</style><div class="cx">' + cats.map(function (c) {
      return '<h3>' + esc(c) + '</h3>' + por[c].map(function (p) {
        var dir;
        if (p.pedido_ativo) dir = onde === 'rev' ? '<span class="on">Disponível</span><small class="mut" style="display:block;font-size:11px;margin-top:3px">preços na tabela de cima</small>' : '<a class="on" href="#precos">Ver preços</a>';
        else dir = '<span class="soon">' + (p.preco != null ? brl(p.preco) + ' · pedidos em breve' : 'Preço em breve') + '</span>';
        return '<div class="li"><i class="sw" style="background:' + esc(p.cor) + '"></i><div><div class="nm">' + esc(p.nome) + '</div><div class="ds">' + esc(p.descricao) + '</div></div><div class="pr">' + dir + '</div></div>';
      }).join('');
    }).join('') + '</div>';
  }

  function montaSite() {
    var alvo = document.getElementById('precos');
    if (!alvo || document.getElementById('catalogo') || !CAT || !CAT.length) return;
    var s = document.createElement('section');
    s.id = 'catalogo';
    s.innerHTML = '<div class="w"><div class="c"><span class="tag">NOSSOS PRODUTOS</span><h2>Placas e displays NFC + QR Code para cada tipo de negócio.</h2>'
      + '<p class="mut">Google, Pix, Instagram, WhatsApp e redes sociais. A tabela de preços de cada item é divulgada em breve.</p></div>'
      + '<div class="card" style="max-width:760px;margin:18px auto 0;padding:6px 18px 16px">' + tabela('site') + '</div></div>';
    alvo.parentNode.insertBefore(s, alvo);
  }

  // Checkout do revendedor: acrescenta o catálogo logo abaixo da tela "Comprar placas".
  function ganchaRevendedor() {
    if (typeof vComprar !== 'function') return;
    var orig = vComprar;
    vComprar = function () {
      return orig() + (CAT && CAT.length ? '<div class="card" style="margin-top:14px"><h3 style="margin:0">Catálogo de produtos</h3>'
        + '<small class="mut">Novos produtos chegando. O preço de cada item será divulgado em breve.</small>' + tabela('rev') + '</div>' : '');
    };
  }

  ganchaRevendedor();
  fetch('/api/public/catalogo').then(function (r) { return r.ok ? r.json() : []; }).then(function (j) {
    CAT = j;
    montaSite();
    try { if (typeof cur !== 'undefined' && cur === 'comprar' && typeof draw === 'function' && typeof ME !== 'undefined' && ME) draw(); } catch (e) {}
  }).catch(function () {});
})();
