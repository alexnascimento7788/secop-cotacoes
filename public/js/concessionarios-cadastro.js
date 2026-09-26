// Concessionários Cadastro — dashboard + pesquisa + detalhe + relatório PDF,
// sobre o dado sincronizado do CeasaConecta-Gateway (ver secad-gateway-sync.js).

function toast(msg, tipo) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (tipo ? ' ' + tipo : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fecharModal(id) { document.getElementById(id).classList.remove('open'); }

// Ordem fixa de exibição das Unidades (as 5 filiais + o balde de fora) — mesma
// ordem em todo lugar que lista Unidade, pra não ficar embaralhando a cada
// carregamento (o back devolve um objeto, sem ordem garantida).
const ORDEM_UNIDADES_CC = ['Contagem', 'Uberlândia', 'Juiz de Fora', 'Barbacena', 'Caratinga', 'Fora das Unidades'];
let ccFiltros = { busca: '', unidade: '', ativo: '' };
let ccListaCarregada = false;

function init() {
  document.querySelectorAll('#cc-tabs .page-tab').forEach(t => {
    t.addEventListener('click', () => trocarCcTab(t.dataset.cctab));
  });
  document.getElementById('cc-filtro-unidade').addEventListener('change', e => { ccFiltros.unidade = e.target.value; carregarListaConcessionarios(); });
  document.getElementById('cc-filtro-ativo').addEventListener('change', e => { ccFiltros.ativo = e.target.value; carregarListaConcessionarios(); });
  document.getElementById('cc-busca').addEventListener('input', e => { ccFiltros.busca = e.target.value.trim(); carregarListaConcessionarios(); });
  carregarDashboardConcessionarios();
}

function trocarCcTab(tab) {
  document.querySelectorAll('#cc-tabs .page-tab').forEach(t => t.classList.toggle('active', t.dataset.cctab === tab));
  document.getElementById('pane-cc-dashboard').classList.toggle('active', tab === 'dashboard');
  document.getElementById('pane-cc-pesquisar').classList.toggle('active', tab === 'pesquisar');
  if (tab === 'pesquisar' && !ccListaCarregada) { ccListaCarregada = true; carregarListaConcessionarios(); }
}

function preencherSelectsUnidadeCc(unidadesPresentes) {
  const ordenadas = ORDEM_UNIDADES_CC.filter(u => unidadesPresentes.includes(u));
  const opts = ordenadas.map(u => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
  ['cc-filtro-unidade', 'cc-rel-unidade'].forEach(id => {
    const sel = document.getElementById(id);
    const atual = sel.value;
    sel.innerHTML = `<option value="">Todas as unidades</option>${opts}`;
    if (ordenadas.includes(atual)) sel.value = atual;
  });
}

async function carregarDashboardConcessionarios() {
  let d;
  try { d = await (await fetch('/api/concessionarios-cadastro/dashboard')).json(); } catch { return; }

  preencherSelectsUnidadeCc(Object.keys(d.por_unidade));

  document.getElementById('cc-cards').innerHTML = `
    <div class="metric-card metric-cotacao">
      <div class="metric-card-top"><span class="metric-icon">🏢</span><span class="metric-label">Total</span></div>
      <div class="metric-value metric-val-cotacao">${d.total}</div>
      <div class="metric-hint">concessionários cadastrados</div>
    </div>
    <div class="metric-card metric-concluido">
      <div class="metric-card-top"><span class="metric-icon">✅</span><span class="metric-label">Ativos</span></div>
      <div class="metric-value metric-val-concluido">${d.ativos}</div>
      <div class="metric-hint">com pelo menos 1 contrato ativo</div>
    </div>
    <div class="metric-card metric-parado">
      <div class="metric-card-top"><span class="metric-icon">⛔</span><span class="metric-label">Inativos</span></div>
      <div class="metric-value metric-val-parado">${d.inativos}</div>
      <div class="metric-hint">sem contrato ativo</div>
    </div>
    <div class="metric-card metric-aprovacao">
      <div class="metric-card-top"><span class="metric-icon">📄</span><span class="metric-label">Contratos</span></div>
      <div class="metric-value metric-val-aprovacao">${d.total_contratos}</div>
      <div class="metric-hint">${d.ativos_contrato_nulo} ativo(s) sem nº de contrato</div>
    </div>`;

  const max = Math.max(1, ...Object.values(d.por_unidade));
  const ordenadas = ORDEM_UNIDADES_CC.filter(u => d.por_unidade[u] != null);
  document.getElementById('cc-por-unidade').innerHTML = ordenadas.map(u => `
    <div class="dp-bar-row">
      <div class="dp-bar-city" title="${esc(u)}">${esc(u)}</div>
      <div class="dp-bar">
        <div class="dp-bar-track"><div class="dp-bar-fill contratos" style="width:${(d.por_unidade[u] / max) * 100}%"></div></div>
        <div class="dp-bar-val">${d.por_unidade[u]}</div>
      </div>
    </div>`).join('');
}

async function carregarListaConcessionarios() {
  const tbody = document.getElementById('cc-tbody');
  tbody.innerHTML = `<tr><td colspan="6" style="padding:16px;color:var(--text-muted);">Carregando...</td></tr>`;
  const params = new URLSearchParams();
  if (ccFiltros.busca) params.set('busca', ccFiltros.busca);
  if (ccFiltros.unidade) params.set('unidade', ccFiltros.unidade);
  if (ccFiltros.ativo) params.set('ativo', ccFiltros.ativo);
  let linhas;
  try { linhas = await (await fetch('/api/concessionarios-cadastro?' + params.toString())).json(); } catch { linhas = []; }

  if (!linhas.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:16px;color:var(--text-muted);">Nenhum concessionário encontrado.</td></tr>`;
    return;
  }
  tbody.innerHTML = linhas.map(l => `
    <tr class="cc-row" data-codigo="${l.codigo}" style="cursor:pointer;">
      <td><span class="badge ${l.ativo ? 'badge-concluido' : 'badge-parado'}">${l.ativo ? 'Ativo' : 'Inativo'}</span></td>
      <td>${esc(l.fantasia || l.nome || '—')}</td>
      <td>${esc(l.cnpj || '—')}</td>
      <td>${esc(l.unidade)}</td>
      <td>${esc(l.descricao_ramo || '—')}</td>
      <td>${esc(l.numero_contrato || '—')}</td>
    </tr>`).join('');
  tbody.querySelectorAll('.cc-row').forEach(tr => tr.addEventListener('click', () => abrirDetalheConcessionario(tr.dataset.codigo)));
}

async function abrirDetalheConcessionario(codigo) {
  let d;
  try {
    const res = await fetch(`/api/concessionarios-cadastro/${codigo}`);
    if (!res.ok) throw new Error();
    d = await res.json();
  } catch { toast('Erro ao carregar o concessionário.', 'error'); return; }

  document.getElementById('cc-det-titulo').textContent = d.principal.fantasia || d.principal.nome || `Concessionário ${codigo}`;
  const statusBadge = `<span class="badge ${d.ativo ? 'badge-concluido' : 'badge-parado'}">${d.ativo ? 'Ativo' : 'Inativo'}</span>`;
  document.getElementById('cc-det-corpo').innerHTML = `
    <div style="margin-bottom:14px;">${statusBadge} <span style="margin-left:8px;color:var(--text-muted);font-size:13px;">Unidade: ${esc(d.unidade)}</span></div>
    <div class="dp-field full"><label>Razão Social</label><span>${esc(d.principal.nome || '—')}</span></div>
    <div class="dp-field full"><label>Nome Fantasia</label><span>${esc(d.principal.fantasia || '—')}</span></div>
    <div class="dp-field full"><label>CNPJ</label><span>${esc(d.principal.cnpj || '—')}</span></div>
    <div class="dp-field full"><label>Inscrição Estadual</label><span>${esc(d.principal.ie || '—')}</span></div>
    <div class="dp-field full"><label>Ramo de Atividade</label><span>${esc(d.principal.descricao_ramo || '—')}</span></div>
    <div class="dp-field full"><label>Endereço</label><span>${esc(d.principal.endereco || '—')}${d.principal.numero ? ', ' + esc(d.principal.numero) : ''}${d.principal.bairro ? ' — ' + esc(d.principal.bairro) : ''}</span></div>
    <div class="dp-field full"><label>Cidade / CEP</label><span>${esc(d.principal.cidade || '—')}${d.principal.cep ? ' — ' + esc(d.principal.cep) : ''}</span></div>
    <div class="dp-field full"><label>Telefone</label><span>${esc(d.principal.telefone || '—')}</span></div>
    <h4 style="margin:18px 0 8px;">Contratos (${d.contratos.length})</h4>
    <div class="table-wrap"><table>
      <thead><tr><th>Status</th><th>Nº Contrato</th><th>Contrato Jurídico</th></tr></thead>
      <tbody>${d.contratos.map(c => `
        <tr>
          <td><span class="badge ${c.ativo === 1 ? 'badge-concluido' : 'badge-parado'}">${c.ativo === 1 ? 'Ativo' : 'Inativo'}</span></td>
          <td>${esc(c.numero_contrato || '—')}</td>
          <td>${esc(c.contrato_juridico || '—')}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
  document.getElementById('modal-cc-detalhe').classList.add('open');
}

function abrirModalRelatorioConcessionarios() {
  document.getElementById('cc-rel-unidade').value = ccFiltros.unidade || '';
  document.getElementById('cc-rel-ativo').value = ccFiltros.ativo || '';
  document.getElementById('modal-cc-relatorio').classList.add('open');
}

async function gerarRelatorioConcessionariosPdf() {
  const unidade = document.getElementById('cc-rel-unidade').value;
  const ativo = document.getElementById('cc-rel-ativo').value;
  const janela = window.open('', '_blank');
  try {
    const res = await fetch('/api/concessionarios-cadastro/relatorio/pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unidade, ativo })
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      toast(e.error || 'Falha ao gerar o relatório.', 'error');
      if (janela) janela.close();
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (janela && !janela.closed) janela.location.href = url;
    else window.open(url, '_blank');
    fecharModal('modal-cc-relatorio');
  } catch { toast('Falha ao gerar o relatório.', 'error'); if (janela) janela.close(); }
}

document.addEventListener('DOMContentLoaded', init);
