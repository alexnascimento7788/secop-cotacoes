// ── Página pública (sem login) do relatório de Adesão à Renovação ───────────
// Pedido do Alex, 2026-10-26: acesso por telefone + aparelho aprovado no
// Admin, em vez de login. Máquina de estado simples (novo/pendente/
// expirado-ou-rejeitado/aprovado) — reaproveita as funções de render JÁ
// PRONTAS de secad-relatorios.js (_relRenderDashboard, _relRenderTabelaUnificada,
// etc.), incluído via <script> na página — essa página NUNCA toca em
// secad.html nem nas rotas autenticadas, só consome o mesmo JSON/PDF por um
// caminho público novo (routes/secad-relatorios.js, seção "Acesso público").

const RELPUB_TOKEN_KEY = 'rel_pub_device_token';
let _relpubPollInterval = null;
let _relpubUltimoDados = null;
let _relpubTelWidget = null;

function relpubToken() {
  let token = localStorage.getItem(RELPUB_TOKEN_KEY);
  if (!token) {
    token = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(RELPUB_TOKEN_KEY, token);
  }
  return token;
}

function relpubMostrarTela(nome) {
  ['novo', 'pendente', 'reenviar', 'dashboard'].forEach(n => {
    document.getElementById(`relpub-tela-${n}`).classList.toggle('active', n === nome);
  });
  if (nome === 'pendente') {
    if (!_relpubPollInterval) _relpubPollInterval = setInterval(relpubVerificarAcesso, 20000);
  } else if (_relpubPollInterval) {
    clearInterval(_relpubPollInterval);
    _relpubPollInterval = null;
  }
}

async function relpubVerificarAcesso() {
  try {
    const res = await fetch(`/api/secad/relatorios/publico/dados?token=${encodeURIComponent(relpubToken())}`);
    if (res.ok) {
      const dados = await res.json();
      _relpubUltimoDados = dados;
      relpubMostrarTela('dashboard');
      _relRenderDashboard(dados);
      document.getElementById('rel-tabela-unificada').innerHTML = _relRenderTabelaUnificada(dados);
      return;
    }
    const r = await res.json().catch(() => ({}));
    if (r.state === 'pendente') { relpubMostrarTela('pendente'); return; }
    if (r.state === 'expirado') {
      document.getElementById('relpub-reenviar-msg').textContent =
        'Este aparelho ficou mais de 24h sem acesso e precisa de uma nova liberação.';
      relpubMostrarTela('reenviar');
      return;
    }
    if (r.state === 'rejeitado') {
      document.getElementById('relpub-reenviar-msg').textContent = 'O acesso deste aparelho não foi liberado.';
      relpubMostrarTela('reenviar');
      return;
    }
    // 'novo' (404) ou qualquer outro caso — mostra o formulário.
    relpubMostrarTela('novo');
  } catch {
    relpubMostrarTela('novo');
  }
}

async function relpubEnviarSolicitacao() {
  const msg = document.getElementById('relpub-novo-msg');
  msg.textContent = '';
  const nome = document.getElementById('relpub-nome').value.trim();
  const telefone = document.getElementById('relpub-telefone').value.trim();
  if (!nome) { msg.textContent = 'Informe seu nome.'; return; }
  if (!telefone) { msg.textContent = 'Informe seu telefone.'; return; }
  const telefone_ddd = _relpubTelWidget ? _relpubTelWidget.getDDD() : null;
  try {
    const res = await fetch('/api/secad/relatorios/publico/solicitar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: relpubToken(), nome, telefone, telefone_ddd }),
    });
    if (!res.ok) { msg.textContent = 'Erro ao enviar a solicitação.'; return; }
    relpubMostrarTela('pendente');
  } catch {
    msg.textContent = 'Erro ao enviar a solicitação.';
  }
}

async function relpubSolicitarNovamente() {
  try {
    await fetch('/api/secad/relatorios/publico/solicitar-novamente', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: relpubToken() }),
    });
  } catch {}
  relpubMostrarTela('pendente');
}

function relpubBaixarPdf() {
  window.open(`/api/secad/relatorios/publico/pdf?token=${encodeURIComponent(relpubToken())}`, '_blank');
}

// Mesmo fragmento/lógica de _injetarRodape (auth.js) — copiado aqui de
// propósito: essa página nunca inclui auth.js (ele redireciona pra login se
// não houver sessão, o que quebraria o acesso público).
async function relpubInjetarRodape() {
  const el = document.getElementById('app-footer');
  if (!el) return;
  try {
    const html = await (await fetch('/components/footer.html')).text();
    el.innerHTML = html;
    const anoEl = el.querySelector('#footer-ano');
    if (anoEl) anoEl.textContent = new Date().getFullYear();
    const versaoEl = el.querySelector('#footer-versao');
    if (versaoEl) {
      const r = await fetch('/api/version');
      if (r.ok) { const { version } = await r.json(); versaoEl.textContent = `CEASA CONECTA · v${version}`; }
    }
  } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
  _relpubTelWidget = iniciarTelefoneBR(document.getElementById('relpub-telefone'));
  document.getElementById('rel-filtro-data-tabela').addEventListener('change', () => {
    if (_relpubUltimoDados) document.getElementById('rel-tabela-unificada').innerHTML = _relRenderTabelaUnificada(_relpubUltimoDados);
  });
  relpubInjetarRodape();
  relpubVerificarAcesso();
});
