# Declaração de conteúdo em PDF — como instalar (3 passos, nada existente é reescrito)

1. Copie `declaracao-conteudo.js` e `declaracao.html` para a raiz do repositório (junto do `server.js`).
2. No `package.json`, em `dependencies`, acrescente:  `"pdfkit": "^0.20.2"`   (ou rode `npm install pdfkit`).
3. No `server.js`, acrescente esta linha logo ANTES de `app.use('/', require('./routes-public.js'));`:

       app.use('/', require('./declaracao-conteudo.js')); // declaração de conteúdo em PDF

Depois do deploy:
- Abra `/admin/` e entre; depois abra `/admin/declaracao`.
- Preencha os dados do remetente (sua empresa) e clique em **Salvar dados**.
- Todo pedido que ficar **pago** ganha o PDF sozinho em até 1 minuto. Botão **⬇ PDF** baixa na hora (sempre com os dados atuais).

Onde ficam os arquivos: pasta `declaracoes/` dentro do Volume do Railway (mesma pasta do banco), então sobrevivem aos deploys.
Tabela nova: `declaracoes` (criada sozinha). Nenhuma tabela existente é alterada.

Texto da declaração (campo "Texto da declaração"):
- **Mercadoria acompanha NF-e** (padrão): para quem emite NF-e no envio.
- **Não contribuinte (modelo dos Correios)**: só use se a sua empresa realmente estiver dispensada de NF-e.
