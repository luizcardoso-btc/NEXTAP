# Backend da NexTap

API que dá suporte ao site, ao painel do revendedor e ao painel do admin: cadastro/login,
placas, vendas, pedidos e pagamento via Mercado Pago (Pix e cartão de crédito).

## 1. O que você precisa antes de começar

1. **Conta no Mercado Pago** (a mesma que você já usa para vender) e uma aplicação criada em
   https://www.mercadopago.com.br/developers/panel/app — de lá você pega o **Access Token de produção**.
2. **Node.js 18 ou mais novo** instalado, se for rodar na sua máquina.
3. Uma conta em algum serviço de hospedagem para o backend ficar sempre no ar, por exemplo
   **Railway** (railway.app) ou **Render** (render.com) — os dois têm plano gratuito/baixo custo
   e são simples de configurar. O Mercado Pago *exige* que o backend tenha uma URL pública
   (https), porque ele avisa sobre pagamentos por webhook — não funciona rodando só na sua máquina.

## 2. Rodando localmente (para testar)

```bash
cd nextap-backend
npm install
cp .env.example .env
```

Abra o `.env` e preencha:
- `JWT_SECRET`: qualquer texto longo e aleatório.
- `MP_ACCESS_TOKEN`: o access token de produção do Mercado Pago.
- `ADMIN_EMAIL` / `ADMIN_PASSWORD`: o login que você vai usar no painel admin.
- `PUBLIC_BACKEND_URL` e `FRONTEND_URL`: por enquanto pode deixar como estão; você atualiza
  depois de publicar (passo 3).

Depois:
```bash
npm start
```
O servidor sobe em `http://localhost:3000`. Sem publicar, o Pix real não vai funcionar (porque
o Mercado Pago não consegue te avisar do pagamento), mas dá para testar cadastro, login,
placas e vendas.

## 3. Publicando (deploy)

### Opção Railway (recomendada, mais simples)
1. Crie uma conta em https://railway.app e um novo projeto.
2. "Deploy from GitHub repo" (suba esta pasta pro GitHub antes) ou use o Railway CLI para
   subir a pasta direto.
3. Em "Variables", cole o conteúdo do seu `.env` (uma variável por linha).
4. O Railway te dá uma URL pública (ex: `https://nextap-backend-production.up.railway.app`).
   Copie essa URL.
5. Volte nas variáveis e ajuste `PUBLIC_BACKEND_URL` para essa mesma URL, e `FRONTEND_URL`
   para a URL do seu site/painel do revendedor.

**Importante — banco de dados no Railway:** o backend usa SQLite em arquivo, e o disco do
Railway é apagado a cada deploy. Para não perder revendedores, pedidos e placas, crie um
**Volume** no serviço (aba *Settings → Volumes*, ex.: montado em `/data`). O caminho do banco é
detectado automaticamente (ou defina `DB_PATH`). Confira em `/health` se o serviço subiu.

### Opção Render
Mesma ideia: "New Web Service", aponte para o repositório, comando de start `npm start`,
e configure as mesmas variáveis de ambiente.

## 4. Configurando o webhook no Mercado Pago

No painel do Mercado Pago (developers → sua aplicação → Webhooks), cadastre a URL:
```
https://SEU-BACKEND-PUBLICADO/api/payments/webhook
```
e marque o evento **"Pagamentos"**. É assim que o pedido muda automaticamente para "pago"
e as placas entram no estoque do revendedor assim que o Pix cai ou o cartão é aprovado.

## 5. Ligando o backend aos 3 painéis (frontend)

Os três arquivos HTML (site, painel do revendedor, painel admin) hoje guardam os dados no
navegador (localStorage), como protótipo. Para usarem este backend de verdade, é preciso
trocar essas partes por chamadas `fetch()` para:

- `POST /api/auth/register` e `/api/auth/login` — cadastro e login do revendedor
- `POST /api/auth/admin-login` — login do admin
- `GET/PUT /api/resellers/me`, `/plates`, `/sales`, `/orders` — dados do painel do revendedor
- `POST /api/payments/checkout` — iniciar o pagamento (Pix ou cartão) de um pedido de placas
- `GET /api/payments/orders/:id/status` — consultar se o Pix já caiu
- `GET /api/admin/*` — dados do painel admin

Todas as rotas de revendedor e admin exigem o cabeçalho:
```
Authorization: Bearer <token recebido no login>
```

Posso fazer essa integração nos 3 arquivos agora, conectando de fato os painéis a este
backend — é o próximo passo natural depois de publicá-lo.

## 6. Estrutura de pastas

```
nextap-backend/
  server.js            → ponto de entrada
  db/index.js          → banco SQLite e criação das tabelas
  middleware/auth.js    → validação do token de login
  routes/auth.js        → cadastro/login
  routes/resellers.js   → placas, vendas e pedidos do revendedor logado
  routes/payments.js    → checkout Pix/cartão + webhook do Mercado Pago
  routes/admin.js       → visão geral, revendedores, pedidos e placas (admin)
  routes/public.js      → /r/:codigo — o link que fica gravado no QR/NFC da placa
```

## 7. Segurança e observações importantes

- O `.env` nunca deve ser enviado ao GitHub (já existe um `.gitignore` para isso).
- Troque `ADMIN_PASSWORD` por uma senha forte antes de publicar.
- O Access Token do Mercado Pago dá acesso à sua conta de recebimento — trate como uma senha.
- Este backend não foi testado com credenciais reais (não tenho como chamar a API do
  Mercado Pago a partir daqui). Teste o fluxo de Pix e cartão com valores baixos antes de
  divulgar para seus revendedores.
