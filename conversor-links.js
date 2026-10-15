// Conversores de link: WhatsApp, Instagram, Facebook e Pix (cópia-e-cola / QR estático do Banco Central).
const bad = m => Object.assign(new Error(m), { status: 422 });
const digitos = s => String(s || '').replace(/\D/g, '');

function whatsapp({ numero, mensagem }) {
  let n = digitos(numero);
  if (n.length === 10 || n.length === 11) n = '55' + n;           // número brasileiro sem o 55
  if (n.length < 12 || n.length > 15) throw bad('Número inválido. Informe com DDD, por exemplo (75) 98820-9055.');
  const msg = String(mensagem || '').trim().slice(0, 500);
  const link = `https://wa.me/${n}` + (msg ? `?text=${encodeURIComponent(msg)}` : '');
  return { link, chave: 'wa:' + n + (msg ? ':' + msg.toLowerCase() : ''), nome: '+' + n };
}

function instagram(entrada) {
  let u = String(entrada || '').trim();
  const m = u.match(/instagram\.com\/([^/?#\s]+)/i) || u.match(/instagr\.am\/([^/?#\s]+)/i);
  if (m) u = m[1]; else if (/^https?:\/\//i.test(u)) throw bad('Cole o @ do perfil ou um link do instagram.com.');
  u = u.replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9._]{1,30}$/.test(u) || ['p', 'reel', 'stories', 'explore'].includes(u.toLowerCase())) throw bad('Perfil inválido. Exemplo: @nextapbr');
  return { link: `https://instagram.com/${u}`, chave: 'ig:' + u.toLowerCase(), nome: '@' + u };
}

function facebook(entrada) {
  let u = String(entrada || '').trim();
  if (/^https?:\/\//i.test(u)) {
    let x; try { x = new URL(u); } catch (e) { throw bad('Link inválido.'); }
    if (!/(^|\.)(facebook\.com|fb\.com|fb\.me)$/i.test(x.hostname)) throw bad('Cole um link do facebook.com ou o nome da página.');
    x.protocol = 'https:'; x.hash = ''; if (/(^|\.)facebook\.com$/i.test(x.hostname)) x.hostname = 'facebook.com';
    const id = x.pathname === '/profile.php' ? x.searchParams.get('id') : null;
    if (id) { x.search = '?id=' + encodeURIComponent(id); }
    else if (!/^\/(share|people|pages)\//i.test(x.pathname)) x.search = '';
    if (x.pathname === '/' && !id) throw bad('Informe a página ou perfil, não só facebook.com.');
    const link = x.toString().replace(/\/$/, '');
    return { link, chave: 'fb:' + link.toLowerCase(), nome: x.pathname.split('/').filter(Boolean)[0] || 'Facebook' };
  }
  u = u.replace(/^@/, '');
  if (!/^[A-Za-z0-9.\-]{3,60}$/.test(u)) throw bad('Página inválida. Cole o link do Facebook ou o nome da página.');
  return { link: `https://facebook.com/${u}`, chave: 'fb:' + u.toLowerCase(), nome: u };
}

// ---- Pix ----
function cpfOk(s) { if (s.length !== 11 || /^(\d)\1+$/.test(s)) return false; for (const t of [9, 10]) { let sum = 0; for (let i = 0; i < t; i++) sum += +s[i] * (t + 1 - i); if ((sum * 10 % 11) % 10 !== +s[t]) return false; } return true; }
function cnpjOk(s) { if (s.length !== 14 || /^(\d)\1+$/.test(s)) return false; for (const t of [12, 13]) { let sum = 0, p = t - 7; for (let i = 0; i < t; i++) { sum += +s[i] * p--; if (p < 2) p = 9; } if ((sum % 11 < 2 ? 0 : 11 - sum % 11) !== +s[t]) return false; } return true; }

// Normaliza a chave e diz o tipo: cpf | cnpj | telefone | email | aleatoria
function chavePix(entrada) {
  const raw = String(entrada || '').trim();
  if (!raw) throw bad('Informe a chave Pix.');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return { tipo: 'aleatoria', chave: raw.toLowerCase() };
  if (raw.includes('@')) { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) || raw.length > 77) throw bad('E-mail da chave Pix inválido.'); return { tipo: 'email', chave: raw.toLowerCase() }; }
  const d = digitos(raw);
  if (!/[a-z]/i.test(raw)) {
    const fone = /^\+|\(/.test(raw) || /^\d{2}\s\d/.test(raw);               // formatado como telefone
    const fmtCpf = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(raw);
    if (d.length === 11 && !fone && cpfOk(d)) return { tipo: 'cpf', chave: d };
    if (d.length === 11 && !fmtCpf && (fone || d[2] === '9')) return { tipo: 'telefone', chave: '+55' + d };
    if (d.length === 14 && cnpjOk(d)) return { tipo: 'cnpj', chave: d };
    if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return { tipo: 'telefone', chave: '+' + d };
    if (d.length === 10 && fone) return { tipo: 'telefone', chave: '+55' + d };
    if (d.length === 11) throw bad('CPF inválido. Confira os números.');
    if (d.length === 14) throw bad('CNPJ inválido. Confira os números.');
  }
  throw bad('Chave Pix não reconhecida. Use CPF, CNPJ, telefone, e-mail ou chave aleatória.');
}

const limpa = (s, max) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, '').trim().toUpperCase().slice(0, max);
const campo = (id, v) => id + String(v.length).padStart(2, '0') + v;
function crc16(s) { let c = 0xFFFF; for (let i = 0; i < s.length; i++) { c ^= s.charCodeAt(i) << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return c.toString(16).toUpperCase().padStart(4, '0'); }

// Monta o "Pix copia e cola" estático. valor é opcional (sem valor, o pagador digita).
function payloadPix({ chave, nome, cidade, valor, descricao }) {
  const v = Number(valor);
  const conta = campo('00', 'br.gov.bcb.pix') + campo('01', chave) + (descricao ? campo('02', limpa(descricao, 40)) : '');
  const base = campo('00', '01') + campo('01', '11') + campo('26', conta) + campo('52', '0000') + campo('53', '986')
    + (v > 0 ? campo('54', v.toFixed(2)) : '') + campo('58', 'BR') + campo('59', limpa(nome, 25) || 'RECEBEDOR')
    + campo('60', limpa(cidade, 15) || 'BRASIL') + campo('62', campo('05', '***')) + '6304';
  return base + crc16(base);
}

function pix({ chave, nome, cidade, valor, descricao }) {
  const k = chavePix(chave);
  if (!limpa(nome, 25)) throw bad('Informe o nome do recebedor (como no seu banco).');
  if (!limpa(cidade, 15)) throw bad('Informe a cidade do recebedor.');
  let val = null;
  if (valor !== undefined && valor !== null && String(valor).trim() !== '') {
    val = Number(String(valor).replace(/\./g, '').replace(',', '.'));
    if (!(val > 0) || val > 999999.99) throw bad('Valor inválido. Deixe em branco para o cliente digitar.');
  }
  const dados = { chave: k.chave, nome: limpa(nome, 25), cidade: limpa(cidade, 15), valor: val, descricao: String(descricao || '').trim().slice(0, 40) };
  return { ...k, ...dados, payload: payloadPix(dados), chaveUnica: 'pix:' + k.chave + ':' + (val || '') + ':' + dados.descricao.toLowerCase() };
}

module.exports = { whatsapp, instagram, facebook, pix, chavePix, payloadPix, crc16 };
