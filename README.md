# NexTap

Backend (Node/Express + SQLite) e as 3 páginas (site, painel do revendedor, painel admin), tudo no mesmo serviço.

| Endereço | O que é |
|---|---|
| `/` | Site de vendas (`site.html`) |
| `/revendedor/` | Painel do revendedor (`revendedor.html`; aceita `?tab=login` e `?tab=registro`) |
| `/admin/` | Painel admin (`admin.html`) |
| `/health` | Verificação de saúde (mostra `dados_persistentes: true` quando o Volume está ligado) |

Todos os arquivos ficam na raiz do repositório (sem pastas). Variáveis de ambiente: veja `.env.example`.
Imagens (também na raiz): `logo.png` (logo recortado), `favicon.png` e `placa.jpg` (foto da placa). Para trocar a foto
da placa, suba outro arquivo com o mesmo nome `placa.jpg`.

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
