// Restauração de backup (.db) — ARQUIVO NOVO, não altera nada do que já existe.
//
// Para quê: o painel admin já baixa backups (botão "⬇ Backup"), mas não havia como devolver esse arquivo ao sistema.
// Com isto, ao conectar o Volume no Railway (que começa vazio), você sobe o backup antigo e recupera tudo.
//
//  - Página:  GET  /admin/restaurar          (pede o login do admin e envia o arquivo .db)
//  - API:     POST /api/admin/restore?modo=mesclar|substituir   (corpo = arquivo .db; exige admin)
//
// Segurança dos dados:
//  1. Valida que o arquivo é SQLite, íntegro e com as tabelas da NexTap.
//  2. Antes de mexer, tira uma cópia do banco atual (backups/antes-da-restauracao-*.db).
//  3. Tudo numa única transação: se algo falhar, nada é alterado.
//  4. "mesclar" (padrão) só ADICIONA o que falta, sem apagar nem duplicar. "substituir" troca o conteúdo pelo do backup.
//  5. Funciona mesmo que o backup venha de uma versão mais antiga do sistema (copia só as colunas em comum).
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('./database.js');
const { requireAdmin } = require('./auth-middleware.js');

const router = express.Router();

// Ordem que respeita as chaves estrangeiras (pais antes dos filhos).
const TABELAS = ['resellers', 'price_tiers', 'orders', 'plates', 'plate_reads', 'sales', 'password_resets'];
const q = s => `"${String(s).replace(/"/g, '""')}"`;
const sqlStr = s => `'${String(s).replace(/'/g, "''")}'`;

function contar(schema, tabela) {
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${schema}.${q(tabela)}`).get().n; } catch (e) { return 0; }
}
function colunas(schema, tabela) {
  return db.prepare(`PRAGMA ${schema}.table_info(${q(tabela)})`).all().map(c => c.name);
}

router.post('/api/admin/restore',
  requireAdmin,
  express.raw({ type: () => true, limit: '200mb' }),
  (req, res) => {
    const modo = req.query.modo === 'substituir' ? 'substituir' : 'mesclar';
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 512 || buf.slice(0, 15).toString('latin1') !== 'SQLite format 3') {
      return res.status(400).json({ error: 'Arquivo inválido: envie o arquivo .db baixado pelo botão Backup.' });
    }

    const tmp = path.join(os.tmpdir(), `nextap-restore-${Date.now()}.db`);
    let anexado = false;
    try {
      fs.writeFileSync(tmp, buf);

      // 1) valida o arquivo enviado
      const chk = new Database(tmp, { readonly: true, fileMustExist: true });
      try {
        const integ = chk.pragma('integrity_check', { simple: true });
        if (integ !== 'ok') return res.status(400).json({ error: 'O arquivo está corrompido (integrity_check falhou).' });
        const tem = chk.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='resellers'").get();
        if (!tem) return res.status(400).json({ error: 'Este arquivo não parece ser um backup da NexTap.' });
      } finally { chk.close(); }

      // 2) cópia de segurança do banco atual
      fs.mkdirSync(db.meta.backupDir, { recursive: true });
      const seguranca = path.join(db.meta.backupDir, `antes-da-restauracao-${Date.now()}.db`);
      db.exec(`VACUUM INTO ${sqlStr(seguranca)}`);
      try {
        fs.readdirSync(db.meta.backupDir).filter(f => f.startsWith('antes-da-restauracao-')).sort().reverse()
          .slice(5).forEach(f => fs.unlinkSync(path.join(db.meta.backupDir, f)));
      } catch (e) { /* sem problema */ }

      // 3) importa
      db.exec(`ATTACH DATABASE ${sqlStr(tmp)} AS bk`);
      anexado = true;
      const existentes = new Set(db.prepare("SELECT name FROM bk.sqlite_master WHERE type='table'").all().map(r => r.name));
      const bancoNovo = contar('main', 'resellers') === 0 && contar('main', 'orders') === 0;

      const relatorio = {};
      db.pragma('foreign_keys = OFF'); // só durante a importação; reativado logo abaixo
      try {
        db.transaction(() => {
          if (modo === 'substituir') {
            [...TABELAS].reverse().forEach(t => db.exec(`DELETE FROM main.${q(t)}`));
          }
          for (const t of TABELAS) {
            if (!existentes.has(t)) { relatorio[t] = { no_backup: 0, adicionados: 0 }; continue; }
            if (t === 'price_tiers' && !(modo === 'substituir' || bancoNovo)) {
              relatorio[t] = { no_backup: contar('bk', t), adicionados: 0, obs: 'preços atuais mantidos' };
              continue;
            }
            if (t === 'price_tiers') db.exec('DELETE FROM main.price_tiers');
            const comuns = colunas('main', t).filter(c => colunas('bk', t).includes(c));
            const lista = comuns.map(q).join(', ');
            const antes = contar('main', t);
            db.exec(`INSERT OR IGNORE INTO main.${q(t)} (${lista}) SELECT ${lista} FROM bk.${q(t)}`);
            relatorio[t] = { no_backup: contar('bk', t), adicionados: contar('main', t) - antes };
          }
          const fk = db.pragma('foreign_key_check');
          if (fk.length) throw new Error('Backup com referências quebradas (' + fk.length + ' linhas).');
        })();
      } finally {
        db.pragma('foreign_keys = ON');
      }

      console.log(`[DB] Restauração (${modo}) concluída:`, JSON.stringify(relatorio));
      res.json({ ok: true, modo, relatorio, copia_de_seguranca: path.basename(seguranca) });
    } catch (e) {
      console.error('[DB] Falha na restauração:', e.message);
      res.status(500).json({ error: 'Não foi possível restaurar: ' + e.message + ' Nada foi alterado.' });
    } finally {
      if (anexado) { try { db.exec('DETACH DATABASE bk'); } catch (e) { /* ok */ } }
      fs.unlink(tmp, () => {});
    }
  });

// Página simples para fazer a restauração pelo navegador.
router.get(['/admin/restaurar', '/admin/restaurar/'], (req, res) => {
  res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>NexTap — Restaurar backup</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;color:#0f172a}
h1{font-size:20px}label{display:block;margin:14px 0 4px;font-weight:600;font-size:14px}
input,select,button{width:100%;padding:10px;font-size:15px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px}
button{background:#16a34a;color:#fff;border:0;margin-top:16px;cursor:pointer;font-weight:600}
pre{background:#f1f5f9;padding:12px;border-radius:8px;overflow:auto;font-size:13px}.m{color:#64748b;font-size:13px}
.e{color:#dc2626}</style></head><body>
<h1>Restaurar backup da NexTap</h1>
<p class="m">Envie o arquivo <b>.db</b> baixado pelo botão ⬇ Backup do painel admin. O sistema confere o arquivo e guarda uma cópia do banco atual antes de mexer.</p>
<label>E-mail do admin</label><input id="em" type="email" autocomplete="username">
<label>Senha do admin</label><input id="pw" type="password" autocomplete="current-password">
<label>Arquivo de backup (.db)</label><input id="f" type="file" accept=".db,application/octet-stream">
<label>Modo</label><select id="modo">
<option value="mesclar">Mesclar — só adiciona o que falta (recomendado)</option>
<option value="substituir">Substituir — troca tudo pelo conteúdo do backup</option></select>
<button id="go">Restaurar</button><p id="msg" class="m"></p><pre id="out" style="display:none"></pre>
<script>
var $=function(i){return document.getElementById(i)};
$('go').onclick=async function(){
  var msg=$('msg'),out=$('out');out.style.display='none';msg.className='m';
  var f=$('f').files[0];if(!f){msg.textContent='Escolha o arquivo .db.';return}
  if($('modo').value==='substituir'&&!confirm('Substituir apaga os dados atuais e usa os do backup. Continuar?'))return;
  try{
    msg.textContent='Entrando…';
    var r=await fetch('/api/auth/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('em').value,password:$('pw').value})});
    var j=await r.json();if(!r.ok)throw new Error(j.error||'Login inválido.');
    msg.textContent='Enviando backup…';
    r=await fetch('/api/admin/restore?modo='+$('modo').value,{method:'POST',headers:{Authorization:'Bearer '+j.token,'Content-Type':'application/octet-stream'},body:f});
    j=await r.json();if(!r.ok)throw new Error(j.error||'Falha ao restaurar.');
    msg.textContent='Pronto! Backup restaurado.';out.textContent=JSON.stringify(j.relatorio,null,2);out.style.display='block';
  }catch(e){msg.className='e';msg.textContent=e.message}
};
</script></body></html>`);
});

module.exports = router;
