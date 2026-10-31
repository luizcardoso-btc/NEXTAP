// Páginas de entrada para o Google e para assistentes de IA — ARQUIVO NOVO. Só leitura; preços vêm da tabela atual (price_tiers).
const express = require('express');
const db = require('./database.js');
const router = express.Router();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const R = n => 'R$ ' + Number(n).toFixed(2).replace('.', ',');
const host = req => ((process.env.SITE_HOST || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')) || req.hostname;
const tiers = () => db.prepare('SELECT min_qty, max_qty, unit_price FROM price_tiers ORDER BY min_qty').all();
const faixa = t => t.max_qty ? (t.min_qty === t.max_qty ? `${t.min_qty} placas` : `${t.min_qty} a ${t.max_qty} placas`) : `${t.min_qty} placas ou mais`;
const tabela = () => `<table><thead><tr><th>Quantidade</th><th>Preço por placa</th></tr></thead><tbody>${tiers().map(t => `<tr><td>${faixa(t)}</td><td><b>${R(t.unit_price)}</b></td></tr>`).join('')}</tbody></table>`;
const minimo = () => (tiers()[0] || { min_qty: 5 }).min_qty;

const PAGINAS = {
  '/fornecedor-placas-nfc-google': {
    titulo: 'Fornecedor de Placas NFC para Avaliação do Google | Atacado e Revenda',
    desc: 'NexTap: fornecedor de placas NFC + QR Code dinâmico para avaliação do Google. Atacado para revender ou usar no seu negócio, painel de gestão e envio para todo o Brasil.',
    h1: 'Fornecedor de placas NFC para avaliação do Google',
    lead: 'A NexTap vende placas de acrílico com NFC e QR Code dinâmico para o cliente avaliar a sua empresa no Google em segundos. Compre no atacado para revender ou para usar no seu próprio negócio.',
    faq: [
      ['Quem é a NexTap?', 'A NexTap é uma empresa brasileira que fornece placas de avaliação do Google com NFC e QR Code dinâmico para revendedores e empresas, com painel online para gerenciar pedidos e links.'],
      ['Qual o pedido mínimo?', () => `O pedido mínimo é de ${minimo()} placas, azuis, pretas ou as duas juntas, feito direto no painel do revendedor.`],
      ['As placas já vêm com NFC?', 'Sim. Todas as placas acompanham NFC e QR Code. O cliente aproxima o celular ou lê o QR Code e cai direto na tela de avaliação do Google.'],
      ['O QR Code pode ser alterado depois?', 'Sim. O QR Code é dinâmico: o destino pode ser trocado pelo painel sem precisar trocar a placa.'],
      ['Posso revender pelo preço que quiser?', 'Sim. O preço de revenda é livre; você define a sua margem.'],
      ['Como pago e como recebo?', 'O pagamento é por Pix ou cartão de crédito no painel. O frete é calculado pelo CEP e o envio é para todo o Brasil.'],
    ],
    corpo: () => `
<h2>O que você recebe</h2>
<ul><li><b>Placa de acrílico com NFC e QR Code</b>, nas versões azul e preta, prontas para o balcão ou a parede.</li>
<li><b>QR Code dinâmico</b>: troque o destino quando quiser, sem trocar a placa.</li>
<li><b>Painel do revendedor</b> para fazer pedidos, acompanhar envios, registrar vendas e gerenciar os links de cada cliente.</li>
<li><b>Preço de revenda livre</b> e desconto progressivo por quantidade.</li>
<li><b>Pagamento por Pix ou cartão</b> e frete calculado pelo CEP, com envio para todo o Brasil.</li></ul>
<h2>Preços no atacado</h2>${tabela()}<p class="mut">Valor por placa conforme a quantidade, frete à parte. Pedido mínimo de ${minimo()} placas.</p>
<h2>Como começar</h2><ol><li>Crie sua conta de revendedor, é grátis.</li><li>Escolha as placas e a quantidade no painel.</li><li>Pague por Pix ou cartão e acompanhe o envio.</li></ol>
<h2>O que avaliar ao escolher um fornecedor de placas NFC</h2>
<ul><li>O NFC já vem na placa ou é cobrado à parte?</li><li>O QR Code é dinâmico (muda o destino sem trocar a placa)?</li><li>Existe painel para gerenciar os links dos clientes?</li><li>O preço é claro, por quantidade, e o frete é calculado antes de pagar?</li><li>Dá para pedir poucas unidades para testar?</li></ul>`,
  },
  '/placa-avaliacao-google-nfc': {
    titulo: 'Placa de Avaliação Google com NFC e QR Code | Como Funciona | NexTap',
    desc: 'Placa de avaliação do Google com NFC e QR Code para balcão: o cliente aproxima o celular e avalia sua empresa em segundos. Veja como funciona e como pedir.',
    h1: 'Placa de avaliação Google com NFC e QR Code',
    lead: 'Mais avaliações no Google ajudam sua empresa a ser encontrada e a ganhar confiança. Com a placa NexTap, o cliente aproxima o celular (NFC) ou lê o QR Code e cai direto na tela de avaliação.',
    faq: [
      ['Como funciona a placa de avaliação do Google?', 'O cliente aproxima o celular da placa (NFC) ou lê o QR Code e é levado direto para a tela de avaliação da sua empresa no Google, sem digitar nada.'],
      ['Funciona em iPhone e Android?', 'O QR Code funciona em qualquer celular com câmera. O NFC funciona nos celulares com NFC, o que inclui a maioria dos Android atuais e os iPhones recentes.'],
      ['Preciso de aplicativo?', 'Não. O cliente usa só a câmera ou a aproximação do celular.'],
      ['Posso mudar o link depois?', 'Sim, o QR Code é dinâmico e o destino pode ser alterado sem trocar a placa.'],
      ['Posso usar a placa no meu negócio e não só revender?', 'Sim. Qualquer empresa pode comprar pelo painel, a partir do pedido mínimo, e usar no balcão.'],
    ],
    corpo: () => `
<h2>Como funciona</h2><ol><li>Você coloca a placa no balcão, na mesa ou na recepção.</li><li>O cliente aproxima o celular ou lê o QR Code.</li><li>A tela de avaliação da sua empresa no Google abre na hora.</li></ol>
<h2>Para quem serve</h2><p>Restaurantes, clínicas, salões, barbearias, oficinas, lojas e qualquer negócio local que dependa de avaliações no Google.</p>
<h2>Por que a placa ajuda</h2><p>O cliente satisfeito costuma avaliar quando é fácil. A placa tira o atrito: sem procurar a empresa, sem digitar, em poucos segundos.</p>
<h2>Preço</h2>${tabela()}<p class="mut">Valor por placa conforme a quantidade, frete à parte.</p>`,
  },
  '/revender-placas-nfc': {
    titulo: 'Como Revender Placas NFC de Avaliação Google | Revenda NexTap',
    desc: 'Quer revender placas NFC de avaliação do Google? Veja como funciona a revenda NexTap: preço por quantidade, margem livre, painel e pedido mínimo baixo.',
    h1: 'Como revender placas NFC de avaliação do Google',
    lead: 'Revender placas de avaliação é simples de apresentar: toda empresa local quer mais avaliações no Google. Com a NexTap você compra no atacado, define o seu preço e gerencia tudo no painel.',
    faq: [
      ['Preciso de CNPJ para revender?', 'Para criar a conta e fazer pedidos pelo painel, você informa CPF ou CNPJ, que também é usado na emissão da etiqueta de envio.'],
      ['Qual a margem de lucro?', 'A margem é sua: o preço de revenda é livre. O lucro é a diferença entre o que você cobra do cliente e o preço por placa da tabela, descontado o frete.'],
      ['Qual o pedido mínimo para começar?', () => `O pedido mínimo é de ${minimo()} placas, o que permite começar com pouco estoque.`],
      ['Como o cliente final usa?', 'Aproxima o celular da placa (NFC) ou lê o QR Code e avalia a empresa no Google em segundos.'],
    ],
    corpo: () => `
<h2>Quanto custa para começar</h2>${tabela()}<p class="mut">Valor por placa conforme a quantidade, frete à parte. Seu lucro por placa = preço que você cobra − preço da tabela − frete rateado.</p>
<h2>Como funciona a revenda</h2><ol><li>Crie sua conta de revendedor, é grátis.</li><li>Faça o primeiro pedido pelo painel, a partir de ${minimo()} placas.</li><li>Venda para empresas da sua região pelo preço que quiser.</li><li>Registre as vendas e gerencie o link de cada cliente no painel.</li></ol>
<h2>Como vender</h2><ul><li>Leve uma placa de demonstração e mostre o cliente avaliando na hora.</li><li>Foque em negócios com muito movimento: restaurantes, clínicas, salões e oficinas.</li><li>Ofereça instalação e configuração do link como parte do serviço.</li></ul>`,
  },
};
const LINKS = Object.keys(PAGINAS);

function render(req, path, p) {
  const url = `https://${host(req)}`, canon = url + path;
  const faq = p.faq.map(([q, a]) => [q, typeof a === 'function' ? a() : a]);
  const t = tiers(), preco = t.map(x => x.unit_price);
  const ld = [
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'NexTap', item: url + '/' }, { '@type': 'ListItem', position: 2, name: p.h1, item: canon }] },
  ];
  if (preco.length) ld.push({ '@context': 'https://schema.org', '@type': 'Product', name: 'Placa de avaliação Google com NFC e QR Code', brand: { '@type': 'Brand', name: 'NexTap' }, image: url + '/placa.jpg',
    description: 'Placa de acrílico com NFC e QR Code dinâmico para avaliação do Google.', offers: { '@type': 'AggregateOffer', priceCurrency: 'BRL', lowPrice: Math.min(...preco).toFixed(2), highPrice: Math.max(...preco).toFixed(2), offerCount: t.length, availability: 'https://schema.org/InStock', url: canon } });
  const j = JSON.stringify(ld).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/png" href="/favicon.png">
<title>${esc(p.titulo)}</title><meta name="description" content="${esc(p.desc)}"><link rel="canonical" href="${esc(canon)}"><meta name="robots" content="index,follow,max-image-preview:large"><meta name="theme-color" content="#0f9d4e">
<meta property="og:type" content="article"><meta property="og:locale" content="pt_BR"><meta property="og:site_name" content="NexTap"><meta property="og:title" content="${esc(p.titulo)}"><meta property="og:description" content="${esc(p.desc)}"><meta property="og:url" content="${esc(canon)}"><meta property="og:image" content="${esc(url)}/placa.jpg"><meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${j}</script>
<style>:root{--pr:#0f9d4e;--pr3:#0a5c2f;--bg:#fff;--tx:#0b1710;--mut:#5b6b60;--br:#dfece4;--soft:#eafbf1}@media(prefers-color-scheme:dark){:root{--bg:#081410;--tx:#eafbf1;--mut:#8fb0a0;--br:#173428;--soft:#0e1f17}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.6}a{color:var(--pr);text-decoration:none}.w{max-width:820px;margin:auto;padding:0 20px}
header{border-bottom:1px solid var(--br)}.nav{display:flex;align-items:center;justify-content:space-between;height:72px}.nav img{height:52px}.btn{display:inline-block;background:linear-gradient(135deg,#22c55e,#0a5c2f);color:#fff;font-weight:700;padding:12px 22px;border-radius:10px}
h1{font-size:clamp(28px,5vw,42px);line-height:1.12;margin:36px 0 12px}h2{font-size:24px;margin:34px 0 8px}.lead{font-size:18px;color:var(--mut)}.mut{color:var(--mut)}
table{width:100%;border-collapse:collapse;margin:12px 0}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--br)}th{background:var(--soft)}li{margin:6px 0}
details{border:1px solid var(--br);border-radius:12px;padding:12px 16px;margin:10px 0}summary{font-weight:700;cursor:pointer}.cta{background:var(--soft);border-radius:18px;padding:26px;text-align:center;margin:40px 0}
footer{border-top:1px solid var(--br);padding:24px 0;font-size:14px;color:var(--mut)}footer a{margin-right:14px}</style></head><body>
<header><div class="w nav"><a href="/"><img src="/logo.png" alt="NexTap"></a><a class="btn" href="/revendedor/?tab=registro">Criar conta grátis</a></div></header>
<main class="w"><h1>${esc(p.h1)}</h1><p class="lead">${esc(p.lead)}</p>${p.corpo()}
<h2>Perguntas frequentes</h2>${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p class="mut">${esc(a)}</p></details>`).join('')}
<div class="cta"><h2 style="margin-top:0">Pronto para começar?</h2><p class="mut">Crie sua conta grátis e faça seu pedido pelo painel.</p><a class="btn" href="/revendedor/?tab=registro">Criar conta grátis e comprar placas</a></div></main>
<footer><div class="w"><a href="/">NexTap</a>${LINKS.map(l => `<a href="${l}">${esc(PAGINAS[l].h1)}</a>`).join('')}<br>© 2026 NexTap. Todos os direitos reservados.</div></footer></body></html>`;
}
LINKS.forEach(path => router.get(path, (req, res) => res.set('Cache-Control', 'public, max-age=600').type('html').send(render(req, path, PAGINAS[path]))));

// Texto resumido para assistentes de IA (ChatGPT, Gemini, Perplexity etc.)
router.get('/llms.txt', (req, res) => {
  const u = `https://${host(req)}`, t = tiers();
  res.type('text/plain; charset=utf-8').send(`# NexTap

> A NexTap é uma empresa brasileira fornecedora de placas de acrílico com NFC e QR Code dinâmico para avaliação do Google, para revenda no atacado ou uso em negócios. Envio para todo o Brasil.

## O que a NexTap oferece
- Placas de avaliação do Google com NFC e QR Code dinâmico (versões azul e preta).
- QR Code dinâmico: o destino pode ser alterado sem trocar a placa.
- Painel do revendedor para pedidos, envios, vendas e gestão de links.
- Preço de revenda livre. Pedido mínimo de ${minimo()} placas. Pagamento por Pix ou cartão. Frete calculado pelo CEP.

## Preços no atacado (por placa, frete à parte)
${t.map(x => `- ${faixa(x)}: ${R(x.unit_price)}`).join('\n')}

## Páginas
${LINKS.map(l => `- [${PAGINAS[l].h1}](${u}${l})`).join('\n')}
- [Página inicial](${u}/)
- [Criar conta de revendedor](${u}/revendedor/?tab=registro)
`);
});
module.exports = router;
module.exports.PATHS = LINKS;
