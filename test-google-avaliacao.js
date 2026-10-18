const assert = require('assert'); const g = require('./google-avaliacao.js');
let ok = 0, ruim = 0; const t = async (n, f) => { try { await f(); ok++; console.log('  ✓ ' + n); } catch (e) { ruim++; console.log('  ✗ ' + n + '\n    ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n    ')); } };
const SYD = 'ChIJN1t_tDeuEmsRUsoyG83frY4', A = '6b12ae37b47f5b37', B = '8eaddfcd1b32ca52', W = id => 'https://search.google.com/local/writereview?placeid=' + id;
// fetch falso: mapa de URL → resposta
const falso = rotas => async (url) => { const r = rotas[url] || rotas[url.split('?')[0]] || Object.entries(rotas).find(([k]) => k.endsWith('*') && url.startsWith(k.slice(0, -1)))?.[1];
  if (!r) return { status: 404, headers: { get: () => null }, text: async () => '' };
  return { status: r.status || 200, headers: { get: h => (h.toLowerCase() === 'location' ? r.loc || null : null) }, text: async () => r.html || '' }; };
(async () => {
  await t('conversão do par 0x…:0x… gera exatamente o Place ID conhecido (Google Sydney)', () => assert.strictEqual(g.placeIdDeHex(A, B), SYD));
  await t('link longo do Google Maps (como copiado da barra de endereço) converte sem rede', async () => {
    const r = await g.converter(`https://www.google.com/maps/place/Barbearia+Zé/@-12.25,-38.96,17z/data=!4m6!3m5!1s0x${A}:0x${B}!8m2!3d-12.2!4d-38.9`, async () => { throw new Error('não deveria usar rede'); });
    assert.strictEqual(r.link, W(SYD));
  });
  await t('Place ID colado sozinho e link de avaliação pronto funcionam', async () => {
    assert.strictEqual((await g.converter(SYD)).link, W(SYD)); assert.strictEqual((await g.converter('https://g.page/r/CaBcDeFg/review')).origem, 'ja_era_avaliacao');
  });
  await t('share.google → redireciona para o Maps com o par na URL', async () => {
    const f = falso({ 'https://share.google/abc': { status: 302, loc: `https://www.google.com/maps/place/X/data=!1s0x${A}:0x${B}` } });
    assert.strictEqual((await g.converter('https://share.google/abc', f)).link, W(SYD));
  });
  await t('share.google → página de pesquisa: escolhe o par da empresa principal (o que mais aparece)', async () => {
    const html = `<html><title>Barbearia Zé - Pesquisa Google</title>${`<a href="/maps?lrd=0x${A}:0x${B},1">x</a>`.repeat(4)}<a href="/maps?lrd=0x1111111111111111:0x2222222222222222">outra</a></html>`;
    const f = falso({ 'https://share.google/abc': { status: 302, loc: 'https://www.google.com/search?q=Barbearia+Z%C3%A9&kgmid=/g/11abc' }, 'https://www.google.com/search': { html } });
    const r = await g.converter('https://share.google/abc', f); assert.strictEqual(r.link, W(SYD)); assert.strictEqual(r.nome, 'Barbearia Zé');
  });
  await t('passa pela tela de cookies (consent.google.com) e segue em frente', async () => {
    const f = falso({ 'https://share.google/abc': { status: 302, loc: 'https://consent.google.com/m?continue=' + encodeURIComponent(`https://www.google.com/maps/place/X/data=!1s0x${A}:0x${B}`) } });
    assert.strictEqual((await g.converter('https://share.google/abc', f)).link, W(SYD));
  });
  await t('plano B: sem id na página, procura o nome no Maps e confere se é a mesma empresa', async () => {
    const f = falso({ 'https://share.google/abc': { status: 302, loc: 'https://www.google.com/search?q=Barbearia+Z%C3%A9' }, 'https://www.google.com/search': { html: '<title>Barbearia Zé - Google</title>' },
      'https://www.google.com/maps/search/*': { status: 302, loc: `https://www.google.com/maps/place/Barbearia+Z%C3%A9/data=!1s0x${A}:0x${B}` } });
    const r = await g.converter('https://share.google/abc', f); assert.strictEqual(r.link, W(SYD)); assert.strictEqual(r.origem, 'busca_maps');
  });
  await t('plano B recusa quando o Maps devolve outra empresa; erro explica o passo a passo', async () => {
    const f = falso({ 'https://share.google/abc': { status: 302, loc: 'https://www.google.com/search?q=Barbearia+Z%C3%A9' }, 'https://www.google.com/search': { html: '<title>x</title>' },
      'https://www.google.com/maps/search/*': { status: 302, loc: `https://www.google.com/maps/place/Padaria+Outra/data=!1s0x${A}:0x${B}` } });
    await assert.rejects(() => g.converter('https://share.google/abc', f), /barra de endereço/);
  });
  await t('segurança: recusa sites que não são do Google, inclusive em redirecionamentos', async () => {
    await assert.rejects(() => g.converter('https://evil.com/x', async () => { throw new Error('rede!'); }), /link do Google/);
    const f = falso({ 'https://share.google/abc': { status: 302, loc: 'https://evil.com/steal' } });
    await assert.rejects(() => g.converter('https://share.google/abc', f), /link do Google/);
  });
  console.log(`\n${ok} passaram, ${ruim} falharam`); process.exit(ruim ? 1 : 0);
})();
