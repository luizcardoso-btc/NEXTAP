/* Catálogo de produtos na LP e no checkout do revendedor — ARQUIVO NOVO.
   Vitrine: foto à esquerda, lista por categoria à direita; ao clicar num produto a foto troca.
   No celular a foto abre logo abaixo do item clicado. As imagens vêm de /admin/catalogo. */
(function () {
  var CAT = null, TIERS = [], SEL = null;
  var CSS = '.cx{margin-top:6px}.cx .gd{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:22px;align-items:start}'
    + '.cx .cxi{position:sticky;top:90px}.cx .ph{aspect-ratio:1/1;border-radius:16px;border:1px solid var(--br);background:var(--soft);display:grid;place-items:center;overflow:hidden}'
    + '.cx .ph img{width:100%;height:100%;object-fit:contain;display:block}.cx .ph .vz{text-align:center;color:var(--mut);font-size:13px;padding:16px}'
    + '.cx .ph .vz i{display:block;width:64px;height:64px;border-radius:18px;margin:0 auto 10px;border:1px solid var(--br)}'
    + '.cx .dt{margin-top:12px}.cx .dt b{font-size:18px;display:block;line-height:1.25}.cx .dt .ds{color:var(--mut);font-size:13px;margin:3px 0 8px}'
    + '.cx .tb{display:grid;gap:4px;font-size:13px;margin:6px 0}.cx .tb div{display:flex;justify-content:space-between;border:1px solid var(--br);border-radius:9px;padding:6px 10px;background:var(--card)}'
    + '.cx h3{margin:16px 0 6px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--pr2,var(--pr))}.cx h3:first-child{margin-top:0}'
    + '.cx .li{display:grid;grid-template-columns:34px 1fr auto;gap:12px;align-items:center;padding:11px 10px;border:1px solid transparent;border-bottom-color:var(--br);border-radius:12px;cursor:pointer}'
    + '.cx .li:hover{background:var(--soft)}.cx .li.on{border-color:var(--pr);background:var(--soft)}'
    + '.cx .sw{width:30px;height:30px;border-radius:9px;border:1px solid var(--br)}'
    + '.cx .nm{font-weight:700;font-size:15px;line-height:1.25}.cx .ds2{font-size:12px;color:var(--mut);margin-top:2px}'
    + '.cx .pr{text-align:right;font-weight:800;white-space:nowrap;font-size:14px}.cx .pr small{display:block;font-weight:600;font-size:11px;color:var(--mut)}'
    + '.cx .soon{font-weight:700;font-size:12px;padding:4px 10px;border-radius:99px;background:var(--soft);color:var(--mut);display:inline-block}.cx .li.on .soon{background:var(--card)}'
    + '.cx .tg{display:inline-block;font-weight:700;font-size:12px;padding:4px 10px;border-radius:99px;background:var(--pr);color:#fff}'
    + '.cx .inl{display:none;grid-column:1/-1}'
    + '@keyframes nxfl{0%{box-shadow:0 0 0 0 #0f9d4e99}100%{box-shadow:0 0 0 14px #0f9d4e00}}.nxfl{animation:nxfl 1s ease-out 2;border-color:var(--pr)!important}'
    + '@media(max-width:760px){.cx .gd{grid-template-columns:1fr}.cx .cxi{display:none}.cx .li.on .inl{display:block}.cx .inl .ph{max-width:340px;margin:8px auto 0}}';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function brl(n) { return 'R$ ' + Number(n).toFixed(2).replace('.', ','); }
  function minTier() { return TIERS.length ? Math.min.apply(null, TIERS.map(function (t) { return t.unit_price; })) : null; }
  function achar(id) { for (var i = 0; i < CAT.length; i++) if (CAT[i].id === id) return CAT[i]; return CAT[0]; }

  function foto(p) {
    return p.imagem ? '<img src="' + esc(p.imagem) + '" alt="' + esc(p.nome) + '" loading="lazy">'
      : '<div class="vz"><i style="background:' + esc(p.cor) + '"></i>' + esc(p.nome) + '</div>';
  }
  function preco(p) { // texto curto da lista
    if (p.usa_tabela) { var m = minTier(); return m != null ? 'a partir de ' + brl(m) : 'Preço em breve'; }
    return p.preco != null ? brl(p.preco) : 'Preço em breve';
  }
  function detalhe(p, onde) {
    var h = '<div class="ph">' + foto(p) + '</div><div class="dt"><b>' + esc(p.nome) + '</b><div class="ds">' + esc(p.descricao) + '</div>';
    if (p.usa_tabela && TIERS.length) {
      h += '<div class="tb">' + TIERS.map(function (t) {
        var l = t.max_qty >= 1000000 ? t.min_qty + '+ placas' : t.min_qty + ' a ' + t.max_qty + ' placas';
        return '<div><span>' + l + '</span><b style="font-size:13px;display:inline">' + brl(t.unit_price) + '</b></div>';
      }).join('') + '</div><div class="ds">Valor por placa, conforme a quantidade do pedido.</div>';
    } else if (p.preco != null) h += '<div class="pr" style="text-align:left">' + brl(p.preco) + '</div>';
    else h += '<span class="soon">Preço em breve</span>';
    h += '<div style="margin-top:10px"><button class="tg" style="border:0;cursor:pointer;font:inherit;font-weight:700;padding:9px 16px" onclick="event.stopPropagation();nxPick(' + p.id + ')">'
      + (p.categoria.indexOf('Display') === 0 ? 'Escolher este display' : 'Escolher esta placa') + ' →</button></div>';
    if (!p.pedido_ativo) h += '<div class="ds" style="margin-top:8px">Esse item é pedido pelo WhatsApp por enquanto; o pagamento online abre em breve.</div>';
    return h + '</div>';
  }

  function tabela(onde) {
    if (!CAT || !CAT.length) return '';
    if (SEL == null) SEL = CAT[0].id;
    var cats = [], por = {};
    CAT.forEach(function (p) { if (!por[p.categoria]) { por[p.categoria] = []; cats.push(p.categoria); } por[p.categoria].push(p); });
    var lista = cats.map(function (c) {
      return '<h3>' + esc(c) + '</h3>' + por[c].map(function (p) {
        return '<div class="li' + (p.id === SEL ? ' on' : '') + '" data-id="' + p.id + '" onclick="nxCat(' + p.id + ',this)"><i class="sw" style="background:' + esc(p.cor) + '"></i>'
          + '<div><div class="nm">' + esc(p.nome) + '</div><div class="ds2">' + esc(p.descricao) + '</div></div>'
          + '<div class="pr">' + (p.usa_tabela || p.preco != null ? esc(preco(p)) : '<span class="soon">Preço em breve</span>') + '</div>'
          + '<div class="inl">' + detalhe(p, onde) + '</div></div>';
      }).join('');
    }).join('');
    return '<style>' + CSS + '</style><div class="cx" data-onde="' + onde + '"><div class="gd"><div class="cxi">' + detalhe(achar(SEL), onde) + '</div><div class="cxl">' + lista + '</div></div></div>';
  }

  // Troca o produto selecionado sem redesenhar a página.
  window.nxCat = function (id) {
    SEL = id; var p = achar(id);
    document.querySelectorAll('.cx').forEach(function (cx) {
      cx.querySelectorAll('.li').forEach(function (li) { li.classList.toggle('on', Number(li.dataset.id) === id); });
      var i = cx.querySelector('.cxi'); if (i) i.innerHTML = detalhe(p, cx.dataset.onde);
    });
  };

  function montaSite() {
    var alvo = document.getElementById('precos');
    if (!alvo || document.getElementById('catalogo') || !CAT || !CAT.length) return;
    var s = document.createElement('section');
    s.id = 'catalogo';
    s.innerHTML = '<div class="w"><div class="c"><span class="tag">NOSSOS PRODUTOS</span><h2>Placas e displays NFC + QR Code para cada tipo de negócio.</h2>'
      + '<p class="mut">Google, Pix, Instagram, WhatsApp e redes sociais. Clique em um produto para ver a foto.</p></div>'
      + '<div class="card" style="max-width:980px;margin:18px auto 0;padding:18px">' + tabela('site') + '</div></div>';
    alvo.parentNode.insertBefore(s, alvo);
  }


  /* ---------- Escolher produto → simulador de pedido ---------- */
  var EX = [], PREV = null, QPAD = 25; // EX = itens escolhidos no catálogo (além das placas azul/preta)
  function exF(id) { for (var i = 0; i < EX.length; i++) if (EX[i].id === id) return EX[i]; return null; }
  function pricedQty() { return EX.reduce(function (a, e) { return a + (e.usa_tabela ? e.qty : 0); }, 0); }
  var temFrete = function () { return !!(window.FQ && FQ.sel); };
  var fv = function (t) { return temFrete() ? R(t.frete) : 'calculado pelo CEP'; };
  function totais() {
    var n = N.azul + N.preta + pricedQty(), u = n ? price(n) : 0, min = typeof minQ === 'function' ? minQ() : MINQ;
    return { n: n, u: u, placas: n * u, frete: n ? FRETE : 0, total: n ? n * u + FRETE : 0, min: min };
  }
  function linhasHtml() {
    return EX.map(function (e) {
      return '<div class="qty nxex"><span><i style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + esc(e.cor) + ';border:1px solid var(--br);margin-right:8px;flex:none"></i>'
        + '<em style="font-style:normal">' + esc(e.nome) + (e.usa_tabela ? '' : '<small class="mut" style="display:block;font-size:11px">preço em breve</small>') + '</em></span>'
        + '<span><button onclick="nxQ(' + e.id + ',-1)">−</button><b style="display:inline-block;min-width:34px;text-align:center">' + e.qty + '</b><button onclick="nxQ(' + e.id + ',1)">+</button>'
        + '<button onclick="nxX(' + e.id + ')" title="Remover" style="font-size:15px">×</button></span></div>';
    }).join('');
  }
  function zapTexto() {
    var t = totais(), L = ['Olá! Quero fazer este pedido:'];
    if (N.azul) L.push('• ' + N.azul + 'x Placa azul'); if (N.preta) L.push('• ' + N.preta + 'x Placa preta');
    EX.forEach(function (e) { L.push('• ' + e.qty + 'x ' + e.nome + (e.usa_tabela ? '' : ' (preço a combinar)')); });
    if (t.n) L.push('Placas: ' + t.n + ' × ' + R(t.u) + ' = ' + R(t.placas) + ' + frete ' + fv(t) + (temFrete() ? ' = ' + R(t.total) : ' (total sem frete: ' + R(t.total) + ')'));
    return L.join('\n');
  }
  function zapUrl() { return 'https://wa.me/' + (typeof WHATS !== 'undefined' ? WHATS : '') + '?text=' + encodeURIComponent(zapTexto()); }
  function flash(el) { if (!el) return; el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.remove('nxfl'); void el.offsetWidth; el.classList.add('nxfl'); }
  function pagina() { return typeof vComprar === 'function' && typeof ME !== 'undefined' ? 'rev' : 'site'; }
  function refaz() { if (pagina() === 'rev') draw(); else calc(); }
  function achaSim() { return pagina() === 'rev' ? document.getElementById('nxSim') : document.getElementById('nxSim') || (function () { var q = document.getElementById('qa'); var c = q && q.closest('.card'); if (c) c.id = 'nxSim'; return c; })(); }

  window.nxPick = function (id) {
    var p = achar(id);
    if (p.pedido_ativo) { // a placa que já vende hoje: usa as linhas azul/preta do simulador
      if (N.azul + N.preta === 0) N.azul = QPAD;
    } else if (!exF(id)) {
      if (!EX.length) { PREV = { azul: N.azul, preta: N.preta }; N.azul = 0; N.preta = 0; } // escolha nova: começa só com o item clicado
      EX.push({ id: p.id, nome: p.nome, cor: p.cor, usa_tabela: !!p.usa_tabela, qty: QPAD });
    }
    refaz();
    setTimeout(function () { flash(achaSim()); }, 60);
  };
  window.nxQ = function (id, d) { var e = exF(id); if (!e) return; e.qty = Math.max(1, e.qty + d); refaz(); };
  window.nxX = function (id) {
    EX = EX.filter(function (e) { return e.id !== id; });
    if (!EX.length && PREV) { N.azul = PREV.azul; N.preta = PREV.preta; PREV = null; }
    refaz();
  };

  // LP: o simulador é HTML fixo; sobrescreve calc() para somar os itens escolhidos.
  function ganchaSite() {
    if (typeof calc !== 'function' || !document.getElementById('qa')) return;
    var oc = calc;
    calc = function () {
      oc();
      var card = achaSim(), ant = card.querySelector('.nxlinhas');
      if (!ant) { ant = document.createElement('div'); ant.className = 'nxlinhas'; card.querySelector('.sum').parentNode.insertBefore(ant, card.querySelector('.sum')); }
      ant.innerHTML = linhasHtml();
      if (!EX.length) return;
      var t = totais();
      sq.textContent = t.n; su.textContent = R(t.u); st.textContent = R(t.total);
      var sem = EX.some(function (e) { return !e.usa_tabela; });
      sf.textContent = t.n ? 'Placas ' + R(t.placas) + ' + ' + (temFrete() ? freteRot() + ' ' + R(t.frete) : 'frete calculado pelo CEP') + ' (por pedido)' + (sem ? ' · displays: preço em breve' : '') : (sem ? 'Displays: preço em breve' : '');
      var nx = (window.TIERS || []).filter(function (x) { return x[0] > t.n; })[0]; // faixas da LP: [min, max, preço]
      sh.textContent = t.n && t.n < MINQ ? 'Pedido mínimo: ' + MINQ + ' placas — faltam ' + (MINQ - t.n) + '.' : (t.n && nx ? 'Com mais ' + (nx[0] - t.n) + ', cada placa sai por ' + R(nx[2]) + '.' : (t.n ? 'Você já tem o melhor preço!' : ''));
    };
    calc();
  }

  // Painel do revendedor: depois de cada draw() da tela "Comprar", encaixa os itens escolhidos no card "Seu pedido".
  function nxPos() {
    if (typeof cur === 'undefined' || cur !== 'comprar') return;
    var h3 = [].slice.call(document.querySelectorAll('#v h3')).filter(function (x) { return x.textContent === 'Seu pedido'; })[0];
    if (!h3) return;
    var card = h3.parentNode; card.id = 'nxSim';
    if (!EX.length) return;
    var rows = [].slice.call(card.querySelectorAll('.qty'));
    var preta = rows.filter(function (r) { return /^Placa preta/.test(r.textContent.trim()); })[0];
    if (preta) preta.insertAdjacentHTML('afterend', linhasHtml());
    var t = totais();
    function set(l, v) { [].slice.call(card.querySelectorAll('.qty')).forEach(function (r) { if (r.firstElementChild && r.firstElementChild.textContent.trim() === l) r.lastElementChild.textContent = v; }); }
    set('Quantidade', t.n); set('Por placa', R(t.u)); set('Placas', R(t.placas)); set('Frete (envio)', fv(t)); set('Total', R(t.total) + (temFrete() ? '' : ' + frete'));
    var btn = card.querySelector('button.btn.p'), aviso = card.querySelector('p[style*="b45309"]');
    if (aviso) aviso.remove();
    if (btn) {
      var falta = t.n > 0 && t.n < t.min;
      btn.outerHTML = (falta ? '<p style="margin:0 0 8px;color:#b45309;font-weight:600">Faltam ' + (t.min - t.n) + ' placa(s) para o pedido mínimo de ' + t.min + '.</p>' : '')
        + '<a class="btn p" style="width:100%;text-align:center;display:block;text-decoration:none;color:#fff;' + (falta ? 'opacity:.5;pointer-events:none' : '') + '" target="_blank" rel="noopener" href="' + zapUrl() + '">Pedir pelo WhatsApp</a>'
        + '<small class="mut" style="display:block;margin:6px 0">Os novos produtos ainda não têm pagamento online: o pedido é fechado pelo WhatsApp, já com os itens e o total acima.</small>';
    }
  }
  function ganchaDraw() {
    if (typeof draw !== 'function' || typeof vComprar !== 'function') return;
    var od = draw; draw = function () { od(); try { nxPos(); } catch (e) {} };
  }

  function ganchaRevendedor() {
    if (typeof vComprar !== 'function') return;
    var orig = vComprar;
    vComprar = function () {
      return orig() + (CAT && CAT.length ? '<div class="card" style="margin-top:14px"><h3 style="margin:0;font-size:16px;text-transform:none;letter-spacing:0;color:inherit">Catálogo de produtos</h3>'
        + '<small class="mut">Clique em um produto para ver a foto. Os pedidos dos novos itens abrem em breve.</small><div style="height:10px"></div>' + tabela('rev') + '</div>' : '');
    };
  }

  ganchaRevendedor();
  ganchaDraw();
  ganchaSite();
  fetch('/api/public/catalogo', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (!j) return;
    CAT = j.produtos || []; TIERS = j.tiers || [];
    montaSite();
    try { if (typeof cur !== 'undefined' && cur === 'comprar' && typeof draw === 'function' && typeof ME !== 'undefined' && ME) draw(); } catch (e) {}
  }).catch(function () {});
})();
