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

// DATETIME do SQLite ('YYYY-MM-DD HH:MM:SS', sem timezone) — mesmo padrão de
// exibição "como está gravado" que o resto do projeto usa pra esses campos
// (sem conversão de fuso), só que aqui mostrando também a hora.
function fmtDataHoraBr(iso) {
  if (!iso) return null;
  const [data, hora] = String(iso).split(/[T ]/);
  const d = (data || '').split('-');
  if (d.length < 3) return null;
  return `${d[2]}/${d[1]}/${d[0]}${hora ? ' às ' + hora.slice(0, 5) : ''}`;
}

// Ordem fixa de exibição das Unidades (as 7 unidades reais do CORPORE + o
// balde de fora) — mesma ordem em todo lugar que lista Unidade, pra não ficar
// embaralhando a cada carregamento (o back devolve um objeto, sem ordem
// garantida). Unidade agora vem pronta da API (ver routes/concessionarios-
// cadastro.js) — Governador Valadares e Uberaba entraram em 2026-09-28,
// antes viviam escondidas dentro de Caratinga/Uberlândia por uma heurística
// de cidade que não existe mais.
const ORDEM_UNIDADES_CC = ['Contagem', 'Uberlândia', 'Uberaba', 'Juiz de Fora', 'Barbacena', 'Caratinga', 'Governador Valadares', 'Fora das Unidades'];
let ccListaCarregada = false;
let _ccLinhas = []; // última lista carregada — usada pro detalhe abrir sem 2ª requisição

// Tipo de Cliente (2026-09-28): filtro de múltipla seleção (marca vários,
// clica OK, aí sim clica Filtrar) — modal compartilhado entre Pesquisar e
// Relatório, cada um com sua própria seleção guardada aqui.
let _ccTiposClienteDisponiveis = [];
let _ccTiposClienteSelPesquisar = [];
let _ccTiposClienteSelRelatorio = [];
let _ccTipoClienteContexto = 'pesquisar';

function init() {
  document.querySelectorAll('#cc-tabs .page-tab').forEach(t => {
    t.addEventListener('click', () => trocarCcTab(t.dataset.cctab));
  });
  // Fecha o modal clicando fora da caixa (no overlay), além do botão Fechar.
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', e => { if (e.target === ov) ov.classList.remove('open'); });
  });
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

// Ramo é filtro OPCIONAL (não agrupamento) só no Relatório — pedido do Alex.
function preencherSelectRamoCc(ramosDisponiveis) {
  const sel = document.getElementById('cc-rel-ramo');
  const atual = sel.value;
  sel.innerHTML = '<option value="">Todos os ramos</option>' + ramosDisponiveis.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
  if (ramosDisponiveis.includes(atual)) sel.value = atual;
}

async function carregarDashboardConcessionarios() {
  let d;
  try { d = await (await fetch('/api/concessionarios-cadastro/dashboard')).json(); } catch { return; }

  preencherSelectsUnidadeCc(Object.keys(d.por_unidade));
  preencherSelectRamoCc(d.ramos || []);
  _ccTiposClienteDisponiveis = d.tipos_cliente || [];
  renderSincronizacaoCc(d.sincronizacao);

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

function renderSincronizacaoCc(s) {
  const el = document.getElementById('cc-sync-info');
  if (!el || !s) return;
  const partes = [];
  if (s.ultima_sync) {
    partes.push(`<div><strong>Última sincronização:</strong> ${esc(fmtDataHoraBr(s.ultima_sync))} · ${Number(s.total || 0).toLocaleString('pt-BR')} registro(s) recebido(s) do Gateway, ${Number(s.gravados || 0).toLocaleString('pt-BR')} gravado(s).</div>`);
  } else {
    partes.push(`<div>Ainda não houve nenhuma sincronização bem-sucedida com o CeasaConecta-Gateway.</div>`);
  }
  if (s.status === 'erro') {
    const quando = s.ultima_tentativa ? ` (${esc(fmtDataHoraBr(s.ultima_tentativa))})` : '';
    partes.push(`<div style="margin-top:6px;color:#dc2626;">⚠️ A tentativa mais recente${quando} falhou: ${esc(s.erro || 'erro desconhecido')}.</div>`);
  }
  el.innerHTML = partes.join('');
}

// Filtro só roda quando o usuário clica em "Filtrar" (ou Enter na busca) —
// pedido do Alex: nada de refazer a consulta a cada tecla/troca de select.
async function carregarListaConcessionarios() {
  const tbody = document.getElementById('cc-tbody');
  tbody.innerHTML = `<tr><td colspan="7" style="padding:16px;color:var(--text-muted);">Carregando...</td></tr>`;
  const params = new URLSearchParams();
  const busca = document.getElementById('cc-busca').value.trim();
  const unidade = document.getElementById('cc-filtro-unidade').value;
  const ativo = document.getElementById('cc-filtro-ativo').value;
  const ocultarMl = document.getElementById('cc-filtro-ocultar-ml').checked;
  if (busca) params.set('busca', busca);
  if (unidade) params.set('unidade', unidade);
  if (ativo) params.set('ativo', ativo);
  if (ocultarMl) params.set('ocultar_ml', '1');
  if (_ccTiposClienteSelPesquisar.length) params.set('tipos_cliente', _ccTiposClienteSelPesquisar.join('|'));
  try { _ccLinhas = await (await fetch('/api/concessionarios-cadastro?' + params.toString())).json(); } catch { _ccLinhas = []; }

  if (!_ccLinhas.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:16px;color:var(--text-muted);">Nenhum concessionário encontrado.</td></tr>`;
    return;
  }
  tbody.innerHTML = _ccLinhas.map((l, i) => `
    <tr class="cc-row" data-i="${i}" style="cursor:pointer;">
      <td><span class="badge ${l.ativo ? 'badge-concluido' : 'badge-parado'}">${l.ativo ? 'Ativo' : 'Inativo'}</span></td>
      <td>${esc(l.fantasia || l.nome || '—')}</td>
      <td>${esc(l.cnpj || '—')}</td>
      <td>${esc(l.unidade)}</td>
      <td>${esc(l.descricao_ramo || '—')}</td>
      <td>${esc(l.tipo_cliente || '—')}</td>
      <td>${esc(l.numero_contrato || '—')}</td>
    </tr>`).join('');
  tbody.querySelectorAll('.cc-row').forEach(tr => tr.addEventListener('click', () => abrirDetalheConcessionario(_ccLinhas[tr.dataset.i])));
}

// Modal de múltipla seleção — abre com contexto ('pesquisar' ou 'relatorio')
// pra saber em qual estado gravar quando confirmar.
function abrirSeletorTipoCliente(contexto) {
  _ccTipoClienteContexto = contexto;
  const selecionados = contexto === 'pesquisar' ? _ccTiposClienteSelPesquisar : _ccTiposClienteSelRelatorio;
  const lista = document.getElementById('cc-tipocliente-lista');
  lista.innerHTML = _ccTiposClienteDisponiveis.map(t => `
    <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:400;">
      <input type="checkbox" value="${esc(t)}" ${selecionados.includes(t) ? 'checked' : ''} /> ${esc(t)}
    </label>`).join('') || '<div style="color:var(--text-muted);font-size:13px;">Nenhum tipo de cliente disponível.</div>';
  document.getElementById('modal-cc-tipocliente').classList.add('open');
}

function atualizarBotaoTipoCliente(id, selecionados) {
  document.getElementById(id).textContent = selecionados.length ? `Tipo de Cliente (${selecionados.length})` : 'Tipo de Cliente';
}

function confirmarSeletorTipoCliente() {
  const marcados = Array.from(document.querySelectorAll('#cc-tipocliente-lista input[type=checkbox]:checked')).map(cb => cb.value);
  if (_ccTipoClienteContexto === 'pesquisar') {
    _ccTiposClienteSelPesquisar = marcados;
    atualizarBotaoTipoCliente('cc-btn-tipo-cliente', marcados);
  } else {
    _ccTiposClienteSelRelatorio = marcados;
    atualizarBotaoTipoCliente('cc-rel-btn-tipo-cliente', marcados);
  }
  fecharModal('modal-cc-tipocliente');
}

// Mostra SÓ os dados da linha/contrato clicado — nada de outras linhas do
// mesmo concessionário (pedido do Alex, achava que estava misturando
// contrato de outra linha). Usa o objeto já carregado na lista, sem 2ª
// requisição — mais rápido e garante que é exatamente o que está na tela.
function abrirDetalheConcessionario(l) {
  document.getElementById('cc-det-titulo').textContent = l.fantasia || l.nome || `Concessionário ${l.codigo}`;
  const statusBadge = `<span class="badge ${l.ativo ? 'badge-concluido' : 'badge-parado'}">${l.ativo ? 'Ativo' : 'Inativo'}</span>`;
  document.getElementById('cc-det-corpo').innerHTML = `
    <div style="margin-bottom:14px;">${statusBadge} <span style="margin-left:8px;color:var(--text-muted);font-size:13px;">Unidade: ${esc(l.unidade)}</span></div>
    <div class="dp-field"><label>Razão Social</label><span>${esc(l.nome || '—')}</span></div>
    <div class="dp-field"><label>Nome Fantasia</label><span>${esc(l.fantasia || '—')}</span></div>
    <div class="dp-field"><label>CNPJ</label><span>${esc(l.cnpj || '—')}</span></div>
    <div class="dp-field"><label>Inscrição Estadual</label><span>${esc(l.ie || '—')}</span></div>
    <div class="dp-field"><label>Ramo de Atividade</label><span>${esc(l.descricao_ramo || '—')}</span></div>
    <div class="dp-field"><label>Tipo de Cliente</label><span>${esc(l.tipo_cliente || '—')}</span></div>
    <div class="dp-field"><label>Endereço</label><span>${esc(l.endereco || '—')}${l.numero ? ', ' + esc(l.numero) : ''}${l.bairro ? ' — ' + esc(l.bairro) : ''}</span></div>
    <div class="dp-field"><label>Cidade / CEP</label><span>${esc(l.cidade || '—')}${l.cep ? ' — ' + esc(l.cep) : ''}</span></div>
    <div class="dp-field"><label>Telefone</label><span>${esc(l.telefone || '—')}</span></div>
    <div class="dp-field"><label>Nº do Contrato</label><span>${esc(l.numero_contrato || '—')}</span></div>
    <div class="dp-field"><label>Contrato Jurídico</label><span>${esc(l.contrato_juridico || '—')}</span></div>`;
  document.getElementById('modal-cc-detalhe').classList.add('open');
}

function abrirModalRelatorioConcessionarios() {
  document.getElementById('cc-rel-unidade').value = document.getElementById('cc-filtro-unidade').value || '';
  document.getElementById('cc-rel-ativo').value = document.getElementById('cc-filtro-ativo').value || '';
  document.getElementById('cc-rel-ocultar-ml').checked = document.getElementById('cc-filtro-ocultar-ml').checked;
  _ccTiposClienteSelRelatorio = [..._ccTiposClienteSelPesquisar];
  atualizarBotaoTipoCliente('cc-rel-btn-tipo-cliente', _ccTiposClienteSelRelatorio);
  document.getElementById('modal-cc-relatorio').classList.add('open');
}

async function gerarRelatorioConcessionariosPdf() {
  const unidade = document.getElementById('cc-rel-unidade').value;
  const ativo = document.getElementById('cc-rel-ativo').value;
  const ramo = document.getElementById('cc-rel-ramo').value;
  const ocultar_ml = document.getElementById('cc-rel-ocultar-ml').checked ? '1' : '';
  const tipos_cliente = _ccTiposClienteSelRelatorio.join('|');
  const janela = window.open('', '_blank');
  try {
    const res = await fetch('/api/concessionarios-cadastro/relatorio/pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unidade, ativo, ramo, ocultar_ml, tipos_cliente })
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
