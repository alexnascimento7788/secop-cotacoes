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

  // Módulo ativo: aplica marca/accent e barra acesso a página de outro módulo.
  // Pode redirecionar (escolher módulo / home do módulo ativo) — nesse caso o
  // resto nem chega a rodar.
  if (!(await _aplicarModulo(user))) return;

  const el = document.getElementById('sidebar-username');
  if (el) el.textContent = user.username;
  // Configurações (e a Lixeira dentro dela) só ficam visíveis pro master ou
  // admin com acesso_avancado — role "admin" sozinho não basta mais
  const podeConfig = user.username === 'master' || (user.role === 'admin' && user.acesso_avancado);
  if (!podeConfig) {
    document.querySelectorAll('a.sidebar-gear[href="admin.html"]').forEach(a => a.remove());
  }
  if (user.role === 'consulta') _aplicarModoLeitura();
  _injetarToggleDark();
  _injetarVersao();
  _initInatividade();
})();

/* ── Módulo ativo (plataforma CEASA CONECTA) ───────────────────────────────────
   Retorna true se a página pode continuar carregando; false se disparou um
   redirecionamento (a página pertence a outro módulo, ou a sessão ainda não tem
   módulo escolhido / perdeu acesso ao módulo ativo). */
async function _aplicarModulo(user) {
  let data;
  try {
    const r = await fetch('/api/auth/modulos');
    if (!r.ok) return true; // não bloqueia a página por falha transitória do endpoint
    data = await r.json();
  } catch { return true; }

  const { modulos, modulo_ativo } = data;
  // Slug do módulo a que a página pertence (declarado em <body data-modulo>).
  // Páginas transversais (ex.: admin) não declaram e não passam por checagem de módulo.
  const pageModulo = document.body.dataset.modulo;

  if (!modulo_ativo) { window.location.replace('/selecionar-modulo.html'); return false; }
  const ativo = (modulos || []).find(m => m.slug === modulo_ativo);
  if (!ativo) { window.location.replace('/selecionar-modulo.html'); return false; }
  if (pageModulo && pageModulo !== modulo_ativo) { window.location.replace(ativo.home); return false; }

  document.documentElement.setAttribute('data-modulo', ativo.slug);
  _injetarModuloLabel(ativo, (modulos || []).length > 1);
  return true;
}

function _injetarModuloLabel(modulo, podeTrocar) {
  const brand = document.querySelector('.sidebar-brand');
  if (!brand || document.getElementById('sidebar-modulo')) return;
  const wrap = document.createElement('div');
  wrap.id = 'sidebar-modulo';
  wrap.style.cssText = 'padding:10px 20px 0;display:flex;align-items:center;gap:8px;';
  wrap.innerHTML =
    `<span style="width:9px;height:9px;border-radius:50%;background:${modulo.cor};flex-shrink:0;"></span>` +
    `<span style="font-size:12px;font-weight:700;color:var(--text);letter-spacing:.3px;">${modulo.nome}</span>`;
  if (podeTrocar) {
    const troca = document.createElement('a');
    troca.href = '/selecionar-modulo.html';
    troca.title = 'Trocar de módulo';
    troca.textContent = 'trocar';
    troca.style.cssText = 'margin-left:auto;font-size:11px;color:var(--text-subtle);text-decoration:underline;flex-shrink:0;';
    wrap.appendChild(troca);
  }
  brand.insertAdjacentElement('afterend', wrap);
}

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  localStorage.removeItem(LS_ULTIMA_ATIVIDADE);
  window.location.replace('/login.html');
}

/* ── Modo somente leitura (perfil "consulta") ──────────────────────────────────
   Intercepta chamadas de ESCRITA à API no cliente e mostra um aviso amigável,
   sem ir ao servidor (que também barra, na guarda global). Passam os poucos
   POSTs de VISUALIZAÇÃO (abrir/ping/fechar o preview de contrato no Depop) e
   tudo em /api/auth (login, trocar módulo, logout). É transversal: cobre todos
   os módulos sem precisar mexer em cada botão. */
function _aplicarModoLeitura() {
  document.documentElement.setAttribute('data-readonly', '1');
  const permit = [/\/api\/auth\//, /\/api\/depop\/contratos\/\d+\/(abrir|ping|fechar)\b/];
  const _fetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const method = (init.method || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !permit.some(re => re.test(url))) {
      _avisoLeitura();
      return Promise.resolve(new Response('{"error":"Usuário de consulta: acesso somente leitura."}',
        { status: 403, headers: { 'Content-Type': 'application/json' } }));
    }
    return _fetch(input, init);
  };
  const nav = document.querySelector('.sidebar nav') || document.querySelector('.sidebar');
  if (nav) {
    const selo = document.createElement('div');
    selo.textContent = '👁 Somente leitura';
    selo.style.cssText = 'margin:10px 16px 0;padding:5px 10px;background:rgba(128,128,128,.15);border-radius:6px;font-size:11px;font-weight:700;color:var(--text-muted);text-align:center;';
    nav.appendChild(selo);
  }
}

let _avisoLeituraT;
function _avisoLeitura() {
  let el = document.getElementById('readonly-aviso');
  if (!el) {
    el = document.createElement('div');
    el.id = 'readonly-aviso';
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#334155;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.3);z-index:9999;opacity:0;transition:opacity .2s;';
    document.body.appendChild(el);
  }
  el.textContent = '👁 Usuário de consulta — somente leitura.';
  el.style.opacity = '1';
  clearTimeout(_avisoLeituraT);
  _avisoLeituraT = setTimeout(() => { el.style.opacity = '0'; }, 2600);
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
    el.title = `CEASA CONECTA — versão ${version}`;
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
