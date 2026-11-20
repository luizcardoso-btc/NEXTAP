/* Aba "Resultados das placas" — ARQUIVO NOVO, carregado pelo admin.html.
   Leituras por estabelecimento e a evolução das avaliações no Google (prova real de crescimento). */
var RES = null, RESERR = '', RESQ = '';
async function loadRes() {
  RESERR = '';
  try { RES = await api('/admin/resultados'); } catch (e) { RES = null; RESERR = e.message; }
  if (cur === 'res') draw();
}
function resN(n) { return Number(n || 0).toLocaleString('pt-BR'); }
function resData(d) { return d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(2, 4) : '—'; }
function resSpark(v) {
  var w = 120, h = 30, m = Math.max(1, Math.max.apply(null, v));
  var pts = v.map(function (x, i) { return (i * w / (v.length - 1)).toFixed(1) + ',' + (h - 3 - (x / m) * (h - 6)).toFixed(1); }).join(' ');
  return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"><polyline points="' + pts + '" fill="none" stroke="#16a34a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}
function vRes() {
  head('Resultados das placas', 'Leituras de cada placa e o crescimento das avaliações no Google de cada empresa.');
  if (RESERR) return '<div class="card">Não consegui carregar agora: ' + E(RESERR) + '</div>';
  if (!RES) return '<div class="card mut">Carregando…</div>';
  var r = RES.resumo, k = function (t, v, s, cor) { return '<div class="card" style="margin:0"><small class="mut">' + t + '</small><div style="font-size:26px;font-weight:800;' + (cor ? 'color:' + cor : '') + '">' + v + '</div><small class="mut">' + s + '</small></div>'; };
  var kp = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px">'
    + k('Leituras nos últimos 30 dias', resN(r.leituras_30d), resN(r.leituras_7d) + ' nos últimos 7 dias · ' + resN(r.leituras_total) + ' no total')
    + k('Estabelecimentos com placa', resN(r.estabelecimentos), resN(r.placas) + ' placa(s) configurada(s)')
    + k('Avaliações novas no Google', '+' + resN(r.avaliacoes_novas), r.com_comparacao ? 'desde a primeira medição, em ' + r.com_comparacao + ' empresa(s)' : 'aparece depois da 2ª medição', '#16a34a')
    + k('Empresas crescendo', r.com_comparacao ? r.empresas_crescendo + ' de ' + r.com_comparacao : '—', r.google_monitorados + ' com placa de avaliação no Google')
    + '</div>';
  var mx = Math.max(1, Math.max.apply(null, r.serie.map(function (s) { return s.leituras; })));
  var graf = '<div class="card" style="margin-top:12px"><b>Leituras por semana</b> <small class="mut">(todas as placas, últimas 8 semanas)</small><div style="display:flex;gap:6px;align-items:flex-end;height:120px;margin-top:10px">'
    + r.serie.map(function (s) { return '<div style="flex:1;text-align:center"><div title="' + resN(s.leituras) + ' leitura(s)" style="height:' + Math.max(2, s.leituras / mx * 90) + 'px;background:#16a34a;border-radius:6px 6px 0 0"></div><small class="mut" style="font-size:11px">' + resData(s.semana).slice(0, 5) + '</small></div>'; }).join('')
    + '</div><small class="mut">Cada leitura é um cliente que aproximou o celular ou leu o QR Code da placa.</small></div>';
  var api0 = r.api.chave
    ? '<div class="mut" style="font-size:12px">Medição automática no Google ligada: cada empresa é medida 1 vez por semana. Uso do mês: ' + r.api.uso_mes + ' de ' + r.api.limite_mes + ' consultas (dentro da cota grátis). <button class="btn s" onclick="resColetar()">🔄 Medir agora</button></div>'
    : '<div class="mut" style="font-size:12px">Medição automática no Google desligada (falta a chave GOOGLE_PLACES_API_KEY no Railway). Enquanto isso, registre à mão em "⭐ Registrar".</div>';
  var f = RESQ.toLowerCase();
  var linhas = RES.lista.filter(function (x) { return !f || (x.nome + ' ' + x.revendedores + ' ' + x.placas.join(' ')).toLowerCase().indexOf(f) >= 0; }).map(function (x, i) {
    var g = x.google, gcol;
    if (!x.place_id) gcol = '<span class="mut">' + E(x.tipo) + '</span>';
    else if (!g) gcol = '<span class="mut">ainda sem medição</span>';
    else if (g.medicoes < 2) gcol = '<b>' + resN(g.atual.total) + '</b> avaliações' + (g.atual.nota ? ' · ⭐ ' + String(g.atual.nota).replace('.', ',') : '') + '<br><small class="mut">1ª medição em ' + resData(g.inicio.data) + '</small>';
    else gcol = '<b style="color:' + (g.novas > 0 ? '#16a34a' : 'inherit') + '">' + (g.novas >= 0 ? '+' : '') + resN(g.novas) + ' avaliações</b>' + (g.pct !== null ? ' <small>(' + (g.pct >= 0 ? '+' : '') + String(g.pct).replace('.', ',') + '%)</small>' : '')
      + '<br><small class="mut">' + resN(g.inicio.total) + ' → ' + resN(g.atual.total) + ' em ' + g.dias + ' dia(s)' + (g.nota_dif !== null && g.atual.nota ? ' · ⭐ ' + String(g.atual.nota).replace('.', ',') + (g.nota_dif ? ' (' + (g.nota_dif > 0 ? '+' : '') + String(g.nota_dif).replace('.', ',') + ')' : '') : '') + '</small>';
    return '<tr><td><b>' + E(x.nome) + '</b><br><small class="mut">' + E(x.revendedores) + ' · ' + x.placas.length + ' placa(s) · desde ' + resData(x.desde) + '</small></td>'
      + '<td style="text-align:right"><b>' + resN(x.d30) + '</b><br><small class="mut">' + resN(x.total) + ' no total</small></td><td>' + resSpark(x.serie) + '</td><td>' + gcol + '</td>'
      + '<td><div style="display:flex;flex-direction:column;gap:4px;align-items:stretch">' + (x.place_id ? '<button class="btn s" onclick="resManual(' + i + ')">⭐ Registrar</button>' : '') + '<button class="btn s" onclick="resProva(' + i + ')">📄 Prova</button></div></td></tr>';
  });
  var tab = '<div class="card" style="margin-top:12px"><div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap"><b>Por estabelecimento</b><input placeholder="🔎 Buscar empresa, revendedor ou placa" value="' + E(RESQ) + '" oninput="RESQ=this.value;draw();var i=document.querySelector(\'#v input\');if(i){i.focus();i.setSelectionRange(i.value.length,i.value.length)}" style="max-width:300px"></div>' + api0
    + '<div class="tw" style="margin-top:8px"><table style="width:100%"><tr><th>Estabelecimento</th><th style="text-align:right">Leituras (30 dias)</th><th>8 semanas</th><th>Avaliações no Google</th><th></th></tr>'
    + (linhas.length ? linhas.join('') : '<tr><td colspan="5" class="mut">Nenhuma placa configurada ainda.</td></tr>') + '</table></div></div>';
  return kp + graf + tab;
}
async function resColetar() { try { var r = await api('/admin/resultados/coletar', { method: 'POST' }); toast(r.medidos ? r.medidos + ' empresa(s) medidas ✓' : (r.motivo === 'sem_chave' ? 'Falta a chave do Google no Railway' : 'Nada para medir agora (cada empresa é medida 1 vez por semana)')); await loadRes(); } catch (e) { alert(e.message); } }
function resLista() { var f = RESQ.toLowerCase(); return RES.lista.filter(function (x) { return !f || (x.nome + ' ' + x.revendedores + ' ' + x.placas.join(' ')).toLowerCase().indexOf(f) >= 0; }); }
function resManual(i) {
  var x = resLista()[i], h = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  mo('<h3 style="margin:0 0 6px">⭐ Avaliações de ' + E(x.nome) + '</h3><p class="mut" style="margin:0 0 10px">Abra a empresa no Google Maps e copie o número de avaliações e a nota. Para registrar o "antes da placa", use a data da instalação.</p>'
    + '<div class="row"><label style="flex:1">Data<input type="date" id="rmd" value="' + h + '" max="' + h + '"></label><label style="flex:1">Avaliações<input id="rmt" inputmode="numeric" placeholder="Ex.: 87"></label><label style="flex:1">Nota<input id="rmn" inputmode="decimal" placeholder="Ex.: 4,8"></label></div>'
    + '<div class="row" style="margin-top:10px"><button class="btn p" onclick="resManualOk(\'' + x.place_id + '\')">Salvar</button><button class="btn" onclick="cl()">Cancelar</button></div>'
    + '<p style="margin-top:10px"><a href="https://www.google.com/maps/place/?q=place_id:' + encodeURIComponent(x.place_id) + '" target="_blank" rel="noopener">Abrir no Google Maps ↗</a></p>');
}
async function resManualOk(pid) { try { await api('/admin/resultados/manual', { method: 'POST', body: JSON.stringify({ place_id: pid, data: $('rmd').value, total: $('rmt').value, nota: $('rmn').value }) }); cl(); toast('Medição salva ✓'); await loadRes(); } catch (e) { alert(e.message); } }
// Texto pronto da prova (para mandar ao dono da empresa ou ao revendedor)
function resProva(i) {
  var x = resLista()[i], g = x.google, L = ['📊 Resultado da placa NexTap · ' + x.nome, '',
    '📲 ' + resN(x.total) + ' leitura(s) desde ' + resData(x.desde) + ' (' + resN(x.d30) + ' nos últimos 30 dias).'];
  if (g && g.medicoes > 1) {
    L.push('⭐ Avaliações no Google: ' + resN(g.inicio.total) + ' em ' + resData(g.inicio.data) + ' → ' + resN(g.atual.total) + ' em ' + resData(g.atual.data) + ' (' + (g.novas >= 0 ? '+' : '') + resN(g.novas) + (g.pct !== null ? ', ' + (g.pct >= 0 ? '+' : '') + String(g.pct).replace('.', ',') + '%' : '') + ').');
    if (g.atual.nota) L.push('🌟 Nota atual: ' + String(g.atual.nota).replace('.', ',') + (g.nota_dif ? ' (' + (g.nota_dif > 0 ? '+' : '') + String(g.nota_dif).replace('.', ',') + ' no período)' : '') + '.');
    if (g.por_mes) L.push('📈 Ritmo: cerca de ' + String(g.por_mes).replace('.', ',') + ' avaliação(ões) nova(s) por mês.');
  } else if (g) L.push('⭐ Hoje: ' + resN(g.atual.total) + ' avaliações no Google' + (g.atual.nota ? ', nota ' + String(g.atual.nota).replace('.', ',') : '') + '. A comparação aparece na próxima medição.');
  var t = L.join('\n');
  mo('<h3 style="margin:0 0 8px">📄 Prova de resultado</h3><pre style="white-space:pre-wrap;background:var(--soft,#f3f4f6);padding:12px;border-radius:10px;font:inherit">' + E(t) + '</pre>'
    + (g && g.historico && g.historico.length > 1 ? '<div class="tw"><table><tr><th>Data</th><th>Avaliações</th><th>Nota</th><th>Origem</th></tr>' + g.historico.slice().reverse().map(function (s) { return '<tr><td>' + resData(s.data) + '</td><td>' + resN(s.total) + '</td><td>' + (s.nota ? String(s.nota).replace('.', ',') : '—') + '</td><td>' + (s.origem === 'manual' ? 'à mão' : 'Google') + '</td></tr>'; }).join('') + '</table></div>' : '')
    + '<div class="row" style="margin-top:10px"><button class="btn p" id="rpc">📋 Copiar texto</button><button class="btn" onclick="cl()">Fechar</button></div>');
  $('rpc').onclick = function () { try { navigator.clipboard.writeText(t); toast('Copiado ✓'); } catch (e) { alert(t); } };
}
