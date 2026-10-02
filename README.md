# NexTap

Backend (Node/Express + SQLite) e as 3 páginas (site, painel do revendedor, painel admin), tudo no mesmo serviço.

| Endereço | O que é |
|---|---|
| `/` | Site de vendas (`site.html`) |
| `/revendedor/` | Painel do revendedor (`revendedor.html`; aceita `?tab=login` e `?tab=registro`) |
| `/admin/` | Painel admin (`admin.html`) |
| `/health` | Verificação de saúde (mostra `dados_persistentes: true` quando o Volume está ligado) |

Todos os arquivos ficam na raiz do repositório (sem pastas). Variáveis de ambiente: veja `.env.example`.
Imagens (também na raiz): `logo.png` (logo recortado), `favicon.png`, `placa.jpg` (foto da placa no topo do site) e
`placas-nextap.jpg` (as 3 placas flutuando no bloco "A placa"). Para trocar uma foto, suba outro arquivo com o mesmo nome.

## Login do revendedor
Tela em duas colunas, com "Manter conectado" (marcado = fica logado neste aparelho; desmarcado = sai ao fechar a aba)
e "Esqueci a senha". O link de redefinição vale 1 hora e só funciona uma vez. Se o e-mail (Resend) não estiver
configurado, o link aparece nos logs do Railway e o admin pode gerar o link em *Revendedores → 🔑 Link de senha*.

## Como os dados dos revendedores ficam salvos

1. **Volume do Railway:** o banco (`nextap.db`) fica num Volume, fora do código. Atualizar o backend, fazer commit ou
   redeploy **não apaga nem sobrescreve** o banco. Crie o Volume em *projeto → + Create → Volume*, conecte ao serviço
   NEXTAP e monte em `/data`. O caminho é detectado sozinho.
2. **Migrações de estrutura:** mudanças futuras no banco entram como itens novos no fim da lista `MIGRACOES` em
   `database.js`. Elas só adicionam (colunas/tabelas) e, antes de rodar, o sistema tira uma cópia do banco.
3. **Backup automático:** 1 por dia na pasta `backups/` do Volume (guarda as 14 mais recentes).
4. **Backup manual:** botão **⬇ Backup** no painel admin baixa uma cópia completa (`.db`).

Nunca suba um arquivo `nextap.db` para o GitHub (o `.gitignore` já bloqueia).

## Minhas placas (painel do revendedor)
- Cada placa tem um **código de rastreio** impresso na frente (`#00001`, `#00002`…), gerado quando o pedido é pago.
  O revendedor pode digitar o código em **Ativar uma placa** para abrir a configuração dela.
- Configuração: código, nome do cliente/empresa, nome/identificação da placa, tipo de destino (Google Avaliações,
  Instagram, Facebook, Site, Cardápio, Link personalizado) e link. **Configurada** = tem link de destino.
- O QR Code e o NFC da placa nunca mudam; só o destino é alterado.
- Leituras: total, hoje, 7 dias, 30 dias, última leitura e destino atual.

## Minha conta (painel do revendedor)
Dados do revendedor + endereço completo (CEP, rua, número, complemento, bairro, cidade, UF, país). Ao digitar o CEP,
o restante é preenchido sozinho (ViaCEP). O endereço já vem preenchido no checkout e será usado no comprovante operacional.

## Proteção e recuperação dos dados (admin → Gestão → 🛡 Dados e backups)
- **Cópias automáticas** no Volume: 1 por dia, 1 a cada vez que o sistema liga (cada deploy) e 1 antes de cada
  atualização da estrutura do banco.
- **Baixar backup** (.db) e **lista de revendedores** (planilha CSV) para guardar no seu computador.
- **Restaurar:** de um arquivo .db enviado, ou de um backup guardado no servidor. Dois modos:
  *só recuperar revendedores que faltam* (não apaga nada) ou *substituir tudo*. Antes de restaurar, o sistema guarda
  uma cópia do estado atual — dá para desfazer.
- **Reativar um revendedor:** cadastro manual que gera o link para a pessoa criar a senha.
- Proteções extras: limite de tentativas de login, verificação de integridade ao ligar, gravação segura em disco.

## Pagamentos e pedidos (admin → Pedidos / Visão geral / Financeiro)
- **Situação do pedido:** Aguardando pagamento → Pago → Enviado → Entregue (ou Cancelado). Só pedidos pagos entram no
  faturamento; os que aguardam aparecem em "A receber".
- **Não depende só do webhook:** a cada 3 minutos o sistema confere os pedidos pendentes direto no Mercado Pago, e o
  painel tem os botões **🔄 Conferir** (um pedido ou todos). O webhook agora entende o formato antigo (IPN) e responde 500
  em caso de erro, para o Mercado Pago tentar de novo.
- **Proteção contra pagamento errado:** só aceita se valor, data e (no Pix) o id do pagamento conferem com o pedido.
- **Confirmar pagamento (manual):** para quando o dinheiro entrou por outro meio. Exige observação e fica registrado.
- **Financeiro → Conferir com o Mercado Pago:** lista pagamentos aprovados de placas NexTap sem pedido no sistema.
- **Admin → Dados e backups → Notificações de pagamento:** histórico do que foi recebido/conferido.
- Revendedor: andamento do pedido, "Pago em", e botão **Ver Pix / pagar** para pedidos pendentes.

## Domínio próprio e segurança
Variáveis: `SITE_HOST=www.nextapbrasil.com.br` e `PUBLIC_BACKEND_URL=https://www.nextapbrasil.com.br`.
Com isso: quem entra pelo endereço sem www ou pelo `.up.railway.app` é redirecionado (301) ao principal; HSTS; CORS
restrito ao domínio; robots.txt (painéis fora do Google); cabeçalhos de segurança. O webhook e o /health nunca são redirecionados.

## Tabela de preços e pedido mínimo
Tabela atual: **5 a 10 placas = R$ 21,90 · 11 a 49 = R$ 17,50 · 50 a 299 = R$ 16,50 · 300 a ∞ = R$ 15,90**.
O pedido mínimo é onde começa a primeira faixa (5 placas) e é exigido no checkout. A tabela fica no banco: o site
(`/api/public/price-tiers`), o painel do revendedor e a cobrança leem a mesma fonte. Para mudar preços, use
Admin → Preços (vale na hora em todos os lugares).
