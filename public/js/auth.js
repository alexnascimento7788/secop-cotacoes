// Verifica autenticação em todas as páginas (exceto login.html)
// getCurrentUser() fica disponível pra outras páginas reaproveitarem sem novo fetch (promise cacheada)
window.getCurrentUser = () => window._userPromise || (window._userPromise = (async () => {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.replace('/login.html'); return null; }
    return await res.json();
  } catch {
    window.location.replace('/login.html');
    return null;
  }
})());

(async () => {
  const user = await window.getCurrentUser();
  if (!user) return;

  const el = document.getElementById('sidebar-username');
  if (el) el.textContent = user.username;
  // Configurações (e a Lixeira dentro dela) só ficam visíveis pro master ou
  // admin com acesso_avancado — role "admin" sozinho não basta mais
  const podeConfig = user.username === 'master' || (user.role === 'admin' && user.acesso_avancado);
  if (!podeConfig) {
    document.querySelectorAll('a.sidebar-gear[href="admin.html"]').forEach(a => a.remove());
  }
  _injetarToggleDark();
  _injetarVersao();
  _initInatividade();
})();

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  localStorage.removeItem(LS_ULTIMA_ATIVIDADE);
  window.location.replace('/login.html');
}

/* ── Timeout por inatividade ──────────────────────────────
   O servidor já expira a sessão sozinho (secop_sid vira inválido) depois de
   X minutos sem nenhuma requisição autenticada — isso é o que realmente
   protege os dados. Este watcher só cobre o caso de o usuário ficar com a
   aba aberta sem clicar em nada: sem ele, ninguém percebe que expirou até
   tentar usar algo. LS_ULTIMA_ATIVIDADE fica no localStorage (não sessionStorage)
   pra que atividade em uma aba também resete o timer nas outras. */
const LS_ULTIMA_ATIVIDADE = 'secop_ultima_atividade';
let _inatividadeMs = 30 * 60 * 1000; // sobrescrito por /api/config em _initInatividade

function _registrarAtividade() {
  localStorage.setItem(LS_ULTIMA_ATIVIDADE, String(Date.now()));
}

let _ultimoRegistro = 0;
function _atividadeThrottled() {
  const agora = Date.now();
  if (agora - _ultimoRegistro > 5000) { // não escreve no localStorage a cada pixel de mousemove
    _ultimoRegistro = agora;
    _registrarAtividade();
  }
}

async function _verificarInatividade() {
  const ultima = parseInt(localStorage.getItem(LS_ULTIMA_ATIVIDADE) || '0', 10);
  if (!ultima) { _registrarAtividade(); return; }
  if (Date.now() - ultima > _inatividadeMs) {
    logout();
    return;
  }
  // Houve atividade recente: confirma com o servidor (e renova a sessão lá também)
  try {
    const r = await fetch('/api/auth/me');
    if (!r.ok) { window.location.replace('/login.html'); }
  } catch {}
}

async function _initInatividade() {
  try {
    const r = await fetch('/api/config');
    if (r.ok) {
      const cfg = await r.json();
      const min = parseInt(cfg.inatividade_minutos, 10);
      if (min > 0) _inatividadeMs = min * 60 * 1000;
    }
  } catch {}
  _registrarAtividade();
  ['mousemove', 'keydown', 'mousedown', 'scroll', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, _atividadeThrottled, { passive: true })
  );
  setInterval(_verificarInatividade, 60000);
}

/* ── Dark mode ─────────────────────────────────────────── */
function _injetarToggleDark() {
  const footer = document.querySelector('.sidebar-footer');
  if (!footer) return;

  const btn = document.createElement('button');
  btn.id = 'dark-toggle';
  btn.title = 'Alternar modo escuro';
  btn.style.cssText = 'background:none;border:none;cursor:pointer;padding:3px 5px;border-radius:4px;color:var(--text-subtle);font-size:16px;line-height:1;transition:color .15s,background .15s;flex-shrink:0;';
  btn.setAttribute('aria-label', 'Alternar modo escuro');
  btn.innerHTML = _temaAtual() === 'dark' ? '☀️' : '🌙';
  btn.addEventListener('click', toggleDark);
  btn.addEventListener('mouseover', () => { btn.style.background = 'rgba(128,128,128,.12)'; btn.style.color = 'var(--text)'; });
  btn.addEventListener('mouseout',  () => { btn.style.background = ''; btn.style.color = 'var(--text-subtle)'; });

  footer.appendChild(btn);
}

function _temaAtual() {
  return localStorage.getItem('secop_tema') || 'light';
}

function toggleDark() {
  const novo = _temaAtual() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('secop_tema', novo);
  document.documentElement.setAttribute('data-theme', novo);
  const btn = document.getElementById('dark-toggle');
  if (btn) btn.innerHTML = novo === 'dark' ? '☀️' : '🌙';
}

/* ── Versão ────────────────────────────────────────────────── */
async function _injetarVersao() {
  try {
    const r = await fetch('/api/version');
    if (!r.ok) return;
    const { version } = await r.json();
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    const el = document.createElement('div');
    el.id = 'sidebar-version';
    el.textContent = `v${version}`;
    el.title = `SECOP Cotações — versão ${version}`;
    el.style.cssText = 'font-size:13px;font-weight:700;color:var(--verde);text-align:center;padding:6px 0;letter-spacing:.4px;flex-shrink:0;';
    // .sidebar é uma coluna flex de altura fixa (top:0/bottom:0, sem overflow) —
    // appendChild no final (depois do footer) empurrava esta linha pra fora da
    // tela, invisível sem rolagem. Inserir ANTES do footer deixa o <nav> (que
    // tem flex:1) absorver o espaço, então cabe sempre dentro da viewport.
    const footer = document.querySelector('.sidebar-footer');
    if (footer) sidebar.insertBefore(el, footer);
    else sidebar.appendChild(el);
  } catch {}
}
