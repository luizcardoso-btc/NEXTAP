# NexTap — não perder dados (passo a passo)

O código já guarda tudo em SQLite num Volume do Railway, com migrações só-aditivas e backup diário.
O aviso vermelho do admin aparece porque **ainda não há Volume conectado**. Não é preciso trocar de banco.
Este pacote só acrescenta a peça que faltava: **restaurar** um backup.

## Ordem segura (faça nesta ordem)
1. **Salve o que existe hoje:** painel admin → **⬇ Backup** (baixa um `.db`). Guarde no computador. Faça isso ANTES de qualquer deploy.
2. **Crie o Volume:** Railway → serviço NEXTAP → Settings → Volumes → montar em `/data`.
3. **Suba estes arquivos** no GitHub (`routes-restore.js`, `PERSISTENCIA.md` e a 1 linha nova do `server.js`) e aguarde o deploy.
4. **Restaure:** abra `https://SEU-DOMINIO/admin/restaurar`, entre com o admin, escolha o `.db` e clique em **Restaurar** (modo *Mesclar*).
5. **Confira:** o aviso vermelho some e `/health` mostra `dados_persistentes: true`. Faça um novo deploy e veja se os dados continuam.

## Garantias da restauração
- Confere se o arquivo é SQLite, íntegro e da NexTap; senão, recusa.
- Guarda uma cópia do banco atual em `backups/antes-da-restauracao-*.db` (mantém as 5 últimas).
- Tudo em uma transação: se der erro, nada é alterado.
- *Mesclar* só adiciona o que falta (rodar duas vezes não duplica). *Substituir* troca tudo pelo backup.
- Aceita backup de versão mais antiga do banco (copia só as colunas em comum).

## Rotina recomendada
Baixe um ⬇ Backup toda semana e guarde fora do Railway. O backup diário fica no mesmo Volume: protege de erro e de deploy, mas não de apagar o serviço.

## Proteção dos próximos cadastros: backup externo por e-mail
Arquivo `backup-externo.js`. Sempre que houver mudança (novo revendedor, pedido, placa, venda), o sistema envia ao seu e-mail
uma cópia `.db` + uma planilha `.csv` com nome, e-mail e WhatsApp de todos os revendedores (no máximo 1 por hora, só se mudou algo).
Assim, mesmo que o Volume ou o serviço sejam perdidos, os contatos e os dados continuam com você.

No Railway → Variables:
- `RESEND_API_KEY` e `MAIL_FROM` (as mesmas do "esqueci a senha"; o domínio do `MAIL_FROM` precisa estar verificado no Resend)
- `BACKUP_EMAIL_TO` (opcional; padrão = `ADMIN_EMAIL`). Use um e-mail só seu: o `.db` tem dados pessoais e hashes de senha.

Para testar: no admin (logado), `POST /api/admin/backup-email`, ou espere ~1 min após o deploy (o primeiro envio é automático).
Nos logs aparece `[BACKUP-EXT] Backup enviado por e-mail`.

## Se a restauração não funcionar
- `/admin/restaurar` dá "Rota não encontrada": os arquivos novos ainda não foram para o GitHub/deploy (falta `routes-restore.js` ou a linha do `server.js`).
- "Arquivo inválido": envie o `.db` baixado do botão Backup, não um `.zip` nem outro arquivo.
- Deu certo mas o painel está vazio: o backup foi baixado depois de os dados já terem sido apagados por um deploy. Veja o plano de resgate abaixo.

## Resgate quando o backup está vazio
Dados de revendedores que já se cadastraram podem ser reconstruídos parcialmente por: e-mails de "esqueci a senha" e pagamentos no painel do
Mercado Pago (e-mail/nome do pagador dos pedidos pagos), além de conversas de WhatsApp com quem pediu cadastro. Os pedidos pagos aparecem
no Mercado Pago mesmo que o banco tenha sido apagado.
