# NexTap — domínio próprio (Registro.br → Railway) e segurança

Site, painel do revendedor e admin são servidos pelo MESMO serviço, então um domínio só cobre tudo:
- `https://SEU-DOMINIO/` → site · `/revendedor` → painel do revendedor · `/admin` → painel admin · `/r/CODIGO` → QR/NFC da placa

## 1. Railway
Serviço NEXTAP → Settings → Networking → **Custom Domain** → digite `app.SEU-DOMINIO.com.br` (e depois `www.…`, se quiser).
O Railway mostra um **CNAME** (algo como `abc123.up.railway.app`) e um **TXT** de verificação. Copie os dois.

## 2. Registro.br
Meus Domínios → seu domínio → **Editar zona** (DNS do Registro.br) → Nova entrada:
| Tipo  | Nome              | Dados                          |
|-------|-------------------|--------------------------------|
| CNAME | `app` (ou `www`)  | o valor CNAME do Railway       |
| TXT   | o nome que o Railway indicar | o valor TXT do Railway |
Aguarde alguns minutos até o Railway marcar como verificado (HTTPS é emitido sozinho).
Domínio "pelado" (`SEU-DOMINIO.com.br`, sem prefixo) não aceita CNAME no DNS do Registro.br: use subdomínio (`app.`/`www.`) como endereço oficial,
ou aponte os servidores DNS para a Cloudflare (grátis), que permite CNAME na raiz.

## 3. Variáveis (Railway → Variables) — depois que o domínio estiver verificado
- `PUBLIC_BACKEND_URL=https://app.SEU-DOMINIO.com.br`
- `FRONTEND_URL=https://app.SEU-DOMINIO.com.br` (vários, separados por vírgula, se usar `www`)
- Mercado Pago: se a URL do webhook foi cadastrada à mão no painel, atualize para `https://app.SEU-DOMINIO.com.br/api/payments/webhook`.
- Não apague o domínio `…up.railway.app`: placas já gravadas continuam funcionando por ele.
- Se usar Cloudflare com proxy (nuvem laranja), troque `trust proxy` de 1 para 2 no server.js (senão o limite de tentativas enxerga o IP da Cloudflare).

## 4. Segurança (arquivo `seguranca.js` + 1 linha no server.js)
- Cabeçalhos: HTTPS forçado nos navegadores (HSTS), anti-clickjacking, anti-sniffing, política de referência, sem `X-Powered-By`.
- Limite de tentativas por IP: admin 5/15 min · login 10/15 min · recuperar senha 5/15 min · cadastro 10/h · restauração de backup 10/h.
  (Webhook do Mercado Pago, `/r/CODIGO` e o restante não são limitados.)

Faça também (no Railway/Resend, sem código):
1. `ADMIN_PASSWORD` longa e única (16+ caracteres) e `JWT_SECRET` aleatório de 64+ caracteres; troque se já foram compartilhados.
2. Ative verificação em duas etapas no Railway, GitHub, Registro.br e Mercado Pago.
3. No Resend, verifique o domínio e use `MAIL_FROM=NexTap <no-reply@SEU-DOMINIO.com.br>` (entrega melhor e protege contra falsificação).
4. Mantenha o repositório do GitHub **privado** e nunca coloque `.env`/chaves nele.
5. No Registro.br, ative a renovação automática do domínio.
