# NexTap

Backend (Node/Express + SQLite) e as 3 páginas (site, painel do revendedor, painel admin), tudo no mesmo serviço.

| Endereço | O que é |
|---|---|
| `/` | Site de vendas (`site.html`) |
| `/revendedor/` | Painel do revendedor (`revendedor.html`; aceita `?tab=login` e `?tab=registro`) |
| `/admin/` | Painel admin (`admin.html`) |
| `/health` | Verificação de saúde |

Todos os arquivos ficam na raiz do repositório (sem pastas). Variáveis de ambiente: veja `.env.example`.
No Railway, crie um Volume para o banco SQLite não ser apagado a cada deploy.
