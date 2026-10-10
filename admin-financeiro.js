/* Financeiro → Lucro estimado: versão compacta e responsiva (PC e celular). ARQUIVO NOVO.
   Redefine a função finLucro() do admin.html. Se este arquivo não carregar, o painel antigo continua funcionando.
   Cores das fatias: 6 primeiras posições da paleta categórica, validadas (claro e escuro) com o validador do skill dataviz. */
var FX_CSS = '<style>'
  + '.fx{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300}'
  + '@media(prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .fx{--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300}}'
  + ':root[data-theme="dark"] .fx{--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300}'
  + '.fx .card{padding:14px;margin-top:10px}.fx h3{margin:0;font-size:15px}'
  + '.fx-top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}'
  + '.fx-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:10px}'
  + '.fx-kpi{background:var(--card);border:1px solid var(--br);border-radius:14px;padding:12px 14px;min-width:0}'
  + '.fx-kpi small{display:block;color:var(--mut)}.fx-kpi b{display:block;font-size:clamp(18px,2.3vw,26px);font-weight:800;line-height:1.15;margin-top:2px;white-space:nowrap}'
  + '.fx-kpi .sb{font-size:12px;color:var(--mut);margin-top:3px;line-height:1.3}'
  + '.fx-kpi.main{border-width:2px}'
  + '.fx-bar{display:flex;gap:2px;height:30px;margin-top:10px}.fx-seg{height:100%;min-width:3px;cursor:default}'
  + '.fx-seg:first-child{border-radius:6px 0 0 6px}.fx-seg:last-child{border-radius:0 6px 6px 0}.fx-seg:only-child{border-radius:6px}'
  + '.fx-leg{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:0 22px;margin-top:8px}'
  + '.fx-li{display:flex;gap:9px;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--br)}'
  + '.fx-dot{width:10px;height:10px;border-radius:2px;margin-top:5px;flex:none}'
  + '.fx-li .t{flex:1;min-width:0}.fx-li .t small,.fx-dr small{display:block;color:var(--mut);font-size:12px;line-height:1.3}'
  + '.fx-li .v{text-align:right;white-space:nowrap}.fx-li .v small{display:block;color:var(--mut);font-size:12px}'
  + '.fx-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px;align-items:start}.fx-2 .card{margin-top:0}'
  + '.fx-col{display:flex;flex-direction:column;gap:10px;min-width:0}'
  + '.fx-dr{padding:7px 0;border-bottom:1px solid var(--br)}.fx-dr .l{display:flex;justify-content:space-between;gap:10px}'
  + '.fx-mb{height:4px;border-radius:2px;background:var(--soft);margin-top:5px}.fx-mb i{display:block;height:100%;border-radius:2px;background:var(--s5)}'
  + '.fx-mini{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px}'
  + '.fx-mini div{background:var(--soft);border-radius:10px;padding:9px 11px;min-width:0}.fx-mini small{display:block;color:var(--mut);font-size:12px;line-height:1.3}'
  + '.fx-mini b{display:block;font-size:17px;margin:1px 0}'
  + '.fx-al{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:8px;margin-top:10px}'
  + '.fx-a{border-left:4px solid;padding:5px 10px;font-size:13px;line-height:1.35}.fx-a b{display:block;font-size:13px}.fx-a span{color:var(--mut)}'
  + '.fx details>summary{cursor:pointer;font-weight:700;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:8px}'
  + '.fx details>summary::-webkit-details-marker{display:none}.fx details>summary::after{content:"▾";color:var(--mut)}.fx details[open]>summary::after{content:"▴"}'
  + '.fx table{font-size:13px}.fx th,.fx td{padding:7px 8px}'
  + '.fx-b{display:inline-block;min-width:20px;text-align:center;border-radius:99px;padding:1px 7px;font-size:12px;color:#fff;margin-left:6px}'
  + '@media(max-width:900px){.fx-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.fx-2{grid-template-columns:minmax(0,1fr)}.fx-col{display:contents}'
  + '.fx-o1{order:1}.fx-o2{order:2}.fx-o3{order:3}.fx-o4{order:4}.fx-o5{order:5}.fx-o6{order:6}}'
  + '</style>';

function fxTip(e, el) {
  var t = document.getElementById('fxtip');
  if (!t) {
    t = document.createElement('div'); t.id = 'fxtip';
    t.style.cssText = 'position:fixed;z-index:30;pointer-events:none;background:#111827;color:#fff;padding:6px 10px;border-radius:8px;font-size:12px;line-height:1.35;max-width:240px;display:none';
    document.body.appendChild(t);
  }
  var p = (e.touches && e.touches[0]) || e;
  t.textContent = el.getAttribute('data-tip'); t.style.display = 'block';
  var w = t.offsetWidth;
  t.style.left = Math.min(Math.max(8, p.clientX - w / 2), innerWidth - w - 8) + 'px';
  t.style.top = Math.max(8, p.clientY - t.offsetHeight - 14) + 'px';
}
function fxTipHide() { var t = document.getElementById('fxtip'); if (t) t.style.display = 'none'; }
function fxPc(v) { return (Math.round(v * 10) / 10).toFixed(1).replace('.', ',') + '%'; }

function finLucro() {
  if (LUCERR) return pillsLuc() + '<div class="card" style="margin-top:12px">Não consegui calcular agora: ' + E(LUCERR) + '</div>';
  if (!LUC) return pillsLuc() + '<div class="card mut" style="margin-top:12px">Calculando…</div>';
  var L = LUC, c = L.config, rb = L.receita_bruta;
  var pcr = function (v) { return rb ? fxPc(v / rb * 100) : '—'; };

  /* ---- indicadores principais ---- */
  var kpis = '<div class="fx-kpis">'
    + '<div class="fx-kpi"><small>Receita bruta</small><b>' + R(rb) + '</b><div class="sb">placas ' + R(L.receita_placas) + ' + frete ' + R(L.frete_cobrado) + '</div></div>'
    + '<div class="fx-kpi"><small>Lucro bruto</small><b style="color:' + sinal(L.lucro_bruto) + '">' + R(L.lucro_bruto) + '</b><div class="sb">depois de placas, ICMS, taxas e envio</div></div>'
    + '<div class="fx-kpi"><small>Despesas operacionais</small><b>' + R(L.despesas) + '</b><div class="sb">' + L.despesas_itens.length + ' lançamento(s) no período</div></div>'
    + '<div class="fx-kpi main" style="border-color:' + sinal(L.lucro_final) + '"><small>Lucro estimado final</small><b style="color:' + sinal(L.lucro_final) + '">' + R(L.lucro_final) + '</b><div class="sb">margem ' + fxPc(L.margem_pct) + ' · ' + R(L.lucro_por_placa) + '/placa · ' + R(L.lucro_por_pedido) + '/pedido · ' + L.pedidos + ' pedido(s), ' + L.placas + ' placas</div></div>'
    + '</div>';

  /* ---- para onde vai cada real da receita (barra empilhada + legenda que também é a tabela) ---- */
  var itens = [
    { n: 'Custo das placas', v: L.custo_placas, c: 'var(--s1)', sub: L.placas + ' × ' + R(c.custo_placa) + (c.custo_usa_medio ? ' (custo médio das compras)' : '') },
    { n: 'ICMS', v: L.icms, c: 'var(--s2)', sub: String(c.icms_pct).replace('.', ',') + '% sobre ' + (c.icms_base_frete ? 'placas + frete' : 'só as placas') },
    { n: 'Taxas do Mercado Pago', v: L.taxas_mp, c: 'var(--s3)', sub: L.taxas_reais + ' real(is) · ' + L.taxas_estimadas + ' estimada(s)' },
    { n: 'Envio (Correios)', v: L.custo_envio, c: 'var(--s4)', sub: L.envio_real + ' com custo real · ' + L.envio_estimado + ' estimado(s) a ' + R(c.custo_envio_padrao) },
    { n: 'Despesas operacionais', v: L.despesas, c: 'var(--s5)', sub: L.despesas_itens.length + ' lançamento(s) no período' },
    { n: 'Lucro estimado final', v: L.lucro_final, c: 'var(--s6)', sub: 'margem ' + fxPc(L.margem_pct), lucro: 1 }
  ];
  var den = itens.reduce(function (s, i) { return s + Math.max(0, i.v); }, 0);
  var bar = '', leg = '';
  if (rb > 0 && den > 0) {
    bar = '<div class="fx-bar" role="img" aria-label="Divisão da receita bruta entre custos, despesas e lucro">'
      + itens.filter(function (i) { return i.v > 0; }).map(function (i) {
        return '<div class="fx-seg" style="flex:' + (i.v / den * 100).toFixed(3) + ' 1 0;background:' + i.c + '" data-tip="' + E(i.n + ': ' + R(i.v) + ' (' + pcr(i.v) + ' da receita)') + '" onmousemove="fxTip(event,this)" onmouseleave="fxTipHide()" ontouchstart="fxTip(event,this)" ontouchend="setTimeout(fxTipHide,1500)"></div>';
      }).join('') + '</div>';
  } else bar = '<p class="mut" style="margin:10px 0 0">Ainda não há pedidos pagos neste período.</p>';
  leg = '<div class="fx-leg">' + itens.map(function (i) {
    var neg = i.lucro && i.v < 0;
    return '<div class="fx-li"><span class="fx-dot" style="background:' + i.c + '"></span><div class="t">' + i.n + '<small>' + i.sub + '</small></div>'
      + '<div class="v"><b' + (i.lucro ? ' style="color:' + sinal(i.v) + '"' : '') + '>' + (i.lucro ? '' : '− ') + R(i.v) + '</b><small>' + pcr(i.v) + '</small></div></div>';
  }).join('') + '</div>';
  var aviso = (L.lucro_final < 0 && rb > 0) ? '<div style="margin-top:8px;color:#dc2626;font-size:13px"><b>Resultado negativo:</b> custos e despesas passam da receita em ' + R(-L.lucro_final) + '.</div>' : '';
  var notas = (L.taxas_estimadas ? L.taxas_estimadas + ' pedido(s) com taxa estimada. ' : '') + (L.envio_estimado ? L.envio_estimado + ' pedido(s) sem o custo real do envio informado.' : '');
  var rodape = (notas || L.taxas_estimadas) ? '<div class="fx-top" style="margin-top:8px"><small class="mut">' + notas + '</small>' + (L.taxas_estimadas ? '<button class="btn s" onclick="buscarTaxas()">🔄 Buscar taxas reais no Mercado Pago</button>' : '') + '</div>' : '';
  var flow = '<div class="card"><h3>Para onde vai cada R$ da receita</h3>' + bar + aviso + leg + rodape + '</div>';

  /* ---- despesas do período + situação do negócio, lado a lado no PC e empilhados no celular ---- */
  var ds = L.despesas_itens.slice().sort(function (a, b) { return b.valor_periodo - a.valor_periodo; });
  var dtot = L.despesas || 1, topo = ds.slice(0, 6), resto = ds.slice(6);
  var dlist = topo.length ? topo.map(function (d) {
    return '<div class="fx-dr"><div class="l"><span>' + E(d.descricao) + '<small>' + E(d.categoria || 'Sem categoria') + ' · ' + (d.mensal ? 'mensal: ' + d.dias_rateio + ' dia(s) de ' + R(d.valor) + '/mês' : 'única') + '</small></span><b style="white-space:nowrap">' + R(d.valor_periodo) + '</b></div><div class="fx-mb"><i style="width:' + Math.max(2, d.valor_periodo / dtot * 100).toFixed(1) + '%"></i></div></div>';
  }).join('') + (resto.length ? '<div class="fx-dr"><div class="l"><span>Outras ' + resto.length + ' despesas<small>veja todas em "Despesas"</small></span><b style="white-space:nowrap">' + R(resto.reduce(function (t, d) { return t + d.valor_periodo; }, 0)) + '</b></div></div>' : '')
    : '<p class="mut" style="margin:8px 0 0">Nenhuma despesa no período.</p>';
  var desp = '<div class="card"><div class="fx-top"><h3>Despesas do período · ' + R(L.despesas) + '</h3><button class="btn s" onclick="finTab(\'desp\')">+ Lançar / ver todas</button></div>' + dlist + '</div>';
  var e = L.estoque, ar = L.a_receber;
  var mini = function (t, v, s, cor) { return '<div><small>' + t + '</small><b' + (cor ? ' style="color:' + cor + '"' : '') + '>' + v + '</b><small>' + s + '</small></div>'; };
  var sit = '<div class="card"><h3>Situação do negócio</h3><div class="fx-mini">'
    + mini('A receber', R(ar.valor), ar.pedidos + ' pedido(s) aguardando · sobrariam ~' + R(ar.lucro_estimado))
    + mini('Estoque disponível', e.disponivel, 'capital parado ' + R(e.valor_parado) + (e.dias_cobertura !== null ? ' · ~' + e.dias_cobertura + ' dias de vendas' : ''), e.disponivel < 0 ? '#dc2626' : '')
    + mini('Ponto de equilíbrio', L.ponto_equilibrio_placas ? L.ponto_equilibrio_placas + ' placas' : '—', 'para cobrir as despesas do período')
    + mini('Envio médio real', L.envio_medio_real === null ? 'não informado' : R(L.envio_medio_real), 'você cobra ' + R(c.frete_fixo) + ' de frete')
    + '</div></div>';

  /* ---- alertas do contador (recolhível; abre sozinho se houver algo crítico ou de atenção) ---- */
  var cor = { critico: '#dc2626', atencao: '#f59e0b', info: '#3b82f6', ok: '#16a34a' }, ic = { critico: '🔴', atencao: '🟠', info: '🔵', ok: '🟢' };
  var nC = L.alertas.filter(function (a) { return a.nivel === 'critico'; }).length, nA = L.alertas.filter(function (a) { return a.nivel === 'atencao'; }).length;
  var al = '<div class="card" style="margin-top:10px"><details' + (((nC || nA) && innerWidth > 900) ? ' open' : '') + '><summary><span>🧮 Alertas do contador'
    + (nC ? '<span class="fx-b" style="background:#dc2626">' + nC + '</span>' : '') + (nA ? '<span class="fx-b" style="background:#f59e0b">' + nA + '</span>' : '') + '</span></summary>'
    + '<div class="fx-al">' + L.alertas.map(function (a) { return '<div class="fx-a" style="border-color:' + cor[a.nivel] + '"><b>' + ic[a.nivel] + ' ' + E(a.titulo) + '</b><span>' + E(a.texto) + '</span></div>'; }).join('') + '</div></details></div>';

  /* ---- faixas de preço, pedidos no prejuízo e IA: recolhidos para não alongar a tela ---- */
  var fx = '<div class="card"><details><summary>Quanto sobra em cada faixa de preço</summary><p class="mut" style="margin:8px 0">Para um pedido do tamanho mínimo de cada faixa, já com custo da placa, ICMS, taxas, frete cobrado e envio.</p><div class="tw"><table><tr><th>Faixa</th><th>Preço/placa</th><th>Lucro do pedido</th><th>Por placa</th><th>Margem</th></tr>'
    + L.faixas.map(function (f) { return '<tr><td>' + f.de + (f.ate === null ? '+' : ' a ' + f.ate) + ' placas</td><td>' + R(f.preco) + '</td><td style="color:' + sinal(f.lucro_pedido) + ';font-weight:700">' + R(f.lucro_pedido) + ' <small class="mut">(' + f.qtd_exemplo + ')</small></td><td>' + R(f.lucro_por_placa) + '</td><td style="color:' + (f.margem_pct < 10 ? '#dc2626' : 'inherit') + '">' + String(f.margem_pct).replace('.', ',') + '%</td></tr>'; }).join('') + '</table></div></details></div>';
  var pj = L.pedidos_prejuizo.length ? '<div class="card" style="border-color:#dc2626"><details open><summary>Pedidos no prejuízo (' + L.pedidos_prejuizo.length + ')</summary>' + L.pedidos_prejuizo.map(function (p) { return '<div class="bar"><span>#' + pad5(p.id) + ' · ' + p.qty + ' placas · total ' + R(p.total) + '<br><small class="mut">frete cobrado ' + R(p.frete_cobrado) + ' · envio ' + R(p.custo_envio) + (p.envio_real ? ' (real)' : ' (estimado)') + '</small></span><b style="color:#dc2626">' + R(p.lucro) + '</b></div>'; }).join('') + '</details></div>' : '';
  var ia = '<div class="card"><details' + ((IATXT || IALOAD || IAERR) ? ' open' : '') + '><summary>🤖 Analista financeiro com IA</summary><div class="fx-top" style="margin-top:8px"><small class="mut">Lê os números do período e recomenda ações. Só números agregados são enviados, nunca dados de clientes.</small><button class="btn p" onclick="pedirIA()" ' + (IALOAD ? 'disabled' : '') + '>' + (IALOAD ? 'Analisando…' : IATXT ? 'Analisar de novo' : 'Pedir análise da IA') + '</button></div>'
    + (IAERR ? '<p style="color:#dc2626;margin:10px 0 0">' + E(IAERR) + '</p>' : '') + (IATXT ? '<div style="margin-top:10px;white-space:pre-wrap;line-height:1.55">' + E(IATXT) + '</div>' : '') + '</details></div>';

  var W = function (n, h) { return h ? '<div class="fx-o fx-o' + n + '">' + h + '</div>' : ''; };
  var duo = '<div class="fx-2"><div class="fx-col">' + W(2, desp) + W(3, pj) + '</div><div class="fx-col">' + W(1, sit) + W(4, fx) + W(5, ia) + '</div></div>';
  return '<div class="fx">' + FX_CSS + pillsLuc() + '<div class="mut" style="margin:8px 2px 0">' + E(L.periodo) + '</div>' + kpis + flow + al + duo
    + '<p class="mut" style="margin:10px 4px;font-size:12px">Estimativa para gestão do negócio, calculada com os custos de “Custos e taxas”. ICMS e demais tributos devem ser confirmados com seu contador.</p></div>';
}
