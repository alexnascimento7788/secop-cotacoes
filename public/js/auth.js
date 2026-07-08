// Verifica autenticação em todas as páginas (exceto login.html)
(async () => {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.replace('/login.html'); return; }
    const user = await res.json();
    const el = document.getElementById('sidebar-username');
    if (el) el.textContent = user.username;
    _injetarToggleDark();
    _injetarVersao();
  } catch {
    window.location.replace('/login.html');
  }
})();

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  window.location.replace('/login.html');
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
    el.style.cssText = 'font-size:10px;color:var(--text-subtle);text-align:center;padding:4px 0 6px;opacity:.55;letter-spacing:.4px;';
    sidebar.appendChild(el);
  } catch {}
}
