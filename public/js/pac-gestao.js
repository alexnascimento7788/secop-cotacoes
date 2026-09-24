// PAC — Gestão (DEPLA): setores, parâmetros, DFDs e pedidos de edição.

function toast(msg, tipo) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (tipo ? ' ' + tipo : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
}

function badgeStatusDfd(status) {
  const map = { aberto: 'Aberto', analise: 'Em análise', em_consolidacao: 'Em consolidação', consolidado: 'Consolidado', fechado: 'Fechado', cancelado: 'Cancelado' };
  return `<span class="badge badge-${status}">${map[status] || status}</span>`;
}

/* ── Campo de texto longo expansível (pedido do Alex, 2026-09-24) — ver
   comentário completo em pac-lancamento.js. Duplicado aqui, mesma
   convenção do resto do módulo. */
let _campoExpandidoOrigin = null;
function abrirCampoExpandido(el, titulo) {
  _campoExpandidoOrigin = el;
  document.getElementById('campo-expandido-titulo').textContent = titulo || 'Editar';
  document.getElementById('campo-expandido-textarea').value = el.value;
  document.getElementById('modal-campo-expandido').classList.add('open');
  setTimeout(() => document.getElementById('campo-expandido-textarea').focus(), 50);
}
function fecharCampoExpandido() {
  document.getElementById('modal-campo-expandido').classList.remove('open');
  _campoExpandidoOrigin = null;
}
function salvarCampoExpandido() {
  if (_campoExpandidoOrigin) {
    _campoExpandidoOrigin.value = document.getElementById('campo-expandido-textarea').value;
    _campoExpandidoOrigin.dispatchEvent(new Event('input', { bubbles: true }));
    _campoExpandidoOrigin.dispatchEvent(new Event('change', { bubbles: true }));
    _campoExpandidoOrigin.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  fecharCampoExpandido();
}

// Ordem de prioridade da aba "DFDs" — pedido do Alex, 2026-09-24: quem
// precisa de ação (aberto/análise) primeiro, seguindo o fluxo natural do
// pipeline; "cancelado" vai por último por não fazer mais parte dele.
const ORDEM_STATUS_DFD = { aberto: 0, analise: 1, em_consolidacao: 2, consolidado: 3, fechado: 4, cancelado: 5 };
function ordenarDfdsPorStatus(lista) {
  return [...lista].sort((a, b) =>
    (ORDEM_STATUS_DFD[a.status] ?? 99) - (ORDEM_STATUS_DFD[b.status] ?? 99) ||
    b.ano_base - a.ano_base || b.id - a.id);
}

const ABAS_PAC_VALIDAS = new Set(['acompanhamento', 'consolidacao', 'dfds', 'solicitacoes', 'setores', 'parametros', 'orcamentos', 'pedidos']);

document.addEventListener('DOMContentLoaded', async () => {
  // Navegação agora mora na sidebar (galho "Gestão" em árvore, ver
  // pac-gestao.html) — os links de aba (<a data-tab>) apontam pra
  // "pac-gestao.html#aba" (funciona vindo de fora, ex.: Lançamento) e, como
  // já estamos NESTA página, interceptamos o clique pra trocar de aba sem
  // recarregar (só ajusta o hash via replaceState, sem disparar hashchange).
  document.querySelectorAll('#nav-gestao-galho [data-tab]').forEach(t => t.addEventListener('click', e => {
    e.preventDefault();
    mudarAbaPac(t.dataset.tab);
  }));
  // Voltar/avançar do navegador (ou colar um link com #aba) troca de aba também.
  window.addEventListener('hashchange', () => mudarAbaPac(abaDoHash()));

  await carregarDfds();
  carregarSetores();
  popularSelectListas();
  carregarPedidos();
  aplicarPermissaoSolicitacoes();
  aplicarAcessoImportacao();
  await popularSelectDfdsExecucao();
  // Acompanhamento/Consolidação são as abas operacionais (menu em árvore,
  // ver item 2 do prompt) — landing page da Gestão, em vez de DFDs (que virou
  // uma sub-aba administrativa, dentro do galho "Administração"). Se a URL
  // já veio com um #hash (ex.: link direto de outra página), respeita ele.
  mudarAbaPac(abaDoHash());
});

function abaDoHash() {
  const aba = location.hash.replace('#', '');
  return ABAS_PAC_VALIDAS.has(aba) ? aba : 'acompanhamento';
}

function mudarAbaPac(aba) {
  if (!ABAS_PAC_VALIDAS.has(aba)) aba = 'acompanhamento';
  history.replaceState(null, '', `#${aba}`);
  document.querySelectorAll('#nav-gestao-galho [data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === aba));
  document.querySelectorAll('.pac-pane').forEach(p => p.classList.toggle('active', p.id === `pane-${aba}`));
  if (aba === 'setores') carregarSetores();
  if (aba === 'parametros') carregarParametros();
  if (aba === 'orcamentos') carregarOrcamentosLista();
  if (aba === 'pedidos') carregarPedidos();
  if (aba === 'consolidacao') carregarConsolidacaoLista();
  if (aba === 'solicitacoes') carregarSolicitacoes();
  if (aba === 'acompanhamento') mostrarListaAcompanhamento();
  // Bug real achado pelo Alex, 2026-09-15: clicar em "DFDs" na sidebar não
  // resetava pra lista — se a última visita tinha ficado no detalhe de um
  // DFD (ex.: chegou lá por engano vindo de Consolidação), continuava preso
  // lá, parecendo uma "página antiga" que só uma volta+ida a outra aba
  // corrigia. Todas as outras abas já resetam pro estado inicial delas
  // (consolidacao/acompanhamento acima) — "dfds" era a única exceção.
  if (aba === 'dfds') fecharDetalheDfd();
}

// Atalho "ir direto pro DFD X" (aba de administração — Enviar p/
// análise/Fechar/Reabrir/Cancelar). mudarAbaPac troca a aba visível ANTES de
// abrir o detalhe, senão #pac-dfd-detalhe fica escondido dentro de uma pane
// inativa.
function irParaDfd(id) {
  mudarAbaPac('dfds');
  abrirDetalheDfd(id);
}

// Atalho pro PRÓXIMO PASSO do fluxo (Acompanhamento/"Gerar Consolidação") —
// usado pelo botão do DFD em análise/aberto e pela lista "Não consolidados"
// de Consolidação (pedido do Alex, 2026-09-15: clicar num DFD em análise ali
// caía por engano na tela de administração do DFD, sem porta pra iniciar a
// consolidação). Pula a lista de entrada de Acompanhamento (o DFD já está
// escolhido) e vai direto pro detalhe, onde mora o botão "Gerar Consolidação".
function irIniciarConsolidacao(id) {
  mudarAbaPac('acompanhamento');
  abrirAcompanhamentoDoDfd(id);
}

// Botão "📊 Acompanhamento"/"🧾 Ir para Consolidação" dentro do DFD aberto —
// mesmo destino de irIniciarConsolidacao, só que a partir do DFD já aberto
// nesta página (usa o _dfdAtualId local em vez de receber por parâmetro).
function irParaAcompanhamentoDoDfd() {
  irIniciarConsolidacao(_dfdAtualId);
}

// Porta de entrada de Acompanhamento — pedido do Alex, 2026-09-15: lista
// de DFDs "abertos" com colunas informativas, clicar entra no detalhe (em
// vez de cair direto numa tabela com um <select> escondido num filtro).
async function mostrarListaAcompanhamento() {
  document.getElementById('acomp-lista').style.display = 'block';
  document.getElementById('acomp-detalhe').style.display = 'none';
  pararAutoRefreshAcompanhamento();
  if (!_dfds.length) await carregarDfds();
  const tbody = document.getElementById('acomp-lista-tbody');
  const abertos = _dfds.filter(d => d.status === 'aberto');
  if (!abertos.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum DFD em lançamento no momento.</td></tr>`;
    return;
  }
  tbody.innerHTML = `<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--text-subtle);">Carregando...</td></tr>`;
  const linhas = await Promise.all(abertos.map(async d => {
    const res = await fetch(`/api/pac/dfds/${d.id}/status-finalizacao`);
    const status = res.ok ? await res.json() : { setores: [] };
    const total = status.setores.length;
    const finalizados = status.setores.filter(s => s.finalizado_em).length;
    return `
      <tr>
        <td><strong>${codigoDfd(d)}</strong></td>
        <td>${d.titulo}</td>
        <td>${d.ano_base}</td>
        <td>${d.data_encerramento ? fmtBrData(d.data_encerramento) : 'não informado'}</td>
        <td>${total ? `${finalizados} de ${total}` : '—'}</td>
        <td>${d.itens_count ?? 0}</td>
        <td style="text-align:right;"><button class="btn btn-primary btn-sm" onclick="abrirAcompanhamentoDoDfd(${d.id})">Abrir →</button></td>
      </tr>`;
  }));
  tbody.innerHTML = linhas.join('');
}

function abrirAcompanhamentoDoDfd(id) {
  document.getElementById('acomp-lista').style.display = 'none';
  document.getElementById('acomp-detalhe').style.display = 'block';
  document.getElementById('acomp-dfd-select').value = id;
  carregarAcompanhamento();
}

// 'pac-solicitacoes' é rotina própria (independente de 'pac-gestao') — quem
// abre esta página (já tem "ver" em pac-gestao) pode não ter acesso à aba de
// Solicitações. O servidor já barra (403) qualquer chamada sem essa rotina;
// aqui só escondemos a aba pra não oferecer algo que vai falhar na certa.
async function aplicarPermissaoSolicitacoes() {
  try {
    const r = await fetch('/api/auth/rotinas');
    if (!r.ok) return;
    const { rotinas } = await r.json();
    const sol = (rotinas || []).find(x => x.slug === 'pac-solicitacoes');
    if (!sol || !sol.ver) document.querySelector('#pac-tabs [data-tab="solicitacoes"]')?.remove();
  } catch {}
}

// Link "Importação" da sidebar — acesso é só por role (master/admin_sistema),
// não Perfil/Rotina (ver routes/pac-importacao.js), então essa checagem é à
// parte de aplicarPermissaoSolicitacoes() acima.
async function aplicarAcessoImportacao() {
  try {
    const user = await window.getCurrentUser();
    if (user && (user.username === 'master' || user.role === 'admin_sistema')) {
      document.getElementById('nav-pac-importacao').style.display = '';
    }
  } catch {}
}

/* ── DFDs ─────────────────────────────────────────────────────────────────── */

let _dfds = [];

// Código estável do DFD (nunca some/reaparece com outro dono) — pedido do
// Alex, 2026-09-06: testando com vários DFDs criados/apagados, sem número
// nenhum na tela ficava difícil saber qual é qual. Deriva de `id`
// (AUTOINCREMENT de verdade — SQLite nunca reusa esse número, mesmo depois
// de excluir uma linha) + ano_base; não é coluna nova no banco, é só
// formatação (sempre reproduzível a partir do que já existe).
function codigoDfd(d) {
  return `DFD-${String(d.id).padStart(3, '0')}-${d.ano_base}`;
}

async function carregarDfds() {
  try {
    const res = await fetch('/api/pac/dfds');
    _dfds = res.ok ? await res.json() : [];
    document.getElementById('dfds-tbody').innerHTML = ordenarDfdsPorStatus(_dfds).map(d => `
      <tr>
        <td><strong>${codigoDfd(d)}</strong></td>
        <td>${d.titulo}</td>
        <td>${d.ano_base}</td>
        <td>${badgeStatusDfd(d.status)}</td>
        <td style="text-align:right;"><button class="btn btn-secondary btn-sm" onclick="abrirDetalheDfd(${d.id})">Abrir</button></td>
      </tr>
    `).join('') || `<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum DFD criado ainda.</td></tr>`;
  } catch {
    toast('Erro ao carregar DFDs', 'error');
  }
}

async function criarDfd() {
  const titulo = document.getElementById('new-dfd-titulo').value.trim();
  const ano_base = parseInt(document.getElementById('new-dfd-ano').value, 10);
  const descricao = document.getElementById('new-dfd-descricao').value.trim();
  const data_entrega = document.getElementById('new-dfd-data-entrega').value; // <input type=date> já entrega AAAA-MM-DD
  const data_encerramento = document.getElementById('new-dfd-data-encerramento').value;
  const msg = document.getElementById('dfd-msg');
  msg.style.color = '';
  if (!titulo || !ano_base) { msg.style.color = '#c00'; msg.textContent = 'Informe título e ano base.'; return; }
  // Obrigatória (pedido do Alex, 2026-09-07) — checada aqui pra não depender
  // só do servidor, mas o servidor também recusa (ver POST /api/pac/dfds).
  if (!data_entrega) { msg.style.color = '#c00'; msg.textContent = 'Informe a data de vencimento (entrega).'; return; }
  // Data de encerramento (pedido do Alex, 2026-09-22) — data MÁXIMA pro
  // DEPLA fechar o DFD, separada da vencimento (que é do setor).
  if (!data_encerramento) { msg.style.color = '#c00'; msg.textContent = 'Informe a data de encerramento.'; return; }
  try {
    const res = await fetch('/api/pac/dfds', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titulo, ano_base, descricao, data_entrega, data_encerramento }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    msg.style.color = '#2E7D32';
    msg.textContent = `DFD "${titulo}" criado.`;
    document.getElementById('new-dfd-titulo').value = '';
    document.getElementById('new-dfd-ano').value = '';
    document.getElementById('new-dfd-descricao').value = '';
    document.getElementById('new-dfd-data-entrega').value = '';
    document.getElementById('new-dfd-data-encerramento').value = '';
    carregarDfds();
  } catch (e) {
    msg.style.color = '#c00'; msg.textContent = 'Erro: ' + e.message;
  }
}

let _dfdAtualId = null;

async function abrirDetalheDfd(id) {
  _dfdAtualId = id;
  document.getElementById('pac-dfd-lista').style.display = 'none';
  document.getElementById('pac-dfd-detalhe').style.display = 'block';
  await carregarDetalheDfd();
}

function fecharDetalheDfd() {
  _dfdAtualId = null;
  document.getElementById('pac-dfd-detalhe').style.display = 'none';
  document.getElementById('pac-dfd-lista').style.display = 'block';
  carregarDfds();
}

// Guardado à parte pro botão "📊 Orçamento" (ver abrirEscolhaOrcamentoDfd)
// decidir se deixa clicar sem precisar refazer o fetch.
let _dfdAtualOrcamentoId = null;

async function carregarDetalheDfd() {
  const res = await fetch(`/api/pac/dfds/${_dfdAtualId}`);
  if (!res.ok) { toast('Erro ao carregar DFD', 'error'); return; }
  const dfd = await res.json();
  _dfdAtualOrcamentoId = dfd.orcamento_id || null;
  document.getElementById('dfd-det-titulo').textContent = `${codigoDfd(dfd)} — ${dfd.titulo}`;
  const badge = document.getElementById('dfd-det-badge');
  const map = { aberto: 'Aberto', analise: 'Em análise', em_consolidacao: 'Em consolidação', consolidado: 'Consolidado', fechado: 'Fechado' };
  badge.className = `badge badge-${dfd.status}`;
  badge.textContent = map[dfd.status] || dfd.status;
  // Data de vencimento (entrega) do DFD — pedido do Alex, 2026-09-07, com
  // "destaque inteligente" (cor de farol) desde 2026-09-17, mesmo padrão de
  // badgeVencimento() em pac-lancamento.js.
  document.getElementById('dfd-det-vencimento').innerHTML = badgeVencimento(dfd.data_entrega);
  document.getElementById('dfd-det-encerramento').innerHTML = badgeEncerramento(dfd.data_encerramento);

  fecharAcaoDfd();
  // Botão de atalho pro próximo passo do fluxo — pedido do Alex, 2026-09-15:
  // "se tenho um [DFD] que está em análise ele pode me levar para o mesmo já
  // em Consolidação". "Aberto" ainda usa a MESMA tela (Acompanhamento) só
  // que pra ver progresso; "análise" cai no mesmo lugar, mas é lá que mora o
  // botão "Gerar Consolidação" (ver renderFinalizacaoAcompanhamento) — daí o
  // rótulo mudar conforme o status, mesmo destino (irParaAcompanhamentoDoDfd).
  const btnAcomp = document.getElementById('dfd-det-btn-acomp');
  if (dfd.status === 'aberto') {
    btnAcomp.style.display = '';
    btnAcomp.textContent = '📊 Acompanhamento';
  } else if (dfd.status === 'analise') {
    btnAcomp.style.display = '';
    btnAcomp.textContent = '🧾 Ir para Consolidação';
  } else {
    btnAcomp.style.display = 'none';
  }
  const acoes = document.getElementById('dfd-det-acoes');
  // Transições válidas (pedido do Alex, 2026-09-15, 2ª volta): fluxo completo
  // é aberto→análise→em_consolidacao→consolidado→fechado. "Iniciar
  // Consolidação" (análise→em_consolidacao) mora em Acompanhamento, não
  // aqui (ver gerarConsolidacao) — nesse meio-tempo as colunas originais do
  // lançamento ficam liberadas pro DEPLA editar em Consolidação. Os 2
  // últimos degraus SÃO neste painel: "Finalizar Consolidação"
  // (em_consolidacao→consolidado, trava as colunas de novo) e "Fechar DFD"
  // (consolidado→fechado). "Fechado" só volta por "Reabrir".
  const opcoes = { aberto: ['analise', 'cancelado'], analise: ['aberto'], em_consolidacao: ['consolidado'], consolidado: ['fechado', 'aberto'], fechado: ['aberto'], cancelado: [] };
  const rotulos = { aberto: '🔓 Reabrir DFD', analise: '📨 Enviar para análise', consolidado: '✅ Finalizar Consolidação', fechado: '🔒 Fechar DFD', cancelado: '🚫 Cancelar DFD' };
  acoes.innerHTML = (opcoes[dfd.status] || []).map(s =>
    `<button class="btn btn-secondary btn-sm" onclick="abrirAcaoDfd('${s}')">${rotulos[s]}</button>`
  ).join(' ');

  const itens = await renderItensDfd(dfd.colunas);
  await renderMensagemStatusDfd(dfd, itens.length > 0);
}

// "Recado" do cabeçalho — muda conforme o que está de fato acontecendo com o
// DFD (pedido do Alex, 2026-09-16: "precisa melhorar e caminhar conforme o
// que está ocorrendo"), não só um texto fixo de vencimento. dias vem de
// data_entrega (mesma lógica de prazo já usada em Lançamento, duplicada aqui
// — mesma convenção do resto do arquivo, sem módulo compartilhado novo).
function diasRestantesPac(dataIso) {
  if (!dataIso) return null;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const alvo = new Date(String(dataIso).split(/[T ]/)[0] + 'T00:00:00');
  return Math.round((alvo - hoje) / 86400000);
}
// "Destaque inteligente" no Vencimento (cor de farol) — pedido do Alex,
// 2026-09-17, mesmo padrão de badgeVencimento() em pac-lancamento.js.
function badgeVencimento(dataIso) {
  if (!dataIso) return `<span class="badge badge-fechado">Vencimento: não informado</span>`;
  const dias = diasRestantesPac(dataIso);
  const classe = dias < 0 ? 'badge-parado' : dias <= 5 ? 'badge-aprovacao' : 'badge-concluido';
  return `<span class="badge ${classe}">Vencimento: ${fmtBrData(dataIso)}</span>`;
}
// Data de encerramento (pedido do Alex, 2026-09-22) — data MÁXIMA pro DEPLA
// fechar o DFD, mostrada ao lado do vencimento (que é do setor). Mesmo
// padrão visual de badgeVencimento, só trocando o rótulo/dado.
function badgeEncerramento(dataIso) {
  if (!dataIso) return `<span class="badge badge-fechado">Encerramento: não informado</span>`;
  const dias = diasRestantesPac(dataIso);
  const classe = dias < 0 ? 'badge-parado' : dias <= 5 ? 'badge-aprovacao' : 'badge-concluido';
  return `<span class="badge ${classe}">Encerramento: ${fmtBrData(dataIso)}</span>`;
}
function mensagemStatusDfd({ status, temItens, todosFinalizados, dias }) {
  const prazoTxto = dias == null ? '' : dias > 0 ? ` Restam ${dias} dia(s) para o prazo.` : dias === 0 ? ' O prazo termina hoje!' : ` O prazo já venceu há ${-dias} dia(s).`;
  if (status === 'cancelado') return { texto: 'Este DFD foi cancelado.', tom: 'muted' };
  if (status === 'fechado') return { texto: 'Este DFD está fechado — processo concluído.', tom: 'success' };
  if (status === 'consolidado') return { texto: 'Consolidação finalizada — aguardando o fechamento do DFD pelo DEPLA.', tom: 'info' };
  if (status === 'em_consolidacao') return { texto: 'Em consolidação — os itens estão sendo trabalhados pelo DEPLA em Gestão > Consolidação.', tom: 'info' };
  if (status === 'analise') return { texto: 'Enviado para análise do DEPLA. Precisa alterar algo depois de enviado? É possível solicitar um pedido de edição.', tom: 'warning' };
  // status === 'aberto'
  if (!temItens) return { texto: `Este DFD está aberto e ainda não há nenhum item lançado.${prazoTxto}`, tom: 'warning' };
  if (!todosFinalizados) return { texto: `Lançamento em andamento — ainda falta algum setor finalizar.${prazoTxto}`, tom: 'info' };
  return { texto: `Todos os setores finalizaram o lançamento — pronto para seguir ao próximo passo (enviar para análise).${prazoTxto}`, tom: 'success' };
}
async function renderMensagemStatusDfd(dfd, temItens) {
  const el = document.getElementById('dfd-det-msg-status');
  if (!el) return;
  let todosFinalizados = false;
  try {
    const res = await fetch(`/api/pac/dfds/${dfd.id}/status-finalizacao`);
    if (res.ok) { const s = await res.json(); todosFinalizados = !!s.todos_finalizados; }
  } catch {}
  const dias = diasRestantesPac(dfd.data_entrega);
  const { texto, tom } = mensagemStatusDfd({ status: dfd.status, temItens, todosFinalizados, dias });
  el.textContent = texto;
  el.className = `pac-dfd-msg-status tom-${tom}`;
}

const _explicacaoAcaoDfd = {
  analise: 'Envia este DFD para análise do DEPLA. Só é possível quando nenhum item tiver campo obrigatório em branco (não depende mais de "Finalizar meu DFD" por setor). A partir daqui, os setores não podem mais editar itens sem um pedido de edição aprovado.',
  consolidado: 'Finaliza a etapa de consolidação. Só é possível quando TODOS os itens (de todos os setores) já estiverem com status "Consolidação finalizada" ou "Cancelado" em Gestão > Consolidação. A partir daqui, as colunas originais do lançamento voltam a ficar bloqueadas pro DEPLA, e o DFD pode ser fechado.',
  fechado: 'Fecha este DFD definitivamente. Só é possível com o DFD já "Consolidado". Depois de fechado, o DFD vira somente leitura e todos os setores participantes recebem um aviso por e-mail, com o nome de quem fechou.',
  aberto: 'Reabre este DFD para edição — use apenas em situação excepcional. Reabrir NÃO desfaz numeração ou consolidação já feita, só destrava a escrita novamente. Por segurança, exige a senha mestra do PAC (definida em Administração → Configurações → Parâmetros).',
  cancelado: 'Cancela este DFD por completo — só possível enquanto ele ainda está "Aberto" (sem trabalho de consolidação em cima). Ação irreversível. Explique o motivo do cancelamento.',
};
let _acaoDfdAlvo = null;

function abrirAcaoDfd(statusAlvo) {
  _acaoDfdAlvo = statusAlvo;
  document.getElementById('dfd-acao-titulo').textContent =
    { analise: 'Enviar para análise', consolidado: 'Finalizar Consolidação', fechado: 'Fechar DFD', aberto: 'Reabrir DFD', cancelado: 'Cancelar DFD' }[statusAlvo];
  document.getElementById('dfd-acao-explicacao').textContent = _explicacaoAcaoDfd[statusAlvo] || '';
  document.getElementById('dfd-acao-senha-wrap').style.display = statusAlvo === 'aberto' ? 'block' : 'none';
  document.getElementById('dfd-acao-justificativa-wrap').style.display = statusAlvo === 'cancelado' ? 'block' : 'none';
  document.getElementById('dfd-acao-senha').value = '';
  document.getElementById('dfd-acao-justificativa').value = '';
  document.getElementById('dfd-acao-msg').textContent = '';
  document.getElementById('dfd-det-acao-painel').style.display = 'block';
  document.getElementById('dfd-det-acao-painel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function fecharAcaoDfd() {
  _acaoDfdAlvo = null;
  const painel = document.getElementById('dfd-det-acao-painel');
  if (painel) painel.style.display = 'none';
}

async function executarAcaoDfd() {
  if (!_acaoDfdAlvo) return;
  if (_acaoDfdAlvo === 'cancelado' && !document.getElementById('dfd-acao-justificativa').value.trim()) {
    document.getElementById('dfd-acao-msg').textContent = 'Explique o motivo do cancelamento.';
    return;
  }
  const senha = document.getElementById('dfd-acao-senha').value;
  const justificativa = document.getElementById('dfd-acao-justificativa').value;
  await mudarStatusDfd(_acaoDfdAlvo, senha, justificativa);
}

// "Setores participantes"/"Colunas ativas" são configuração pontual do DFD,
// não algo que se consulta toda vez que se abre a tela — ficam isoladas num
// modal à parte (Alex: "esta aba está errada... configurações devem ficar
// isolados"), carregadas só quando o modal realmente abre.
function abrirConfigDfd() {
  document.getElementById('modal-dfd-config').classList.add('open');
  renderOrcamentoSelectDfd();
  renderGridSetoresDfd();
  renderGridUnidadesDfd();
  renderGridColunasDfd();
}

// Orçamento do DFD — obrigatório antes de "Iniciar Consolidação" (pedido do
// Alex, 2026-09-24). Fica aqui (Configurações), não na criação do DFD.
async function renderOrcamentoSelectDfd() {
  const sel = document.getElementById('dfd-det-orcamento-select');
  try {
    const [orcRes, dfdRes] = await Promise.all([
      fetch('/api/pac/orcamentos'),
      fetch(`/api/pac/dfds/${_dfdAtualId}`),
    ]);
    const orcamentos = orcRes.ok ? await orcRes.json() : [];
    const dfd = dfdRes.ok ? await dfdRes.json() : {};
    // Mostra orçamentos ativos + o já atribuído (mesmo se tiver sido
    // desativado depois) — não some da tela por causa de uma desativação.
    const opcoes = orcamentos.filter(o => o.ativo || o.id === dfd.orcamento_id);
    sel.innerHTML = '<option value="">— nenhum —</option>' +
      opcoes.map(o => `<option value="${o.id}"${o.id === dfd.orcamento_id ? ' selected' : ''}>${o.nome}</option>`).join('');
  } catch {
    sel.innerHTML = '<option value="">Erro ao carregar</option>';
  }
}

async function salvarOrcamentoDfd() {
  const valor = document.getElementById('dfd-det-orcamento-select').value;
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orcamento_id: valor ? Number(valor) : null }),
    });
    if (!res.ok) throw new Error();
    _dfdAtualOrcamentoId = valor ? Number(valor) : null;
    toast('Orçamento do DFD atualizado.');
  } catch {
    toast('Erro ao salvar orçamento do DFD', 'error');
  }
}

function fecharConfigDfd() {
  document.getElementById('modal-dfd-config').classList.remove('open');
}

async function mudarStatusDfd(status, senha_mestra, justificativa) {
  const msg = document.getElementById('dfd-acao-msg');
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, senha_mestra, justificativa }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (msg) msg.textContent = data.error || 'Erro ao mudar status do DFD.'; else toast(data.error || 'Erro ao mudar status do DFD', 'error');
      return;
    }
    toast('Status atualizado', 'success');
    // Sem isso, o `_dfds` global (usado por Consolidação/Acompanhamento)
    // ficava com o status velho até um F5 — pedido do Alex, 2026-09-15: "o
    // dfd está demorando aparecer em consolidação, precisa ficar repetindo
    // refresh". carregarDetalheDfd() só atualiza ESTA tela, não o cache.
    await carregarDfds();
    carregarDetalheDfd();
  } catch {
    if (msg) msg.textContent = 'Erro ao mudar status do DFD.'; else toast('Erro ao mudar status do DFD', 'error');
  }
}

async function renderGridSetoresDfd() {
  const wrap = document.getElementById('dfd-det-setores');
  const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/setores`);
  const setores = res.ok ? await res.json() : [];
  wrap.innerHTML = `
    <table>
      <tbody>
        ${setores.map(s => `
          <tr>
            <td style="width:32px;"><input type="checkbox" ${s.ativo ? 'checked' : ''} onchange="toggleSetorDoDfd(${s.id}, this.checked)"></td>
            <td>${s.nome}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function toggleSetorDoDfd(setorId, ativo) {
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/setores`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setor_id: setorId, ativo }),
    });
    if (!res.ok) throw new Error();
  } catch {
    toast('Erro ao atualizar setor do DFD', 'error');
    renderGridSetoresDfd();
  }
}

// Unidades participantes do DFD — espelha renderGridSetoresDfd/toggleSetorDoDfd acima.
async function renderGridUnidadesDfd() {
  const wrap = document.getElementById('dfd-det-unidades');
  const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/unidades`);
  const unidades = res.ok ? await res.json() : [];
  wrap.innerHTML = `
    <table>
      <tbody>
        ${unidades.map(u => `
          <tr>
            <td style="width:32px;"><input type="checkbox" ${u.ativo ? 'checked' : ''} onchange="toggleUnidadeDoDfd(${u.id}, this.checked)"></td>
            <td>${u.nome}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function toggleUnidadeDoDfd(unidadeId, ativo) {
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/unidades`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unidade_id: unidadeId, ativo }),
    });
    if (!res.ok) throw new Error();
  } catch {
    toast('Erro ao atualizar unidade do DFD', 'error');
    renderGridUnidadesDfd();
  }
}

async function renderGridColunasDfd() {
  const wrap = document.getElementById('dfd-det-colunas');
  const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/colunas`);
  const colunas = res.ok ? await res.json() : [];
  wrap.innerHTML = `
    <table>
      <tbody>
        ${colunas.map(c => `
          <tr>
            <td style="width:32px;"><input type="checkbox" ${c.ativa ? 'checked' : ''} ${c.slug === 'numero_item' ? 'disabled' : ''} onchange="toggleColunaDoDfd(${c.id}, this.checked)"></td>
            <td>${c.label} <span class="text-muted" style="font-size:11px;">(${c.grupo})</span></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function toggleColunaDoDfd(colunaId, ativa) {
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/colunas`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coluna_id: colunaId, ativa }),
    });
    if (!res.ok) throw new Error();
    renderItensDfd();
  } catch {
    toast('Erro ao atualizar coluna do DFD', 'error');
    renderGridColunasDfd();
  }
}

// Leitura simples (o perfil "Analista DEPLA" só tem "ver" em pac-lancamento —
// quem edita item é o gestor do setor, na tela de Lançamento). Grupo B/C
// (Possui Contrato? + dados do contrato) vira 1 coluna só, ícone com tooltip
// listando os dados — mesma simplificação do Lançamento, aqui só leitura.
async function renderItensDfd(colunasParam) {
  const todasColunas = colunasParam || (await (await fetch(`/api/pac/dfds/${_dfdAtualId}`)).json()).colunas;
  const colunas = todasColunas.filter(c => c.grupo === 'A');
  const colunasContrato = todasColunas.filter(c => c.grupo === 'C');
  const temColContrato = colunasContrato.length > 0;

  const [itensRes, setoresRes] = await Promise.all([
    fetch(`/api/pac/dfds/${_dfdAtualId}/itens`),
    fetch('/api/pac/setores'),
  ]);
  const itens = itensRes.ok ? await itensRes.json() : [];
  const setores = setoresRes.ok ? await setoresRes.json() : [];
  const nomeSetor = id => (setores.find(s => s.id === id) || {}).nome || `#${id}`;

  // "Setor" primeiro, depois ID PAC/Nº PAC — "Número" (numero_item, sequencial
  // interno) não aparece mais aqui, mesma decisão da tela de Lançamento
  // (instrução do Alex era só ID_PAC + NUMERO_PAC visíveis pro usuário final).
  const colunasResto = colunas.filter(c => c.slug !== 'numero_item');

  document.getElementById('dfd-det-itens-thead').innerHTML =
    `<tr><th>Setor</th><th>ID PAC</th><th>Nº PAC</th>${colunasResto.map(c => `<th>${c.label}</th>`).join('')}${temColContrato ? '<th>Contrato</th>' : ''}</tr>`;

  document.getElementById('dfd-det-itens-tbody').innerHTML = itens.map(item => `
    <tr>
      <td>${nomeSetor(item.setor_id)}</td>
      <td>${item.codigo_pac || '—'}</td>
      <td>${item.numero_pac || '—'}</td>
      ${colunasResto.map(c => `<td>${formatarValorColuna(c, item.valores[c.id])}</td>`).join('')}
      ${temColContrato ? celulaContratoLeitura(item, colunasContrato, todasColunas, item.id) : ''}
    </tr>
  `).join('') || `<tr><td colspan="${colunasResto.length + 3 + (temColContrato ? 1 : 0)}" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item lançado ainda.</td></tr>`;
  return itens;
}

/* ── Formatação por tipo de coluna (mesma ideia de fmtBr/fmtMoeda do resto do
   sistema, despachada pelo tipo_input da coluna) ───────────────────────────── */
function fmtBr(iso) {
  if (!iso) return '—';
  const d = String(iso).split(/[T ]/)[0].split('-');
  if (d.length < 3) return iso;
  return `${d[2]}/${d[1]}/${d[0]}`;
}
function fmtMoeda(v) {
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '';
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
// Fonte pagadora rateada entre 2+ fontes (JSON {"TU":60,"RDC":40}, ver
// abrirModalRateioFonte em pac-lancamento.js) — mesmo parser duplicado aqui
// (convenção do arquivo, sem módulo compartilhado novo) só pra EXIBIR; quem
// edita é sempre o gestor em Lançamento.
function parseRateioFonte(valor) {
  if (!valor) return null;
  const s = String(valor).trim();
  if (!s.startsWith('{')) return null;
  try {
    const obj = JSON.parse(s);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch { return null; }
}
function textoRateioFonte(valor) {
  const rateio = parseRateioFonte(valor);
  if (!rateio) return null;
  return Object.entries(rateio).map(([f, p]) => `${f} ${p}%`).join(' / ');
}

// Modal de rateio (mesmo #modal-rateio-fonte de Lançamento, versão
// Consolidação — pedido do Alex, 2026-09-17: "não temos o informe do %
// aqui também"). Opções vêm de _listasCacheConsol (não _listasCache, que é
// da tela de Lançamento) e salva via PUT /consolidacao/itens/:id/valores.
let _rfConsolItemId = null, _rfConsolColunaId = null;
function abrirModalRateioFonteConsol(itemId, colunaId) {
  const item = (_consolDados?.itens || []).find(i => i.id === itemId);
  if (!item) return;
  _rfConsolItemId = itemId; _rfConsolColunaId = colunaId;
  const valorAtual = (item.valores || {})[colunaId];
  const rateioAtual = parseRateioFonte(valorAtual) || (valorAtual ? { [valorAtual]: 100 } : {});
  const opcoes = (_listasCacheConsol.fonte_pagadora || []).map(o => o.valor);
  document.getElementById('rateio-fonte-linhas').innerHTML = opcoes.map(op => `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <label style="display:flex;align-items:center;gap:6px;flex:1;cursor:pointer;">
        <input type="checkbox" id="rf-chk-${op}" ${rateioAtual[op] != null ? 'checked' : ''} onchange="atualizarTotalRateioFonte()"> ${op}
      </label>
      <input type="number" id="rf-pct-${op}" min="0" max="100" step="0.01" value="${rateioAtual[op] ?? ''}"
        style="width:80px;text-align:right;" placeholder="%" oninput="atualizarTotalRateioFonte()">
    </div>`).join('');
  document.getElementById('rateio-fonte-msg').textContent = '';
  atualizarTotalRateioFonte();
  document.getElementById('modal-rateio-fonte').classList.add('open');
}
function fecharModalRateioFonte() {
  document.getElementById('modal-rateio-fonte').classList.remove('open');
  _rfConsolItemId = null; _rfConsolColunaId = null;
}
function lerRateioFonteFormConsol() {
  const opcoes = (_listasCacheConsol.fonte_pagadora || []).map(o => o.valor);
  const rateio = {};
  opcoes.forEach(op => {
    const chk = document.getElementById(`rf-chk-${op}`);
    if (chk && chk.checked) rateio[op] = Number(document.getElementById(`rf-pct-${op}`).value) || 0;
  });
  return rateio;
}
function atualizarTotalRateioFonte() {
  const rateio = lerRateioFonteFormConsol();
  const total = Object.values(rateio).reduce((s, v) => s + v, 0);
  const el = document.getElementById('rateio-fonte-total');
  if (!el) return;
  el.textContent = `Total: ${total}%`;
  el.style.color = Math.abs(total - 100) < 0.01 ? 'var(--verde,#2E7D32)' : '#c0392b';
}
async function salvarRateioFonteConsol() {
  const rateio = lerRateioFonteFormConsol();
  const fontes = Object.keys(rateio);
  const msg = document.getElementById('rateio-fonte-msg');
  if (!fontes.length) { msg.textContent = 'Marque ao menos uma fonte pagadora.'; return; }
  const total = fontes.reduce((s, f) => s + rateio[f], 0);
  if (Math.abs(total - 100) > 0.01) { msg.textContent = `A soma dos percentuais precisa ser 100% (está em ${total}%).`; return; }
  const valor = fontes.length === 1 ? fontes[0] : JSON.stringify(rateio);
  try {
    const res = await fetch(`/api/pac/consolidacao/itens/${_rfConsolItemId}/valores`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valores: { [_rfConsolColunaId]: valor } }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); msg.textContent = e.error || 'Erro ao salvar.'; return; }
    const item = (_consolDados?.itens || []).find(i => i.id === _rfConsolItemId);
    if (item) { item.valores = item.valores || {}; item.valores[_rfConsolColunaId] = valor; }
    fecharModalRateioFonte();
    await renderConsolidadoDetalhe();
    toast('Rateio da fonte pagadora salvo.');
  } catch { msg.textContent = 'Erro ao salvar.'; }
}

function formatarValorColuna(coluna, valor) {
  if (valor === null || valor === undefined || valor === '') return '—';
  if (coluna.tipo_input === 'data') return fmtBr(valor);
  if (coluna.tipo_input === 'moeda') return fmtMoeda(valor);
  if (coluna.slug === 'fonte_pagadora') return textoRateioFonte(valor) || valor;
  return valor;
}

const ICONE_CONTRATO_SIM = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--verde)" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15l2 2 4-4"/></svg>`;
const ICONE_CONTRATO_NAO = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;
const ICONE_CONTRATO_PENDENTE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a15c00" stroke-width="2"><path d="M12 9v4"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L14.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 17h.01"/></svg>`;
const ICONE_CONTRATO_NAO_INFORMADO = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" stroke-width="1.5" stroke-dasharray="3 2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;

// Só leitura aqui (quem edita é o gestor em Lançamento) — badge com texto
// já visível, sem depender de hover; o tooltip complementa listando os
// dados quando preenchido. "possui_contrato" (grupo B) é a fonte da verdade
// do estado — distingue "Não" deliberado de "ainda não respondido"
// (mesma lógica de estadoContrato() em pac-lancamento.js).
// Guarda todo item já renderizado em QUALQUER tabela da página (DFDs,
// Acompanhamento, Consolidação), pela chave que faz sentido em cada fonte —
// só pra abrirContratoLeitura() achar o item e suas colunas de contrato sem
// precisar de uma nova requisição, venha o clique de onde vier.
const _itensPorId = {};

function celulaContratoLeitura(item, colunasContrato, todasColunas, idParaClique) {
  _itensPorId[idParaClique] = item;
  const possuiCol = todasColunas.find(c => c.slug === 'possui_contrato');
  const v = possuiCol ? item.valores[possuiCol.id] : null;
  const estado = v === 'Sim' ? 'sim' : v === 'Não' ? 'nao' : v === 'Não informado' ? 'nao_informado' : 'pendente';
  const cfg = {
    sim: { icone: ICONE_CONTRATO_SIM, texto: 'Com contrato', titulo: 'Clique para ver os dados do contrato' },
    nao: { icone: ICONE_CONTRATO_NAO, texto: 'Sem contrato', titulo: 'Este item não tem contrato' },
    nao_informado: { icone: ICONE_CONTRATO_NAO_INFORMADO, texto: 'Não informado', titulo: 'Dado histórico importado sem essa informação na planilha original' },
    pendente: { icone: ICONE_CONTRATO_PENDENTE, texto: 'Pendente', titulo: 'O setor ainda não informou se este item tem contrato' },
  }[estado];
  return `<td style="text-align:center;"><button type="button" class="badge-contrato ${estado}" title="${cfg.titulo}" onclick="abrirContratoLeitura(${idParaClique})">${cfg.icone} ${cfg.texto}</button></td>`;
}

// Popup só-leitura dos dados de contrato (Nº/Razão Social/Vencimento/Será
// renovado?) — pedido do Alex pras telas de Gestão (Acompanhamento,
// Consolidação, DFDs): o badge precisa ser clicável igual em Lançamento, só
// que sem poder editar (quem edita é o gestor do setor, não o DEPLA aqui).
function abrirContratoLeitura(idParaClique) {
  const item = _itensPorId[idParaClique];
  if (!item || !_colunasCatalogo) return;
  const colunasContrato = _colunasCatalogo.filter(c => c.grupo === 'C');
  document.getElementById('mcl-campos').innerHTML = colunasContrato.map(c => {
    const valor = (item.valores || {})[c.id];
    return `<div class="form-group" style="margin-bottom:10px;"><label>${c.label}</label><div style="padding:8px 0;">${formatarValorColuna(c, valor)}</div></div>`;
  }).join('') || '<p class="text-muted">Nenhuma coluna de contrato ativa neste DFD.</p>';
  document.getElementById('modal-contrato-leitura').classList.add('open');
}
function fecharContratoLeitura() {
  document.getElementById('modal-contrato-leitura').classList.remove('open');
}

/* ── Setores (cadastro) ──────────────────────────────────────────────────── */

async function carregarSetores() {
  try {
    const res = await fetch('/api/pac/setores');
    const setores = res.ok ? await res.json() : [];
    document.getElementById('setores-tbody').innerHTML = setores.map(s => `
      <tr>
        <td><strong>${s.nome}</strong></td>
        <td>${s.sigla || '—'}</td>
        <td>${s.ordem}</td>
        <td><input type="checkbox" ${s.ativo ? 'checked' : ''} onchange="toggleSetorAtivo(${s.id}, this.checked)"></td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="editarSetor(${s.id},'${(s.nome || '').replace(/'/g, "\\'")}','${(s.sigla || '').replace(/'/g, "\\'")}',${s.ordem})">Editar</button>
          <button class="btn btn-secondary btn-sm" onclick="abrirModalSetorUsuarios(${s.id},'${(s.nome || '').replace(/'/g, "\\'")}')">Usuários</button>
        </td>
      </tr>
    `).join('');
  } catch {
    toast('Erro ao carregar setores', 'error');
  }
}

async function adicionarSetor() {
  const nome = document.getElementById('new-setor-nome').value.trim();
  const sigla = document.getElementById('new-setor-sigla').value.trim();
  const msg = document.getElementById('setor-msg');
  msg.style.color = '';
  if (!nome) { msg.style.color = '#c00'; msg.textContent = 'Informe o nome do setor.'; return; }
  try {
    const res = await fetch('/api/pac/setores', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome, sigla }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    msg.style.color = '#2E7D32'; msg.textContent = `Setor "${nome}" criado.`;
    document.getElementById('new-setor-nome').value = '';
    document.getElementById('new-setor-sigla').value = '';
    carregarSetores();
  } catch (e) {
    msg.style.color = '#c00'; msg.textContent = 'Erro: ' + e.message;
  }
}

async function editarSetor(id, nomeAtual, siglaAtual, ordemAtual) {
  const nome = prompt('Nome do setor:', nomeAtual);
  if (nome === null || !nome.trim()) return;
  const sigla = prompt('Sigla:', siglaAtual);
  if (sigla === null) return;
  const ordemStr = prompt('Ordem:', ordemAtual);
  if (ordemStr === null) return;
  try {
    const res = await fetch(`/api/pac/setores/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: nome.trim(), sigla: sigla.trim(), ordem: parseInt(ordemStr, 10) || 0 }),
    });
    if (!res.ok) throw new Error();
    carregarSetores();
  } catch {
    toast('Erro ao editar setor', 'error');
  }
}

async function toggleSetorAtivo(id, ativo) {
  try {
    const res = await fetch(`/api/pac/setores/${id}/ativo`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ativo }),
    });
    if (!res.ok) throw new Error();
  } catch {
    toast('Erro ao atualizar setor', 'error');
    carregarSetores();
  }
}

let _setorUsuariosId = null;

async function abrirModalSetorUsuarios(setorId, nomeSetor) {
  _setorUsuariosId = setorId;
  document.getElementById('modal-setor-usuarios-titulo').textContent = `Usuários — ${nomeSetor}`;
  await renderSetorUsuarios();
  document.getElementById('modal-setor-usuarios').classList.add('open');
}

function fecharModalSetorUsuarios() {
  document.getElementById('modal-setor-usuarios').classList.remove('open');
  _setorUsuariosId = null;
}

async function renderSetorUsuarios() {
  const tbody = document.getElementById('setor-usuarios-tbody');
  tbody.innerHTML = '<tr><td colspan="2" style="padding:12px;text-align:center;color:var(--text-subtle);">Carregando...</td></tr>';
  const res = await fetch(`/api/pac/setores/${_setorUsuariosId}/usuarios`);
  const usuarios = res.ok ? await res.json() : [];
  tbody.innerHTML = usuarios.map(u => `
    <tr>
      <td style="width:32px;"><input type="checkbox" ${u.vinculado ? 'checked' : ''} onchange="toggleSetorUsuario(${u.id}, this.checked)"></td>
      <td>${u.nome_completo || u.username}</td>
    </tr>
  `).join('') || `<tr><td colspan="2" style="padding:12px;text-align:center;color:var(--text-subtle);">Nenhum usuário.</td></tr>`;
}

async function toggleSetorUsuario(userId, vinculado) {
  try {
    const res = await fetch(`/api/pac/setores/${_setorUsuariosId}/usuarios`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, vinculado }),
    });
    if (!res.ok) throw new Error();
  } catch {
    toast('Erro ao vincular usuário', 'error');
    renderSetorUsuarios();
  }
}

/* ── Parâmetros (listas de dropdown) ────────────────────────────────────── */

const LISTAS_PARAMETRO = [
  ['tipo', 'Tipo'], ['subitem', 'Subitem (histórico — Objeto virou digitável)'], ['prioridade', 'Prioridade'],
  ['fonte_pagadora', 'Fonte Pagadora'], ['unidade_medida', 'Unidade'], ['sim_nao', 'Sim/Não'],
  ['tipo_contratacao', 'Tipo de Contratação'], ['natureza_orcamentaria', 'Natureza Orçamentária'],
];
// Sentinela — NÃO é uma lista de dfd_parametros_lista, é a tabela estruturada
// `unidades` (nome + código IBGE + CEP + estado). Nome do rótulo deixa
// "(filiais)" explícito pra não confundir com "Unidade" (unidade_medida)
// logo acima, que é outra coisa (unidade de medida do item).
const LISTA_UNIDADES_FISICAS = '__unidades_fisicas__';

function popularSelectListas() {
  const sel = document.getElementById('param-lista-select');
  sel.innerHTML = LISTAS_PARAMETRO.map(([slug, label]) => `<option value="${slug}">${label}</option>`).join('')
    + `<option value="${LISTA_UNIDADES_FISICAS}">Unidades (filiais)</option>`;
}

async function carregarParametros() {
  const lista = document.getElementById('param-lista-select').value;
  const ehUnidades = lista === LISTA_UNIDADES_FISICAS;
  document.getElementById('param-generico-wrap').style.display = ehUnidades ? 'none' : '';
  document.getElementById('param-unidades-wrap').style.display = ehUnidades ? '' : 'none';
  if (ehUnidades) { await carregarUnidadesPac(); return; }
  try {
    const res = await fetch(`/api/pac/parametros?lista=${encodeURIComponent(lista)}`);
    const params = res.ok ? await res.json() : [];
    document.getElementById('parametros-tbody').innerHTML = params.map(p => `
      <tr>
        <td><strong>${p.valor}</strong></td>
        <td>${p.ordem}</td>
        <td><input type="checkbox" ${p.ativo ? 'checked' : ''} onchange="toggleParametroAtivo(${p.id}, this.checked)"></td>
        <td style="text-align:right;">
          <button class="btn btn-secondary btn-sm" onclick="editarParametro(${p.id},'${(p.valor || '').replace(/'/g, "\\'")}',${p.ordem})">Editar</button>
          <button class="btn btn-danger btn-sm" onclick="excluirParametro(${p.id},'${(p.valor || '').replace(/'/g, "\\'")}')">Excluir</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum valor cadastrado.</td></tr>`;
  } catch {
    toast('Erro ao carregar parâmetros', 'error');
  }
}

async function adicionarParametro() {
  const lista = document.getElementById('param-lista-select').value;
  const valor = document.getElementById('new-param-valor').value.trim();
  const ordem = parseInt(document.getElementById('new-param-ordem').value, 10) || 0;
  const msg = document.getElementById('param-msg');
  msg.style.color = '';
  if (!valor) { msg.style.color = '#c00'; msg.textContent = 'Informe o valor.'; return; }
  try {
    const res = await fetch('/api/pac/parametros', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lista, valor, ordem }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    msg.style.color = '#2E7D32'; msg.textContent = `"${valor}" adicionado.`;
    document.getElementById('new-param-valor').value = '';
    document.getElementById('new-param-ordem').value = '';
    carregarParametros();
  } catch (e) {
    msg.style.color = '#c00'; msg.textContent = 'Erro: ' + e.message;
  }
}

async function editarParametro(id, valorAtual, ordemAtual) {
  const valor = prompt('Valor:', valorAtual);
  if (valor === null || !valor.trim()) return;
  const ordemStr = prompt('Ordem:', ordemAtual);
  if (ordemStr === null) return;
  try {
    const res = await fetch(`/api/pac/parametros/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valor: valor.trim(), ordem: parseInt(ordemStr, 10) || 0 }),
    });
    if (!res.ok) throw new Error();
    carregarParametros();
  } catch {
    toast('Erro ao editar parâmetro', 'error');
  }
}

async function toggleParametroAtivo(id, ativo) {
  try {
    const res = await fetch(`/api/pac/parametros/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ativo }),
    });
    if (!res.ok) throw new Error();
  } catch {
    toast('Erro ao atualizar parâmetro', 'error');
    carregarParametros();
  }
}

async function excluirParametro(id, valor) {
  if (!confirm(`Excluir "${valor}"?`)) return;
  try {
    const res = await fetch(`/api/pac/parametros/${id}`, { method: 'DELETE' });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    carregarParametros();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

/* ── Unidades físicas (filiais da CeasaMinas) ───────────────────────────────
   Mesma aba Parâmetros, mas dado estruturado (não cabe no mecanismo genérico
   de dfd_parametros_lista acima) — tabela própria `unidades`. */

async function carregarUnidadesPac() {
  try {
    const res = await fetch('/api/pac/unidades');
    const unidades = res.ok ? await res.json() : [];
    document.getElementById('unidades-tbody').innerHTML = unidades.map(u => `
      <tr>
        <td><strong>${u.nome}</strong></td>
        <td>${u.codigo_ibge || '—'}</td>
        <td>${u.cep || '—'}</td>
        <td>${u.estado || '—'}</td>
        <td>${u.ordem}</td>
        <td><input type="checkbox" ${u.ativo ? 'checked' : ''} onchange="toggleUnidadeAtivo(${u.id}, this.checked)"></td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" onclick='editarUnidadePac(${u.id}, ${JSON.stringify(u.nome)}, ${JSON.stringify(u.codigo_ibge || "")}, ${JSON.stringify(u.cep || "")}, ${JSON.stringify(u.estado || "")}, ${u.ordem})'>Editar</button>
          <button class="btn btn-secondary btn-sm" onclick='abrirModalUnidadeUsuarios(${u.id}, ${JSON.stringify(u.nome)})'>Acesso</button>
          <button class="btn btn-danger btn-sm" onclick='excluirUnidadePac(${u.id}, ${JSON.stringify(u.nome)})'>Excluir</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhuma unidade cadastrada.</td></tr>`;
  } catch {
    toast('Erro ao carregar unidades', 'error');
  }
}

async function adicionarUnidadePac() {
  const nome = document.getElementById('new-unidade-nome').value.trim();
  const codigo_ibge = document.getElementById('new-unidade-ibge').value.trim();
  const cep = document.getElementById('new-unidade-cep').value.trim();
  const estado = document.getElementById('new-unidade-estado').value.trim();
  const ordem = parseInt(document.getElementById('new-unidade-ordem').value, 10) || 0;
  const msg = document.getElementById('param-msg');
  msg.style.color = '';
  if (!nome) { msg.style.color = '#c00'; msg.textContent = 'Informe o nome da unidade.'; return; }
  try {
    const res = await fetch('/api/pac/unidades', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome, codigo_ibge, cep, estado, ordem }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    msg.style.color = '#2E7D32'; msg.textContent = `"${nome}" adicionada.`;
    ['new-unidade-nome', 'new-unidade-ibge', 'new-unidade-cep', 'new-unidade-estado', 'new-unidade-ordem'].forEach(id => { document.getElementById(id).value = ''; });
    carregarUnidadesPac();
  } catch (e) {
    msg.style.color = '#c00'; msg.textContent = 'Erro: ' + e.message;
  }
}

async function editarUnidadePac(id, nomeAtual, ibgeAtual, cepAtual, estadoAtual, ordemAtual) {
  const nome = prompt('Nome:', nomeAtual);
  if (nome === null || !nome.trim()) return;
  const codigo_ibge = prompt('Código IBGE:', ibgeAtual);
  if (codigo_ibge === null) return;
  const cep = prompt('CEP:', cepAtual);
  if (cep === null) return;
  const estado = prompt('Estado:', estadoAtual);
  if (estado === null) return;
  const ordemStr = prompt('Ordem:', ordemAtual);
  if (ordemStr === null) return;
  try {
    const res = await fetch(`/api/pac/unidades/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: nome.trim(), codigo_ibge: codigo_ibge.trim(), cep: cep.trim(), estado: estado.trim(), ordem: parseInt(ordemStr, 10) || 0 }),
    });
    if (!res.ok) throw new Error();
    carregarUnidadesPac();
  } catch {
    toast('Erro ao editar unidade', 'error');
  }
}

async function toggleUnidadeAtivo(id, ativo) {
  try {
    const res = await fetch(`/api/pac/unidades/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ativo }),
    });
    if (!res.ok) throw new Error();
  } catch {
    toast('Erro ao atualizar unidade', 'error');
    carregarUnidadesPac();
  }
}

async function excluirUnidadePac(id, nome) {
  if (!confirm(`Excluir "${nome}"?`)) return;
  try {
    const res = await fetch(`/api/pac/unidades/${id}`, { method: 'DELETE' });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    carregarUnidadesPac();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

/* ── Orçamento (pedido do Alex, 2026-09-24) ──────────────────────────────────
   Gestão > Administração > Orçamentos. Lista em cards (não uma tabela crua —
   pedido explícito "uma tela elegante"); detalhe é um grid de Natureza+valor
   com filtro por nome (a lista real passa de 70 naturezas) e total ao vivo. */
let _orcamentos = [];
let _orcAtualId = null;
let _orcNaturezas = [];

async function carregarOrcamentosLista() {
  document.getElementById('orc-lista').style.display = '';
  document.getElementById('orc-detalhe').style.display = 'none';
  const wrap = document.getElementById('orc-cards');
  wrap.innerHTML = '<div class="text-muted" style="padding:12px;">Carregando...</div>';
  try {
    const res = await fetch('/api/pac/orcamentos');
    _orcamentos = res.ok ? await res.json() : [];
    wrap.innerHTML = _orcamentos.map(o => `
      <div class="orc-card${o.ativo ? '' : ' inativo'}" onclick="abrirDetalheOrcamento(${o.id}, '${o.nome.replace(/'/g, "\\'")}')">
        <div class="orc-card-nome">${o.nome}${o.ativo ? '' : ' (inativo)'}</div>
        <div class="orc-card-total">R$ ${_consolFmtMoeda(o.total)}</div>
        <div class="orc-card-sub">${o.naturezas_count} natureza(s) com valor definido</div>
        <div class="orc-card-acoes" onclick="event.stopPropagation()">
          <button type="button" class="btn btn-secondary btn-xs" onclick="renomearOrcamento(${o.id}, '${o.nome.replace(/'/g, "\\'")}')">Renomear</button>
          <button type="button" class="btn btn-secondary btn-xs" onclick="toggleOrcamentoAtivo(${o.id}, ${!o.ativo})">${o.ativo ? 'Desativar' : 'Ativar'}</button>
          <button type="button" class="btn btn-danger btn-xs" onclick="excluirOrcamento(${o.id}, '${o.nome.replace(/'/g, "\\'")}')">Excluir</button>
        </div>
      </div>`).join('') || '<div class="text-muted" style="padding:12px;">Nenhum orçamento cadastrado ainda.</div>';
  } catch {
    wrap.innerHTML = '<div style="padding:12px;color:#c0392b;">Erro ao carregar.</div>';
  }
}

async function criarOrcamento() {
  const nome = document.getElementById('new-orc-nome').value.trim();
  const msg = document.getElementById('orc-msg');
  msg.style.color = '';
  if (!nome) { msg.style.color = '#c00'; msg.textContent = 'Informe o nome.'; return; }
  try {
    const res = await fetch('/api/pac/orcamentos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    document.getElementById('new-orc-nome').value = '';
    msg.style.color = '#2E7D32'; msg.textContent = `Orçamento "${nome}" criado.`;
    carregarOrcamentosLista();
  } catch (e) {
    msg.style.color = '#c00'; msg.textContent = 'Erro: ' + e.message;
  }
}

async function renomearOrcamento(id, nomeAtual) {
  const nome = prompt('Novo nome do orçamento:', nomeAtual);
  if (nome === null || !nome.trim() || nome.trim() === nomeAtual) return;
  try {
    const res = await fetch(`/api/pac/orcamentos/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome: nome.trim() }),
    });
    if (!res.ok) throw new Error();
    carregarOrcamentosLista();
  } catch {
    toast('Erro ao renomear orçamento', 'error');
  }
}

async function toggleOrcamentoAtivo(id, ativo) {
  try {
    const res = await fetch(`/api/pac/orcamentos/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ativo }),
    });
    if (!res.ok) throw new Error();
    carregarOrcamentosLista();
  } catch {
    toast('Erro ao atualizar orçamento', 'error');
  }
}

async function excluirOrcamento(id, nome) {
  if (!confirm(`Excluir "${nome}"?`)) return;
  try {
    const res = await fetch(`/api/pac/orcamentos/${id}`, { method: 'DELETE' });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    carregarOrcamentosLista();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

async function abrirDetalheOrcamento(id, nome) {
  _orcAtualId = id;
  document.getElementById('orc-lista').style.display = 'none';
  document.getElementById('orc-detalhe').style.display = '';
  document.getElementById('orc-det-titulo').textContent = nome;
  document.getElementById('orc-filtro').value = '';
  await carregarNaturezasOrcamento();
}

function fecharDetalheOrcamento() {
  _orcAtualId = null;
  document.getElementById('orc-detalhe').style.display = 'none';
  carregarOrcamentosLista();
}

async function carregarNaturezasOrcamento() {
  const tbody = document.getElementById('orc-naturezas-tbody');
  tbody.innerHTML = `<tr><td colspan="2" style="padding:12px;text-align:center;color:var(--text-subtle);">Carregando...</td></tr>`;
  try {
    const res = await fetch(`/api/pac/orcamentos/${_orcAtualId}/naturezas`);
    _orcNaturezas = res.ok ? await res.json() : [];
    // Ordem alfabética na EXIBIÇÃO (não altera a ordem "de classificação" da
    // lista de parâmetro, só como essa tela em particular mostra) — pedido
    // do Alex, 2026-09-24: tabela limpa, fácil de escanear/achar um nome.
    _orcNaturezas.sort((a, b) => a.natureza.localeCompare(b.natureza, 'pt-BR'));
    renderNaturezasOrcamento();
  } catch {
    tbody.innerHTML = `<tr><td colspan="2" style="padding:12px;text-align:center;color:#c0392b;">Erro ao carregar.</td></tr>`;
  }
}

// Filtro NÃO re-renderiza a partir de _orcNaturezas (perderia valores ainda
// não salvos digitados antes de filtrar) — só esconde/mostra linhas já no DOM.
function renderNaturezasOrcamento() {
  const tbody = document.getElementById('orc-naturezas-tbody');
  tbody.innerHTML = _orcNaturezas.map(n => `
    <tr data-nome="${n.natureza.toLowerCase().replace(/"/g, '&quot;')}">
      <td>${n.natureza}</td>
      <td style="text-align:right;">
        <input type="text" class="orc-valor-input" data-natureza="${n.natureza.replace(/"/g, '&quot;')}" value="${n.valor ? _consolFmtMoeda(n.valor) : ''}" placeholder="0,00" oninput="atualizarTotalOrcamento()" />
      </td>
    </tr>`).join('') || `<tr><td colspan="2" style="padding:12px;text-align:center;color:var(--text-subtle);">Nenhuma natureza cadastrada.</td></tr>`;
  atualizarTotalOrcamento();
  aplicarFiltroOrcamento();
}

function aplicarFiltroOrcamento() {
  const filtro = (document.getElementById('orc-filtro').value || '').toLowerCase();
  document.querySelectorAll('#orc-naturezas-tbody tr[data-nome]').forEach(row => {
    row.style.display = row.dataset.nome.includes(filtro) ? '' : 'none';
  });
}

function atualizarTotalOrcamento() {
  const total = [...document.querySelectorAll('.orc-valor-input')].reduce((s, el) => s + (_consolParseMoeda(el.value) || 0), 0);
  document.getElementById('orc-det-total').textContent = `R$ ${_consolFmtMoeda(total)}`;
}

async function salvarNaturezasOrcamento() {
  const naturezas = {};
  document.querySelectorAll('.orc-valor-input').forEach(el => {
    naturezas[el.dataset.natureza] = _consolParseMoeda(el.value) || 0;
  });
  try {
    const res = await fetch(`/api/pac/orcamentos/${_orcAtualId}/naturezas`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ naturezas }),
    });
    if (!res.ok) throw new Error();
    toast('Valores salvos.');
    await carregarNaturezasOrcamento();
  } catch {
    toast('Erro ao salvar valores do orçamento', 'error');
  }
}

/* ── Acesso por Unidade (restrição gestor→unidade / sub-gestor) ─────────────
   Mesmo padrão de abrirModalSetorUsuarios/renderSetorUsuarios/toggleSetorUsuario
   acima, trocando setor por unidade. */
let _unidadeUsuariosId = null;

async function abrirModalUnidadeUsuarios(unidadeId, nomeUnidade) {
  _unidadeUsuariosId = unidadeId;
  document.getElementById('modal-unidade-usuarios-titulo').textContent = `Acesso — ${nomeUnidade}`;
  await renderUnidadeUsuarios();
  document.getElementById('modal-unidade-usuarios').classList.add('open');
}

function fecharModalUnidadeUsuarios() {
  document.getElementById('modal-unidade-usuarios').classList.remove('open');
  _unidadeUsuariosId = null;
}

async function renderUnidadeUsuarios() {
  const tbody = document.getElementById('unidade-usuarios-tbody');
  tbody.innerHTML = '<tr><td colspan="2" style="padding:12px;text-align:center;color:var(--text-subtle);">Carregando...</td></tr>';
  const res = await fetch(`/api/pac/unidades/${_unidadeUsuariosId}/usuarios`);
  const usuarios = res.ok ? await res.json() : [];
  tbody.innerHTML = usuarios.map(u => `
    <tr>
      <td style="width:32px;"><input type="checkbox" ${u.vinculado ? 'checked' : ''} onchange="toggleUnidadeUsuario(${u.id}, this.checked)"></td>
      <td>${u.nome_completo || u.username}</td>
    </tr>
  `).join('') || `<tr><td colspan="2" style="padding:12px;text-align:center;color:var(--text-subtle);">Nenhum usuário.</td></tr>`;
}

async function toggleUnidadeUsuario(userId, vinculado) {
  try {
    const res = await fetch(`/api/pac/unidades/${_unidadeUsuariosId}/usuarios`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, vinculado }),
    });
    if (!res.ok) throw new Error();
    toast('Salvo.');
  } catch {
    toast('Erro ao salvar', 'error');
    renderUnidadeUsuarios();
  }
}

/* ── Pedidos de edição ───────────────────────────────────────────────────── */

async function carregarPedidos() {
  try {
    const res = await fetch('/api/pac/pedidos');
    const pedidos = res.ok ? await res.json() : [];
    const pendentes = pedidos.filter(p => p.status === 'pendente');
    const contadorEl = document.getElementById('pac-cnt-pedidos');
    contadorEl.textContent = pendentes.length;
    // Destaque visual quando há pendência — pedido do Alex, 2026-09-08: "um
    // ícone flutuante que represente os Pedidos na árvore de menu lateral
    // [...] não pedi pra remover ela, mas ter algo também visual" (não é um
    // ícone novo, é o próprio contador que já existia ganhando mais força).
    contadorEl.classList.toggle('alerta', pendentes.length > 0);
    document.getElementById('pedidos-tbody').innerHTML = pedidos.map(p => `
      <tr>
        <td>#${p.dfd_id}</td>
        <td>#${p.setor_id}</td>
        <td>#${p.item_id ?? '—'}</td>
        <td>${p.tipo}${p.tentativa > 1 ? ' <span class="text-muted" style="font-size:11px;">(contestado)</span>' : ''}</td>
        <td>${p.justificativa || '—'}</td>
        <td>${p.status === 'rejeitado' && p.bloqueado ? 'rejeitado (definitivo)' : p.status}</td>
        <td style="text-align:right;white-space:nowrap;">
          ${p.status === 'pendente' ? `
            <button class="btn btn-primary btn-sm" onclick="responderPedido(${p.id},'aprovado')">Aprovar</button>
            <button class="btn btn-danger btn-sm" onclick="responderPedido(${p.id},'rejeitado')">Rejeitar</button>
          ` : (p.resposta || '—')}
        </td>
      </tr>
    `).join('') || `<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum pedido.</td></tr>`;
  } catch {
    toast('Erro ao carregar pedidos', 'error');
  }
}

async function responderPedido(id, status) {
  const resposta = prompt(status === 'aprovado' ? 'Resposta (opcional):' : 'Motivo da rejeição (obrigatório):');
  if (resposta === null) return;
  // Rejeitar sem explicar não vale — pedido do Alex, 2026-09-08: "se recusar
  // por parte do depla tem que explicar prq". Servidor também valida isso;
  // checar aqui só evita a ida e volta.
  if (status === 'rejeitado' && !resposta.trim()) { toast('Explique o motivo da rejeição.', 'error'); return; }
  try {
    const res = await fetch(`/api/pac/pedidos/${id}/resposta`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, resposta }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    carregarPedidos();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

/* ── Execução do PAC: helpers compartilhados (Consolidação/Solicitações/Acompanhamento) ── */

function parseMoeda(s) {
  if (s === null || s === undefined || s === '') return 0;
  const v = parseFloat(String(s).replace(/[R$\s.]/g, '').replace(',', '.'));
  return isNaN(v) ? 0 : v;
}
function fmtBrData(iso) {
  if (!iso) return '—';
  const d = String(iso).split(/[T ]/)[0].split('-');
  if (d.length < 3) return iso;
  return `${d[2]}/${d[1]}/${d[0]}`;
}
function badgeStatusExec(status) {
  const cor = {
    'Não Iniciado': 'fechado', 'Processado DEPLA': 'aberto', 'Fracionamento Aberto': 'analise',
    'Processo Finalizado': 'aberto', 'Cancelado': 'fechado',
  }[status] || 'fechado';
  return `<span class="badge badge-${cor}">${status || '—'}</span>`;
}

// Popula os 2 seletores de "DFD (exercício)" (Solicitações e Acompanhamento) —
// só faz sentido trabalhar execução em cima de um DFD já fechado (é quando a
// consolidação existe), mas a lista aceita qualquer DFD: solicitação pode ser
// registrada mesmo antes da consolidação (o vínculo é por item_id, não por
// numero_pac — sobrevive à consolidação/recálculo que vier depois).
async function popularSelectDfdsExecucao() {
  if (!_dfds.length) await carregarDfds();
  const opts = _dfds.map(d => `<option value="${d.id}">${codigoDfd(d)} — ${d.titulo}</option>`).join('');
  const solSel = document.getElementById('sol-dfd-select');
  if (solSel) solSel.innerHTML = opts;
  // acomp-dfd-select virou <input type="hidden"> — a escolha do DFD agora é
  // a lista de entrada de Acompanhamento (mostrarListaAcompanhamento, já
  // restrita a status==='aberto'), não um <select> aqui.

  try {
    const [setoresRes, naturezaRes] = await Promise.all([
      fetch('/api/pac/setores'),
      fetch('/api/pac/parametros?lista=natureza_orcamentaria'),
    ]);
    const setores = setoresRes.ok ? await setoresRes.json() : [];
    const setorSel = document.getElementById('sol-setor-select');
    if (setorSel) setorSel.innerHTML = setores.filter(s => s.ativo).map(s => `<option value="${s.id}">${s.nome}</option>`).join('');
    const filtroSetor = document.getElementById('acomp-filtro-setor');
    if (filtroSetor) filtroSetor.innerHTML = `<option value="">Todos</option>` + setores.map(s => `<option value="${s.id}">${s.nome}</option>`).join('');

    const naturezas = naturezaRes.ok ? await naturezaRes.json() : [];
    const naturezaSel = document.getElementById('sol-natureza-select');
    if (naturezaSel) {
      naturezaSel.innerHTML = naturezas.filter(n => n.ativo).map(n => `<option value="${n.valor}">${n.valor}</option>`).join('')
        || `<option value="">Nenhuma cadastrada em Parâmetros</option>`;
    }
  } catch {}
}

/* ── Consolidação ─────────────────────────────────────────────────────────────
   Fluxo novo: um DFD só aparece aqui depois que TODOS os setores finalizaram
   o lançamento e o DEPLA clicou "Gerar Consolidação" na aba Acompanhamento
   (ver renderFinalizacaoAcompanhamento) — não depende mais de status='fechado'
   do DFD. numero_pac já nasce global nesse momento; aqui o DEPLA aprova
   (em análise/finalizado) ou cancela item a item, com observação livre, e ao
   finalizar a consolidação de um setor a numeração é reordenada de novo
   (Momento 3), excluindo cancelados da sequência ativa. ────────────────────── */

// Pedido do Alex, 2026-09-15: página inicial de Consolidação só com os
// DFDs "não consolidados" (o que precisa de ação), guias separadas pra
// consolidados/cancelados — antes só existia a tabela de consolidados.
function mudarConsolListaSubtab(sub) {
  document.querySelectorAll('.consol-lista-subtab').forEach(b => b.classList.toggle('active', b.dataset.sub === sub));
  ['pendentes', 'consolidados', 'cancelados'].forEach(s =>
    document.getElementById(`consol-lista-${s}`).style.display = s === sub ? 'block' : 'none');
}

async function carregarConsolidacaoLista() {
  document.getElementById('consol-lista').style.display = 'block';
  document.getElementById('consol-detalhe').style.display = 'none';
  if (!_dfds.length) await carregarDfds();

  const consolidacoes = (await Promise.all(_dfds.map(async d => {
    const res = await fetch(`/api/pac/dfds/${d.id}/consolidado`);
    const info = res.ok ? await res.json() : { consolidado: false };
    return { dfd: d, info };
  })));

  const cancelados = _dfds.filter(d => d.status === 'cancelado');
  // "Consolidados" (aba de verdade) = só quando a etapa TERMINOU
  // (dfd.status já virou 'consolidado'/'fechado') — ter uma linha em
  // pac_consolidacoes (info.consolidado) só significa que "Iniciar
  // Consolidação" já foi clicado, não que terminou. Achado pelo Alex
  // testando, 2026-09-17: um DFD recém-movido pra 'em_consolidacao'
  // (trabalho ainda em andamento) estava pulando direto pra aba
  // "Consolidados" só por já ter essa linha.
  const consolidados = consolidacoes.filter(c => c.info.consolidado && (c.dfd.status === 'consolidado' || c.dfd.status === 'fechado'));
  // "Não consolidados" = em análise (ainda não iniciou) OU em consolidação
  // (iniciou, mas o trabalho não terminou) — nos dois casos precisa de
  // atenção do DEPLA aqui, só muda o botão de ação.
  const pendentes = _dfds.filter(d => (d.status === 'analise' || d.status === 'em_consolidacao') && !consolidados.some(c => c.dfd.id === d.id));

  const tbodyPend = document.getElementById('consol-tbody-pendentes');
  tbodyPend.innerHTML = pendentes.map(d => `
    <tr>
      <td><strong>${codigoDfd(d)}</strong></td>
      <td>${d.titulo}</td>
      <td>${d.ano_base}</td>
      <td>${badgeStatusDfd(d.status)}</td>
      <td style="text-align:right;white-space:nowrap;">
        ${d.status === 'em_consolidacao'
          ? `<button class="btn btn-secondary btn-sm" onclick="abrirConsolidadoDetalhe(${d.id},'${(d.titulo || '').replace(/'/g, "\\'")}',${d.ano_base})">Continuar consolidação</button>`
          : `<button class="btn btn-primary btn-sm" onclick="irIniciarConsolidacao(${d.id})">Iniciar Consolidação</button>`}
      </td>
    </tr>
  `).join('') || `<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum DFD aguardando consolidação.</td></tr>`;

  const tbody = document.getElementById('consol-tbody');
  tbody.innerHTML = consolidados.map(({ dfd, info }) => `
    <tr>
      <td><strong>${codigoDfd(dfd)}</strong></td>
      <td>${dfd.titulo}</td>
      <td>${dfd.ano_base}</td>
      <td>${info.itens.length}</td>
      <td>Consolidado em ${fmtBrData(info.consolidacao.consolidado_em)}</td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="btn btn-secondary btn-sm" onclick="abrirConsolidadoDetalhe(${dfd.id},'${(dfd.titulo || '').replace(/'/g, "\\'")}',${dfd.ano_base})">Ver consolidado</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum DFD consolidado ainda.</td></tr>`;

  const tbodyCanc = document.getElementById('consol-tbody-cancelados');
  tbodyCanc.innerHTML = cancelados.map(d => `
    <tr>
      <td><strong>${codigoDfd(d)}</strong></td>
      <td>${d.titulo}</td>
      <td>${d.ano_base}</td>
      <td>${d.justificativa_cancelamento || '—'}</td>
      <td>${d.cancelado_por_username || '—'}</td>
      <td>${fmtBrData(d.cancelado_em)}</td>
    </tr>
  `).join('') || `<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum DFD cancelado.</td></tr>`;
}

let _consolDfdId = null;
let _consolDados = null; // { itens, totais... } — cache do GET /consolidado
let _consolSubtabAtual = 'ativos';

async function abrirConsolidadoDetalhe(dfdId, titulo, anoBase) {
  _consolDfdId = dfdId;
  _consolSubtabAtual = 'ativos';
  document.getElementById('consol-lista').style.display = 'none';
  document.getElementById('consol-detalhe').style.display = 'block';
  document.getElementById('consol-det-titulo').textContent = `${codigoDfd({ id: dfdId, ano_base: anoBase })} — ${titulo} — Consolidado`;
  // Vencimento (entrega) do DFD — pedido do Alex, 2026-09-07. _dfds já vem
  // carregado (carregarConsolidacaoLista chama carregarDfds() se preciso).
  const dfdInfo = _dfds.find(d => d.id === dfdId);
  const vencEl = document.getElementById('consol-det-vencimento');
  // Sempre mostra ENCERRAMENTO aqui (pedido do Alex, 2026-09-22) — telas do
  // DEPLA que fazem análise/consolidação nunca mostram o vencimento (que é
  // o prazo do SETOR pra lançar, sem relação com o trabalho do DEPLA).
  // badge-fechado (cinza) passou despercebido (pedido do Alex, 2026-09-24:
  // "nao ficou legal, preciso de algo que chame atencao") — badge-alerta-
  // encerramento é laranja e com fonte maior que o badge padrão.
  // Rótulo "Data de Finalização" nessa tela — pedido do Alex, 2026-09-24
  // (só o texto; o dado continua sendo data_encerramento, igual em
  // Lançamento/DFD/Acompanhamento).
  if (vencEl) vencEl.innerHTML = dfdInfo
    ? `<span class="badge badge-alerta-encerramento">Data de Finalização: ${dfdInfo.data_encerramento ? fmtBrData(dfdInfo.data_encerramento) : 'não informado'}</span>`
    : '';
  // Reseta o filtro de setor (dataset.montado força remontar as <option> pra
  // este DFD — sem isso, abrir um 2º DFD reaproveitaria a lista de setores do
  // 1º) e a aba de volta pra "Ativos".
  const setorSel = document.getElementById('consol-filtro-setor');
  setorSel.dataset.montado = '';
  setorSel.value = '';
  document.getElementById('consol-exibir-codigo').checked = false;
  mudarConsolSubtab('ativos');
  await carregarListasConsol();
  await renderConsolidadoDetalhe();
}

// Opções dos <select> das colunas originais (grupo A) quando editáveis
// durante a consolidação (dfd.status === 'consolidado') — mesmo padrão de
// carregarListas() em pac-lancamento.js, cache próprio pra não colidir com
// _listaNatureza (lista fixa, sem relação com dfd_colunas_catalogo).
let _listasCacheConsol = {};
async function carregarListasConsol() {
  const listas = [...new Set((_colunasCatalogo || []).filter(c => c.grupo === 'A' && c.lista).map(c => c.lista))];
  const entradas = await Promise.all(listas.map(async l => {
    const res = await fetch(`/api/pac/parametros?lista=${encodeURIComponent(l)}`);
    return [l, res.ok ? (await res.json()).filter(p => p.ativo) : []];
  }));
  _listasCacheConsol = Object.fromEntries(entradas);
}

function fecharConsolidadoDetalhe() {
  _consolDfdId = null;
  carregarConsolidacaoLista();
}

function mudarConsolSubtab(tab) {
  _consolSubtabAtual = tab;
  document.querySelectorAll('.consol-subtab').forEach(b => b.classList.toggle('active', b.dataset.subtab === tab));
  ['ativos', 'cancelados', 'aguardando'].forEach(t =>
    document.getElementById(`consol-subtab-${t}`).style.display = t === tab ? '' : 'none');
  if (tab === 'cancelados') renderConsolCancelados();
}

async function renderConsolidadoDetalhe() {
  const res = await fetch(`/api/pac/dfds/${_consolDfdId}/consolidado`);
  _consolDados = res.ok ? await res.json() : { itens: [] };

  // DFD com todos os setores já consolidados (dfds.status='fechado', ver M1
  // em routes/pac.js finalizar-consolidacao) — mostra o aviso "Consolidação
  // Finalizada" + Reordenar/Emitir Relatório, mas SEM esconder a tabela de
  // trabalho. Corrigido 2026-09-08: a 1ª versão escondia a tabela inteira
  // quando fechado, e o Alex precisa continuar vendo as colunas originais
  // em tela (não só no relatório impresso) pra conferir como ficou depois
  // de reordenar por classificação — "preciso ver em tela como ficou a
  // reordenação, com todas as colunas originais onde foi feito o trabalho
  // de consolidação".
  const dfdInfo = _dfds.find(d => d.id === _consolDfdId);
  const finalizado = dfdInfo?.status === 'fechado';
  // "Todas as colunas liberadas pra alteração" enquanto o DFD está "Em
  // consolidação" (pedido do Alex, 2026-09-15, 2ª volta: fluxo tem 2
  // momentos — "em_consolidacao" é a fase de trabalho, "consolidado" é o
  // checkpoint já travado de novo, depois de "Finalizar Consolidação") —
  // antes só Natureza/Observação/Status eram editáveis por aqui.
  const editavelConsol = dfdInfo?.status === 'em_consolidacao';
  document.getElementById('consol-finalizado').style.display = finalizado ? 'block' : 'none';
  document.getElementById('consol-corpo-normal').style.display = 'block';
  if (finalizado) {
    document.getElementById('consol-relatorio-numero').textContent = codigoDfd(dfdInfo);
    // Pedido do Alex, 2026-09-15: "DFD uma vez reordenado, não pode ter mais
    // esta opção" — servidor já bloqueia (409), aqui só some o botão.
    const jaReordenado = !!dfdInfo?.reordenado_em;
    document.getElementById('consol-btn-reordenar').style.display = jaReordenado ? 'none' : '';
    document.getElementById('consol-reordenar-feito').style.display = jaReordenado ? 'inline' : 'none';
  }

  // Filtro por setor — populado com os setores que realmente têm item aqui.
  const setorSel = document.getElementById('consol-filtro-setor');
  const setoresUnicos = [...new Map(_consolDados.itens.map(i => [i.setor_id, i.setor_nome])).entries()];
  if (!setorSel.dataset.montado) {
    setorSel.innerHTML = `<option value="">Todos</option>` + setoresUnicos.map(([id, nome]) => `<option value="${id}">${nome}</option>`).join('');
    setorSel.dataset.montado = '1';
  }
  const filtroSetor = setorSel.value;
  const exibirCodigo = document.getElementById('consol-exibir-codigo').checked;

  // Colunas do DFD (mesmas de Lançamento, uma a uma — inclusive Tipo e
  // Subitem separados, não mais numa coluna combinada) + badge de Contrato,
  // clicável e só-leitura. Pedido do Alex, 2026-09-06: fiel ao processo do
  // gestor, largura resolvida pela barra de rolagem que a tabela já tem.
  const colunasDfd = (_colunasCatalogo || []).filter(c => c.grupo === 'A' && c.slug !== 'numero_item');
  const colunasContrato = (_colunasCatalogo || []).filter(c => c.grupo === 'C');
  const temContrato = colunasContrato.length > 0;
  const todasColunas = _colunasCatalogo || [];

  const itens = _consolDados.itens.filter(i => !filtroSetor || String(i.setor_id) === filtroSetor);
  const ativos = itens.filter(i => i.status_consolidacao !== 'cancelado');

  const totalColunas = 1 + (exibirCodigo ? 1 : 0) + colunasDfd.length + (temContrato ? 1 : 0) + 4;
  const thead = document.getElementById('consol-itens-thead');
  thead.innerHTML = `<tr>
    <th>Nº PAC</th>${exibirCodigo ? '<th>ID PAC</th>' : ''}
    ${colunasDfd.map(c => `<th>${c.label}</th>`).join('')}${temContrato ? '<th>Contrato</th>' : ''}
    <th>Natureza</th><th>Observação</th><th>Status</th><th></th>
  </tr>`;

  // Agrupado visualmente por setor (setores.ordem já vem aplicado do servidor
  // em ORDER BY, então só precisa detectar troca de setor_id na sequência).
  const linhas = [];
  let setorAtual = null;
  ativos.forEach(item => {
    if (item.setor_id !== setorAtual) {
      setorAtual = item.setor_id;
      const doSetor = itens.filter(i => i.setor_id === setorAtual); // ativos + cancelados desse setor
      const pendentes = doSetor.filter(i => !['finalizado', 'cancelado'].includes(i.status_consolidacao)).length;
      linhas.push(`<tr class="consol-setor-header"><td colspan="${totalColunas}">
        ${item.setor_nome}
        ${pendentes === 0
          ? `<button class="btn btn-primary btn-xs" style="margin-left:10px;" onclick="finalizarConsolidacaoSetor(${setorAtual})">DFD Finalizado</button>`
          : `<span class="text-muted" style="font-weight:400;margin-left:10px;font-size:11.5px;">${pendentes} item(ns) pendente(s)</span>`}
      </td></tr>`);
    }
    const v = item.valores || {};
    _itensPorId[item.id] = item;
    linhas.push(`<tr class="consol-linha st-${item.status_consolidacao}" data-item-id="${item.id}">
      <td><strong>${item.numero_pac ?? '—'}</strong></td>
      ${exibirCodigo ? `<td>${item.codigo_pac || '—'}</td>` : ''}
      ${colunasDfd.map(c => editavelConsol ? renderCelulaConsolEditavel(item, c) : `<td>${formatarValorColuna(c, v[c.id])}</td>`).join('')}
      ${temContrato ? celulaContratoLeitura(item, colunasContrato, todasColunas, item.id) : ''}
      <td>
        <select class="consol-natureza-select" onchange="salvarNaturezaConsolidacao(${item.id}, this.value)">
          <option value=""${!item.natureza_consolidacao ? ' selected' : ''}>—</option>
          ${_listaNatureza.map(n => `<option value="${n.valor.replace(/"/g, '&quot;')}"${item.natureza_consolidacao === n.valor ? ' selected' : ''}>${n.valor}</option>`).join('')}
        </select>
      </td>
      <td><input type="text" class="consol-obs-input" value="${(item.observacao_consolidacao || '').replace(/"/g, '&quot;')}" placeholder="—" onblur="salvarObservacaoConsolidacao(${item.id}, this.value)" /></td>
      <td style="white-space:nowrap;">
        ${String(item.natureza_consolidacao || '').trim()
          ? `<button type="button" class="btn btn-secondary btn-xs" style="padding:2px 7px;margin-right:6px;" onclick="abrirOrcamentarioDoDfd(_consolDfdId, '${item.natureza_consolidacao.replace(/'/g, "\\'")}')" title="Orçamento x gastos deste DFD">📊</button>`
          : ''}
        ${badgeStatusConsolidacao(item.status_consolidacao)}
      </td>
      <td style="text-align:right;white-space:nowrap;">
        ${item.status_consolidacao !== 'finalizado'
          ? `<button class="btn btn-primary btn-xs" onclick="alterarStatusConsolidacao(${item.id},'finalizado')">Finalizada</button>`
          : ''}
        <button class="btn btn-danger btn-xs" onclick="cancelarPac(${item.id})">Cancelar</button>
      </td>
    </tr>`);
  });

  document.getElementById('consol-itens-tbody').innerHTML = linhas.join('')
    || `<tr><td colspan="${totalColunas}" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item ativo.</td></tr>`;

  if (_consolSubtabAtual === 'cancelados') renderConsolCancelados();
}

function badgeStatusConsolidacao(status) {
  const map = { nao_iniciado: 'Não iniciado', em_analise: 'Em análise', finalizado: 'Consolidação finalizada', cancelado: 'Cancelado' };
  const cor = { nao_iniciado: 'fechado', em_analise: 'analise', finalizado: 'aberto', cancelado: 'fechado' }[status] || 'fechado';
  return `<span class="badge badge-${cor}">${map[status] || status}</span>`;
}

/* ── Colunas originais editáveis durante a consolidação (dfd.status ===
   'em_consolidacao') — pedido do Alex, 2026-09-15. Mesmos tipos de campo do
   catálogo (select/textarea/moeda/numero/data/texto), mesma ideia de
   renderInputCelula em pac-lancamento.js, salvando por
   PUT /api/pac/consolidacao/itens/:id/valores (edição pela Gestão, sem
   vínculo de setor). ── */
function _consolFmtMoeda(v) {
  if (v === null || v === undefined || v === '') return '';
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function _consolParseMoeda(s) {
  if (!s || s === '') return null;
  const v = parseFloat(String(s).replace(/[R$\s.]/g, '').replace(',', '.'));
  return isNaN(v) ? null : v;
}

function renderCelulaConsolEditavel(item, coluna) {
  const valor = (item.valores || {})[coluna.id];
  const attrs = `data-item="${item.id}" data-coluna="${coluna.id}" data-tipo="${coluna.tipo_input}" class="filtro-moderno"`;
  if (coluna.tipo_input === 'auto') return `<td>${valor ?? ''}</td>`;
  // Fonte pagadora rateada (JSON) fica só leitura aqui — editar via um select
  // simples sobrescreveria o rateio inteiro por um valor único sem querer;
  // quem edita rateio é sempre o gestor, em Lançamento (botão "⚖").
  if (coluna.slug === 'fonte_pagadora' && parseRateioFonte(valor)) {
    return `<td><span style="font-size:12.5px;" title="Rateio definido em Lançamento — edite lá pra manter o percentual.">${textoRateioFonte(valor)}</span></td>`;
  }
  if (coluna.tipo_input === 'select') {
    const opcoes = (_listasCacheConsol[coluna.lista] || []).map(o =>
      `<option value="${o.valor.replace(/"/g, '&quot;')}"${o.valor === valor ? ' selected' : ''}>${o.valor}</option>`).join('');
    // Fonte Pagadora ganha o mesmo botão "⚖" de Lançamento pra ratear entre
    // 2+ fontes por percentual — pedido do Alex, 2026-09-17.
    if (coluna.slug === 'fonte_pagadora') {
      const btnRateio = `<button type="button" class="btn btn-secondary btn-xs" style="padding:2px 7px;flex-shrink:0;" onclick="abrirModalRateioFonteConsol(${item.id},${coluna.id})" title="Ratear entre mais de uma fonte pagadora">⚖</button>`;
      return `<td><div style="display:flex;align-items:center;gap:6px;"><select ${attrs} style="width:85px;flex-shrink:0;" onchange="salvarCampoConsolidacao(this)"><option value="">—</option>${opcoes}</select>${btnRateio}</div></td>`;
    }
    return `<td><select ${attrs} style="min-width:110px;" onchange="salvarCampoConsolidacao(this)"><option value="">—</option>${opcoes}</select></td>`;
  }
  if (coluna.tipo_input === 'textarea') {
    return `<td><textarea ${attrs} rows="1" style="min-width:180px;" readonly onclick="abrirCampoExpandido(this,'${coluna.label.replace(/'/g, "\\'")}')" onblur="salvarCampoConsolidacao(this)">${valor || ''}</textarea></td>`;
  }
  if (coluna.tipo_input === 'moeda') {
    return `<td><input type="text" ${attrs} value="${valor != null ? _consolFmtMoeda(valor) : ''}" style="width:100px;text-align:right;" onblur="salvarCampoConsolidacao(this)" /></td>`;
  }
  if (coluna.tipo_input === 'numero') {
    return `<td><input type="number" ${attrs} value="${valor ?? ''}" step="any" style="width:80px;" onblur="salvarCampoConsolidacao(this)" /></td>`;
  }
  if (coluna.tipo_input === 'data') {
    return `<td><input type="date" ${attrs} value="${valor || ''}" style="width:135px;" onchange="salvarCampoConsolidacao(this)" /></td>`;
  }
  return `<td><input type="text" ${attrs} value="${valor || ''}" style="min-width:120px;" onblur="salvarCampoConsolidacao(this)" /></td>`;
}

async function salvarCampoConsolidacao(el) {
  const itemId = el.dataset.item;
  const colunaId = el.dataset.coluna;
  const tipo = el.dataset.tipo;
  let valor = el.value;
  if (tipo === 'moeda') { const n = _consolParseMoeda(valor); valor = n == null ? '' : String(n); el.value = valor === '' ? '' : _consolFmtMoeda(n); }
  try {
    const res = await fetch(`/api/pac/consolidacao/itens/${itemId}/valores`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valores: { [colunaId]: valor === '' ? null : valor } }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      toast(e.error || 'Erro ao salvar campo', 'error');
      return;
    }
    const item = (_consolDados?.itens || []).find(i => i.id === Number(itemId));
    if (item) { item.valores = item.valores || {}; item.valores[colunaId] = valor === '' ? null : valor; }
    toast('Campo salvo', 'success');
  } catch {
    toast('Erro ao salvar campo', 'error');
  }
}

function renderConsolCancelados() {
  if (!_consolDados) return;
  const filtroSetor = document.getElementById('consol-filtro-setor').value;
  const cancelados = _consolDados.itens.filter(i => i.status_consolidacao === 'cancelado' && (!filtroSetor || String(i.setor_id) === filtroSetor));
  const idDescricao = colunaId('descricao_objeto');
  document.getElementById('consol-cancelados-tbody').innerHTML = cancelados.map(item => `
    <tr>
      <td><strong>${item.numero_pac ?? '—'}</strong></td>
      <td>${item.setor_nome}</td>
      <td>${(item.valores || {})[idDescricao] || '—'}</td>
      <td>${item.justificativa_cancelamento || '—'}</td>
      <td>${item.cancelado_por_username || '—'}</td>
      <td>${fmtBrData(item.cancelado_em)}</td>
    </tr>
  `).join('') || `<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item cancelado.</td></tr>`;
}

// Reordena numero_pac por classificação (Tipo/Subitem/Natureza) — pedido do
// Alex, 2026-09-08. Só aparece no bloco "Consolidação Finalizada" (dfd já
// fechado), então não precisa confirmar 2x feito sem querer — mas mexe em
// numero_pac de verdade, então avisa antes.
async function reordenarPorClassificacao() {
  if (!confirm('Isso vai renumerar o Nº PAC de todos os itens deste DFD, agrupando por classificação (Tipo/Subitem/Natureza) em vez da ordem por setor. Continuar?')) return;
  try {
    const res = await fetch(`/api/pac/dfds/${_consolDfdId}/reordenar-por-classificacao`, { method: 'POST' });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    toast('Nº PAC reordenado por classificação.', 'success');
    renderConsolidadoDetalhe();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

// Relatório do DFD finalizado — reaproveita _consolDados (já carregado por
// renderConsolidadoDetalhe antes de decidir mostrar o bloco "finalizado") e
// as mesmas colunas/agrupamento por setor da tabela de Consolidação, só que
// sem ações (é só leitura, pra imprimir). Layout definitivo do relatório
// fica pra uma rodada própria — combinado com o Alex, 2026-09-08.
function abrirRelatorioDfd() {
  const dfdInfo = _dfds.find(d => d.id === _consolDfdId);
  document.getElementById('relatorio-dfd-subtitulo').textContent =
    `${codigoDfd(dfdInfo)} — ${dfdInfo?.titulo || ''} — Consolidação finalizada`;

  const colunasDfd = (_colunasCatalogo || []).filter(c => c.grupo === 'A' && c.slug !== 'numero_item');
  const colunasContrato = (_colunasCatalogo || []).filter(c => c.grupo === 'C');
  const temContrato = colunasContrato.length > 0;
  const totalColunas = 2 + colunasDfd.length + (temContrato ? 1 : 0); // Nº PAC + Natureza + colunasDfd + Contrato
  document.getElementById('relatorio-dfd-thead').innerHTML = `<tr>
    <th>Nº PAC</th><th>Natureza</th>${colunasDfd.map(c => `<th>${c.label}</th>`).join('')}${temContrato ? '<th>Contrato</th>' : ''}
  </tr>`;

  const ativos = (_consolDados?.itens || []).filter(i => i.status_consolidacao !== 'cancelado');
  const linhas = [];
  let setorAtual = null;
  ativos.forEach(item => {
    if (item.setor_id !== setorAtual) {
      setorAtual = item.setor_id;
      linhas.push(`<tr><td colspan="${totalColunas}" style="font-weight:600;background:var(--surface-2);">${item.setor_nome}</td></tr>`);
    }
    const v = item.valores || {};
    linhas.push(`<tr>
      <td><strong>${item.numero_pac ?? '—'}</strong></td>
      <td>${item.natureza_consolidacao || '—'}</td>
      ${colunasDfd.map(c => `<td>${formatarValorColuna(c, v[c.id])}</td>`).join('')}
      ${temContrato ? celulaContratoLeitura(item, colunasContrato, _colunasCatalogo || [], item.id) : ''}
    </tr>`);
  });
  document.getElementById('relatorio-dfd-tbody').innerHTML = linhas.join('')
    || `<tr><td colspan="${totalColunas}" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item ativo.</td></tr>`;

  document.getElementById('modal-relatorio-dfd').classList.add('open');
}

function fecharRelatorioDfd() {
  document.getElementById('modal-relatorio-dfd').classList.remove('open');
}

// idColunaCache: dfd_colunas_catalogo é fixo (mesmo catálogo pra todos os DFDs)
// — resolvido 1x no carregamento da página em vez de bater no back a cada render.
let _colunasCatalogo = null;
function colunaId(slug) {
  if (!_colunasCatalogo) return null; // ainda não carregado — chamadores tratam undefined normalmente
  const c = _colunasCatalogo.find(x => x.slug === slug);
  return c ? c.id : null;
}
(async () => {
  try {
    const res = await fetch('/api/pac/colunas');
    _colunasCatalogo = res.ok ? await res.json() : [];
  } catch { _colunasCatalogo = []; }
})();

// Lista de Natureza (dfd_parametros_lista, lista='natureza') — igual
// Tipo/Subitem/Prioridade, o DEPLA gerencia em Parâmetros; carregada 1x aqui
// pro <select> de Natureza em Consolidação (natureza_consolidacao NÃO passa
// pelo mecanismo de dfd_colunas_catalogo — ver database.js, 2026-09-08).
let _listaNatureza = [];
(async () => {
  try {
    const res = await fetch('/api/pac/parametros?lista=natureza');
    _listaNatureza = res.ok ? (await res.json()).filter(p => p.ativo) : [];
  } catch { _listaNatureza = []; }
})();

async function alterarStatusConsolidacao(itemId, status) {
  try {
    const res = await fetch(`/api/pac/itens/${itemId}/consolidacao`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    toast('Status atualizado.');
    renderConsolidadoDetalhe();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

async function cancelarPac(itemId) {
  const justificativa = prompt('Justificativa do cancelamento (obrigatória):');
  if (justificativa === null || !justificativa.trim()) return;
  try {
    const res = await fetch(`/api/pac/itens/${itemId}/consolidacao`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelado', justificativa: justificativa.trim() }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    toast('Item cancelado.');
    renderConsolidadoDetalhe();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

async function salvarObservacaoConsolidacao(itemId, valor) {
  try {
    await fetch(`/api/pac/itens/${itemId}/observacao-consolidacao`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ observacao: valor }),
    });
  } catch { toast('Erro ao salvar observação', 'error'); }
}

async function salvarNaturezaConsolidacao(itemId, valor) {
  try {
    await fetch(`/api/pac/itens/${itemId}/natureza-consolidacao`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ natureza: valor }),
    });
    // Re-renderiza pra liberar o botão "Finalizada" e mostrar o ícone "📊" de
    // orçamento assim que a Natureza é preenchida, sem precisar de F5.
    renderConsolidadoDetalhe();
  } catch { toast('Erro ao salvar natureza', 'error'); }
}

async function finalizarConsolidacaoSetor(setorId) {
  if (!confirm('Isso vai reordenar a numeração final do DFD (excluindo os itens cancelados da sequência ativa). Continuar?')) return;
  try {
    const res = await fetch(`/api/pac/dfds/${_consolDfdId}/setores/${setorId}/finalizar-consolidacao`, { method: 'POST' });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    toast('Consolidação do setor finalizada — numeração reordenada.');
    renderConsolidadoDetalhe();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

/* ── Tela orçamentária do PAC (pedido do Alex, 2026-09-24) ───────────────────
   2 pontos de entrada: (1) ícone "📊" na Consolidação, ao lado da Natureza de
   UM item (só depois dela preenchida) — vai direto pro resumo com aquela
   natureza em destaque; (2) botão "📊 Orçamento" na aba DFDs (Configurações),
   que oferece escolher entre "Orçamento Consolidado" (resumo por natureza,
   igual o da Consolidação) e "Resumo por Setor e PAC" (todos os itens com
   natureza, de uma vez, sem precisar abrir natureza por natureza). Ambos
   usam o MESMO modal/estado (_orcpacDfdId, não mais preso a _consolDfdId da
   Consolidação — precisa funcionar a partir das 2 telas). */
let _orcpacDfdId = null;
let _orcpacLinhas = [];
let _orcpacTodosItens = [];

function mostrarViewOrcamentario(view) {
  ['resumo', 'detalhe', 'porsetor'].forEach(v =>
    document.getElementById(`orcpac-view-${v}`).style.display = v === view ? '' : 'none');
}

// natureza: quando aberto a partir do ícone "📊" de UM item específico
// (pedido do Alex, 2026-09-24: "a primeira linha sempre devera ser do pac
// da linha da consolidação para facilitar a apuração") — essa natureza sobe
// pro topo da lista, com destaque visual, em vez de ficar perdida na ordem
// alfabética/de cadastro.
async function abrirOrcamentarioDoDfd(dfdId, natureza) {
  _orcpacDfdId = dfdId;
  const modal = document.getElementById('modal-orcamentario');
  document.getElementById('orcpac-resumo-linhas').innerHTML = '<div class="text-muted" style="padding:12px;">Carregando...</div>';
  mostrarViewOrcamentario('resumo');
  modal.classList.add('open');
  try {
    const [dfdRes, orcRes] = await Promise.all([
      fetch(`/api/pac/dfds/${_orcpacDfdId}`),
      fetch(`/api/pac/dfds/${_orcpacDfdId}/orcamento`),
    ]);
    const dfd = dfdRes.ok ? await dfdRes.json() : {};
    if (!orcRes.ok) { const e = await orcRes.json().catch(() => ({})); throw new Error(e.error || 'Erro ao carregar orçamento'); }
    _orcpacLinhas = await orcRes.json();
    if (natureza) {
      const idx = _orcpacLinhas.findIndex(l => l.natureza === natureza);
      if (idx > 0) _orcpacLinhas.unshift(_orcpacLinhas.splice(idx, 1)[0]);
    }
    document.getElementById('orcpac-resumo-sub').textContent = `Orçamento: ${dfd.orcamento_nome || '—'}`;
    renderResumoOrcamentario(natureza);
  } catch (e) {
    document.getElementById('orcpac-resumo-linhas').innerHTML = `<div style="padding:12px;color:#c0392b;">${e.message}</div>`;
  }
}

function renderResumoOrcamentario(naturezaDestaque) {
  document.getElementById('orcpac-resumo-linhas').innerHTML = _orcpacLinhas.map(l => {
    const saldo = l.valor_orcado - l.valor_usado;
    const positivo = saldo >= 0;
    const pct = l.valor_orcado > 0 ? (l.valor_usado / l.valor_orcado) * 100 : (l.valor_usado > 0 ? Infinity : 0);
    const destaque = l.natureza === naturezaDestaque;
    const classeStatus = positivo ? 'positivo' : 'negativo';
    const saldoTxt = (saldo < 0 ? '-R$ ' : 'R$ ') + _consolFmtMoeda(Math.abs(saldo));
    return `
      <div class="orcpac-linha${!positivo ? ' estourou' : ''}"${destaque ? ' style="border:2px solid var(--laranja, #F9A800);"' : ''} title="${pct === Infinity ? '—' : pct.toFixed(1) + '% do orçamento usado'}">
        <div class="orcpac-nome">${l.natureza}</div>
        <div class="orcpac-valores">
          <div class="orcpac-valor-col orcado"><span class="lbl">Orçado</span><span class="val">R$ ${_consolFmtMoeda(l.valor_orcado)}</span></div>
          <div class="orcpac-valor-col usado"><span class="lbl">Usado</span><span class="val ${classeStatus}">R$ ${_consolFmtMoeda(l.valor_usado)}</span></div>
          <div class="orcpac-valor-col saldo"><span class="lbl">Saldo</span><span class="val ${classeStatus}">${saldoTxt}</span></div>
        </div>
        <button type="button" class="btn btn-secondary btn-xs" onclick="abrirDetalheNaturezaOrcamentaria('${l.natureza.replace(/'/g, "\\'")}')">Quem soma</button>
      </div>`;
  }).join('') || '<div class="text-muted" style="padding:12px;">Este orçamento não tem nenhuma natureza cadastrada.</div>';
}

async function abrirDetalheNaturezaOrcamentaria(natureza) {
  document.getElementById('orcpac-detalhe-titulo').textContent = natureza;
  const tbody = document.getElementById('orcpac-detalhe-tbody');
  tbody.innerHTML = `<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--text-subtle);">Carregando...</td></tr>`;
  mostrarViewOrcamentario('detalhe');
  try {
    const res = await fetch(`/api/pac/dfds/${_orcpacDfdId}/orcamento/itens?natureza=${encodeURIComponent(natureza)}`);
    const itens = res.ok ? await res.json() : [];
    tbody.innerHTML = itens.map(i => `
      <tr>
        <td>${i.setor_nome}</td>
        <td>${i.numero_pac ?? '—'}</td>
        <td>${i.descricao || '—'}</td>
        <td style="text-align:right;">R$ ${_consolFmtMoeda(i.valor)}</td>
      </tr>`).join('') || `<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--text-subtle);">Nenhum item com esta natureza.</td></tr>`;
  } catch {
    tbody.innerHTML = `<tr><td colspan="4" style="padding:16px;text-align:center;color:#c0392b;">Erro ao carregar.</td></tr>`;
  }
}

function voltarResumoOrcamentario() {
  mostrarViewOrcamentario('resumo');
}

function fecharModalOrcamentario() {
  document.getElementById('modal-orcamentario').classList.remove('open');
}

// "Tela 2" — Resumo por Setor e PAC (pedido do Alex, 2026-09-24): todos os
// itens com natureza preenchida deste DFD, de uma vez, agrupados por
// natureza (cabeçalho por grupo, igual Consolidação agrupa por setor) —
// evita ter que abrir "Quem soma" natureza por natureza pra ver o total.
async function abrirResumoPorSetorOrcamento(dfdId) {
  _orcpacDfdId = dfdId;
  const modal = document.getElementById('modal-orcamentario');
  const wrap = document.getElementById('orcpac-porsetor-linhas');
  wrap.innerHTML = '<div class="text-muted" style="padding:12px;">Carregando...</div>';
  mostrarViewOrcamentario('porsetor');
  modal.classList.add('open');
  try {
    const [dfdRes, itensRes] = await Promise.all([
      fetch(`/api/pac/dfds/${_orcpacDfdId}`),
      fetch(`/api/pac/dfds/${_orcpacDfdId}/orcamento/itens`),
    ]);
    const dfd = dfdRes.ok ? await dfdRes.json() : {};
    if (!itensRes.ok) throw new Error('Erro ao carregar itens');
    _orcpacTodosItens = await itensRes.json();
    document.getElementById('orcpac-porsetor-sub').textContent = `Orçamento: ${dfd.orcamento_nome || '—'}`;
    renderPorSetorOrcamento();
  } catch (e) {
    wrap.innerHTML = `<div style="padding:12px;color:#c0392b;">${e.message}</div>`;
  }
}

function renderPorSetorOrcamento() {
  const wrap = document.getElementById('orcpac-porsetor-linhas');
  if (!_orcpacTodosItens.length) {
    wrap.innerHTML = '<div class="text-muted" style="padding:12px;">Nenhum item com Natureza preenchida ainda neste DFD.</div>';
    return;
  }
  const linhas = [];
  let naturezaAtual = null;
  let subtotal = 0;
  const fecharGrupo = () => { if (naturezaAtual !== null) linhas.push(`<tr class="orcpac-subtotal"><td colspan="3" style="text-align:right;">Subtotal ${naturezaAtual}:</td><td style="text-align:right;">R$ ${_consolFmtMoeda(subtotal)}</td></tr>`); };
  _orcpacTodosItens.forEach(i => {
    if (i.natureza !== naturezaAtual) {
      fecharGrupo();
      naturezaAtual = i.natureza; subtotal = 0;
      linhas.push(`<tr class="orcpac-grupo-header"><td colspan="4">${i.natureza}</td></tr>`);
    }
    subtotal += Number(i.valor) || 0;
    linhas.push(`
      <tr>
        <td>${i.setor_nome}</td>
        <td>${i.numero_pac ?? '—'}</td>
        <td>${i.descricao || '—'}</td>
        <td style="text-align:right;">R$ ${_consolFmtMoeda(i.valor)}</td>
      </tr>`);
  });
  fecharGrupo();
  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Setor</th><th>Nº PAC</th><th>Descrição</th><th style="text-align:right;">Valor</th></tr></thead>
    <tbody>${linhas.join('')}</tbody>
  </table></div>`;
}

/* ── Escolha de tela orçamentária a partir da aba DFDs (pedido do Alex,
   2026-09-24: "junto de configuração o gráfico do orçamento... trará a
   escolha de 2 tipo de tela") — na Consolidação o ícone "📊" já vai direto
   pro resumo (contexto de 1 item já dá a natureza); aqui, sem um item de
   partida, pergunta qual das 2 telas abrir. */
function abrirEscolhaOrcamentoDfd() {
  if (!_dfdAtualOrcamentoId) {
    toast('Defina o orçamento deste DFD em "⚙️ Configurações" primeiro.', 'error');
    return;
  }
  document.getElementById('modal-orcamento-escolha').classList.add('open');
}
function fecharEscolhaOrcamentoDfd() {
  document.getElementById('modal-orcamento-escolha').classList.remove('open');
}
function escolherTelaOrcamento(tipo) {
  fecharEscolhaOrcamentoDfd();
  if (tipo === 'consolidado') abrirOrcamentarioDoDfd(_dfdAtualId);
  else abrirResumoPorSetorOrcamento(_dfdAtualId);
}

/* ── Solicitações de contratação ─────────────────────────────────────────── */

let _solItensDoDfd = [];
let _solEditandoId = null;

async function carregarSolicitacoes() {
  const dfdId = document.getElementById('sol-dfd-select').value;
  if (!dfdId) return;
  cancelarEdicaoSolicitacao();

  try {
    const itensRes = await fetch(`/api/pac/dfds/${dfdId}/itens`);
    _solItensDoDfd = itensRes.ok ? await itensRes.json() : [];
    const idDescricao = colunaId('descricao_objeto');
    const itemSel = document.getElementById('sol-item-select');
    itemSel.innerHTML = '<option value="">— selecione o item —</option>' + _solItensDoDfd.map(i =>
      `<option value="${i.id}">${i.numero_pac || ('#' + i.numero_item)} — ${(i.valores[idDescricao] || 'sem descrição').substring(0, 60)}</option>`
    ).join('');
  } catch {}

  try {
    const res = await fetch(`/api/pac/dfds/${dfdId}/solicitacoes`);
    const solicitacoes = res.ok ? await res.json() : [];
    const contagemPorItem = {};
    solicitacoes.filter(s => !s.sem_pac).forEach(s => { contagemPorItem[s.item_id] = (contagemPorItem[s.item_id] || 0) + 1; });

    document.getElementById('sol-com-pac-tbody').innerHTML = solicitacoes.filter(s => !s.sem_pac).map(s => `
      <tr>
        <td><strong>${s.numero_pac || '—'}</strong>${contagemPorItem[s.item_id] > 1 ? `<span class="pac-cnt-solic">${contagemPorItem[s.item_id]}</span>` : ''}</td>
        <td>${s.numero_movimento || '—'}</td>
        <td>${s.numero_sei || '—'}</td>
        <td>${fmtBrData(s.data_requisicao)}</td>
        <td>${nomeSetorPac(s.setor_requisitante_id)}</td>
        <td>${fmtMoeda(s.valor_tu_mlp)}</td>
        <td>${fmtMoeda(s.valor_rdc)}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="editarSolicitacao(${s.id})">Editar</button>
          <button class="btn btn-danger btn-sm" onclick="excluirSolicitacao(${s.id})">Excluir</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="8" style="padding:16px;text-align:center;color:var(--text-subtle);">Nenhuma solicitação vinculada.</td></tr>`;

    document.getElementById('sol-sem-pac-tbody').innerHTML = solicitacoes.filter(s => s.sem_pac).map(s => `
      <tr>
        <td>${s.numero_movimento || '—'}</td>
        <td>${s.numero_sei || '—'}</td>
        <td>${fmtBrData(s.data_requisicao)}</td>
        <td>${nomeSetorPac(s.setor_requisitante_id)}</td>
        <td>${s.descricao_objeto || '—'}</td>
        <td>${fmtMoeda(s.valor_tu_mlp)}</td>
        <td>${fmtMoeda(s.valor_rdc)}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="editarSolicitacao(${s.id})">Editar</button>
          <button class="btn btn-danger btn-sm" onclick="excluirSolicitacao(${s.id})">Excluir</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="7" style="padding:16px;text-align:center;color:var(--text-subtle);">Nenhuma contratação não planejada.</td></tr>`;

    window._solicitacoesCache = solicitacoes;
  } catch {
    toast('Erro ao carregar solicitações', 'error');
  }
}

function nomeSetorPac(id) {
  const s = (_solSetoresCache || []).find(x => x.id === id);
  return s ? s.nome : (id ? `#${id}` : '—');
}
let _solSetoresCache = [];
(async () => {
  try { const r = await fetch('/api/pac/setores'); _solSetoresCache = r.ok ? await r.json() : []; } catch {}
})();

function solAtualizarVinculo() {
  const semPac = document.getElementById('sol-sem-pac').checked;
  document.getElementById('sol-vinculo-wrap').style.display = semPac ? 'none' : '';
  if (semPac) document.getElementById('sol-item-select').value = '';
}

function limparFormSolicitacao() {
  document.getElementById('sol-sem-pac').checked = false;
  solAtualizarVinculo();
  document.getElementById('sol-item-select').value = '';
  document.getElementById('sol-numero-movimento').value = '';
  document.getElementById('sol-numero-sei').value = '';
  document.getElementById('sol-data-requisicao').value = '';
  document.getElementById('sol-valor-tu-mlp').value = '';
  document.getElementById('sol-valor-rdc').value = '';
  document.getElementById('sol-descricao').value = '';
  document.getElementById('sol-observacao').value = '';
}

function cancelarEdicaoSolicitacao() {
  _solEditandoId = null;
  document.getElementById('sol-btn-salvar').textContent = '+ Registrar solicitação';
  document.getElementById('sol-btn-cancelar').style.display = 'none';
  limparFormSolicitacao();
  document.getElementById('sol-msg').textContent = '';
}

function editarSolicitacao(id) {
  const s = (window._solicitacoesCache || []).find(x => x.id === id);
  if (!s) return;
  _solEditandoId = id;
  document.getElementById('sol-sem-pac').checked = !s.item_id;
  solAtualizarVinculo();
  document.getElementById('sol-item-select').value = s.item_id || '';
  document.getElementById('sol-numero-movimento').value = s.numero_movimento || '';
  document.getElementById('sol-numero-sei').value = s.numero_sei || '';
  document.getElementById('sol-data-requisicao').value = s.data_requisicao || '';
  document.getElementById('sol-setor-select').value = s.setor_requisitante_id || '';
  document.getElementById('sol-natureza-select').value = s.natureza_orcamentaria || '';
  document.getElementById('sol-valor-tu-mlp').value = s.valor_tu_mlp ? fmtMoeda(s.valor_tu_mlp).replace('R$', '').trim() : '';
  document.getElementById('sol-valor-rdc').value = s.valor_rdc ? fmtMoeda(s.valor_rdc).replace('R$', '').trim() : '';
  document.getElementById('sol-descricao').value = s.descricao_objeto || '';
  document.getElementById('sol-observacao').value = s.observacao || '';
  document.getElementById('sol-btn-salvar').textContent = 'Salvar edição';
  document.getElementById('sol-btn-cancelar').style.display = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function salvarSolicitacao() {
  const dfdId = document.getElementById('sol-dfd-select').value;
  const msg = document.getElementById('sol-msg');
  msg.style.color = '';
  const semPac = document.getElementById('sol-sem-pac').checked;
  const item_id = semPac ? null : (Number(document.getElementById('sol-item-select').value) || null);
  if (!semPac && !item_id) { msg.style.color = '#c00'; msg.textContent = 'Selecione o item do PAC ou marque "Sem vínculo".'; return; }

  const payload = {
    item_id,
    numero_movimento: document.getElementById('sol-numero-movimento').value.trim(),
    numero_sei: document.getElementById('sol-numero-sei').value.trim(),
    data_requisicao: document.getElementById('sol-data-requisicao').value || null,
    setor_requisitante_id: Number(document.getElementById('sol-setor-select').value) || null,
    natureza_orcamentaria: document.getElementById('sol-natureza-select').value || null,
    descricao_objeto: document.getElementById('sol-descricao').value.trim(),
    valor_tu_mlp: parseMoeda(document.getElementById('sol-valor-tu-mlp').value),
    valor_rdc: parseMoeda(document.getElementById('sol-valor-rdc').value),
    observacao: document.getElementById('sol-observacao').value.trim(),
  };

  try {
    const res = _solEditandoId
      ? await fetch(`/api/pac/solicitacoes/${_solEditandoId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      : await fetch(`/api/pac/dfds/${dfdId}/solicitacoes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    msg.style.color = '#2E7D32';
    msg.textContent = _solEditandoId ? 'Solicitação atualizada.' : 'Solicitação registrada.';
    cancelarEdicaoSolicitacao();
    carregarSolicitacoes();
  } catch (e) {
    msg.style.color = '#c00'; msg.textContent = 'Erro: ' + e.message;
  }
}

async function excluirSolicitacao(id) {
  if (!confirm('Excluir esta solicitação?')) return;
  try {
    const res = await fetch(`/api/pac/solicitacoes/${id}`, { method: 'DELETE' });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    carregarSolicitacoes();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

/* ── Acompanhamento (DEPLA — visão completa) ─────────────────────────────── */

let _acompDados = null;
const STATUS_EXECUCAO_OPCOES = ['Não Iniciado', 'Processado DEPLA', 'Fracionamento Aberto', 'Processo Finalizado', 'Cancelado'];

// Flyout de filtros/dados do DFD — mesmo padrão do flyout "Meus pedidos" em
// pac-lancamento.js. Fecha sozinho ao clicar fora.
function alternarFiltrosAcompFlyout() {
  const flyout = document.getElementById('acomp-filtros-flyout');
  flyout.style.display = flyout.style.display === 'none' ? 'block' : 'none';
}
function fecharFiltrosAcompFlyout() {
  document.getElementById('acomp-filtros-flyout').style.display = 'none';
}
document.addEventListener('click', e => {
  const flyout = document.getElementById('acomp-filtros-flyout');
  if (!flyout || flyout.style.display === 'none') return;
  if (flyout.contains(e.target) || e.target.closest('button[onclick="alternarFiltrosAcompFlyout()"]')) return;
  fecharFiltrosAcompFlyout();
});

// Mesma ideia de auto-refresh de pac-lancamento.js (iniciarAutoRefreshKpis)
// — pedido do Alex, 2026-09-08: indicador "morto" sem atualizar sozinho. Só
// re-busca quando a aba Acompanhamento está mesmo visível (offsetParent),
// pra não gastar rede à toa numa aba escondida.
let _acompAutoRefreshTimer = null;
function iniciarAutoRefreshAcompanhamento() {
  if (_acompAutoRefreshTimer) return;
  _acompAutoRefreshTimer = setInterval(() => {
    const detalhe = document.getElementById('acomp-detalhe');
    const dfdId = document.getElementById('acomp-dfd-select')?.value;
    if (detalhe && detalhe.offsetParent !== null && dfdId) carregarAcompanhamento();
  }, 30000);
}
function pararAutoRefreshAcompanhamento() {
  if (_acompAutoRefreshTimer) { clearInterval(_acompAutoRefreshTimer); _acompAutoRefreshTimer = null; }
}

async function carregarAcompanhamento() {
  const dfdId = document.getElementById('acomp-dfd-select').value;
  if (!dfdId) return;
  iniciarAutoRefreshAcompanhamento();
  document.getElementById('acomp-tbody').innerHTML = `<tr><td colspan="14" style="padding:20px;text-align:center;color:var(--text-subtle);">Carregando...</td></tr>`;
  // Vencimento do DFD selecionado — pedido do Alex, 2026-09-07, ver criarDfd()/
  // POST /api/pac/dfds. _dfds já vem carregado por carregarDfds() no boot.
  const dfdSel = _dfds.find(d => d.id === Number(dfdId));
  // Sempre mostra ENCERRAMENTO aqui (pedido do Alex, 2026-09-22, mesma regra
  // de consol-det-vencimento acima).
  document.getElementById('acomp-vencimento').textContent = dfdSel
    ? (dfdSel.data_encerramento ? `Encerramento do DFD: ${fmtBrData(dfdSel.data_encerramento)}` : 'Encerramento do DFD: não informado')
    : '';
  try {
    const res = await fetch(`/api/pac/dfds/${dfdId}/acompanhamento`);
    if (!res.ok) throw new Error();
    _acompDados = await res.json();
    renderTabelaAcompanhamento();
    renderFinalizacaoAcompanhamento(dfdId);
  } catch {
    toast('Erro ao carregar acompanhamento', 'error');
  }
}

// Badges de finalização por setor + botão "Gerar Consolidação" — só some
// depois que a consolidação já existe (nesse ponto o fluxo dela é trabalhado
// na aba Consolidação, não aqui).
async function renderFinalizacaoAcompanhamento(dfdId) {
  const card = document.getElementById('acomp-finalizacao-card');
  try {
    const [statusRes, consRes] = await Promise.all([
      fetch(`/api/pac/dfds/${dfdId}/status-finalizacao`),
      fetch(`/api/pac/dfds/${dfdId}/consolidado`),
    ]);
    const status = statusRes.ok ? await statusRes.json() : { setores: [], todos_finalizados: false };
    const cons = consRes.ok ? await consRes.json() : { consolidado: false };

    renderKpisAcompanhamento(dfdId, status);

    // cons.consolidado sozinho não basta: reabrir um DFD já consolidado e
    // reenviar pra análise NÃO apaga a linha antiga de pac_consolidacoes (só
    // o novo "Iniciar Consolidação" apaga, ver POST /gerar-consolidacao) —
    // só esconder o card quando o status atual confirma que o ciclo está
    // mesmo em andamento/concluído. Bug achado pelo Alex, 2026-09-24: sem
    // isso, "Iniciar Consolidação" nunca mais reaparecia depois de reabrir.
    const dfdAtualStatus = _dfds.find(d => d.id === Number(dfdId))?.status;
    if (cons.consolidado && dfdAtualStatus !== 'analise') { card.style.display = 'none'; return; }
    card.style.display = 'block';

    // Resumo com barra de progresso geral primeiro (pedido do Alex,
    // 2026-09-06: com muitos setores participantes a parede de chips sozinha
    // fica ilegível) — os chips continuam abaixo, focados em apontar quem
    // ainda falta finalizar.
    const total = status.setores.length;
    const finalizados = status.setores.filter(s => s.finalizado_em).length;
    const pct = total ? Math.round((finalizados / total) * 100) : 0;
    document.getElementById('acomp-fin-fracao').textContent = `${finalizados} de ${total} setor(es)`;
    document.getElementById('acomp-fin-pct').textContent = `${pct}%`;
    document.getElementById('acomp-fin-progress-fill').style.width = `${pct}%`;

    document.getElementById('acomp-fin-badges').innerHTML = status.setores.map(s => s.finalizado_em
      ? `<span class="pac-fin-badge ok">✅ ${s.setor_nome} — finalizado em ${fmtBrData(s.finalizado_em)}</span>`
      : `<span class="pac-fin-badge aguardando">🕐 ${s.setor_nome} — aguardando</span>`
    ).join('') || '<span class="text-muted">Este DFD ainda não tem setores participantes.</span>';

    // "Iniciar Consolidação" exige só dfd.status === 'analise' (pedido do
    // Alex, 2026-09-15: não depende mais de "todos os setores finalizaram" —
    // mesma mudança de filosofia da trava de "Enviar para análise", v4.22.5.
    // Antes disso exigir status.todos_finalizados deixava esse botão
    // impossível de aparecer pra qualquer DFD que tivesse chegado em
    // "análise" sem passar por "Finalizar meu DFD"). _dfds já tem .status em
    // cache (recarregado a cada mudança de status, ver mudarStatusDfd).
    const dfdSel = _dfds.find(d => d.id === Number(dfdId));
    const podeConsolidar = dfdSel?.status === 'analise';
    document.getElementById('acomp-gerar-consolidacao-wrap').innerHTML = podeConsolidar
      ? `<button class="btn btn-primary btn-sm" onclick="gerarConsolidacao(${dfdId})">Iniciar Consolidação</button>`
      : '';
  } catch { card.style.display = 'none'; }
}

// Indicadores do DFD selecionado, no topo da aba — pedido do Alex,
// 2026-09-06: "modelos mais atuais incluindo progress bar, não somente cards
// simples". Reaproveita _acompDados (já carregado por renderTabelaAcompanhamento
// antes desta função rodar) + o status de finalização já buscado ao lado.
// Redesenho 2026-09-08 (2ª volta, mesma tarde): Alex mandou print do formato
// que queria de verdade — gráfico de pizza "de tela cheia" (título, fatias
// com % escrito, legenda embaixo), não um ícone pequeno numa linha de texto.
// "Execução dos itens" agora mostra a distribuição completa por
// status_execucao (não só finalizado/pendente) — mesmos helpers
// svgPizzaMulti/svgVelocimetro/cardGrafico duplicados em pac-lancamento.js
// (sem módulo compartilhado novo, mesma convenção de sempre).
const STATUS_EXECUCAO_KPI = [
  { label: 'Não Iniciado', cor: '#c0392b' },
  { label: 'Processado DEPLA', cor: '#d97706' },
  { label: 'Fracionamento Aberto', cor: '#2563eb' },
  { label: 'Processo Finalizado', cor: 'var(--verde, #2E7D32)' },
  { label: 'Cancelado', cor: '#9ca3af' },
];
// 3ª rodada de ajuste (mesma tarde, 2026-09-08) — mesmas mudanças de
// pac-lancamento.js: donut com "X de Y" no miolo (em vez de anel liso que
// "fica em branco" a 100%), legenda em coluna ao lado (não mais embaixo,
// "posição ruim"), velocímetro com faixas de cor fixas.
function svgPizzaMulti(fatias, centroTexto) {
  const total = fatias.reduce((s, f) => s + f.valor, 0) || 1;
  const cx = 90, cy = 90, r = 72, rBuraco = 44;
  const toRad = a => (a * Math.PI) / 180;
  let anguloAtual = -90;
  const paths = [], rotulos = [];
  fatias.forEach(f => {
    const pct = f.valor / total;
    if (pct <= 0) return;
    const anguloFatia = Math.min(pct * 360, 359.999);
    const anguloFim = anguloAtual + anguloFatia;
    const x1 = cx + r * Math.cos(toRad(anguloAtual)), y1 = cy + r * Math.sin(toRad(anguloAtual));
    const x2 = cx + r * Math.cos(toRad(anguloFim)), y2 = cy + r * Math.sin(toRad(anguloFim));
    const largeArc = anguloFatia > 180 ? 1 : 0;
    paths.push(`<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${f.cor}" stroke="var(--surface)" stroke-width="2"></path>`);
    if (pct >= 0.035) {
      const meio = anguloAtual + anguloFatia / 2;
      const lx = cx + (r + rBuraco) / 2 * Math.cos(toRad(meio)), ly = cy + (r + rBuraco) / 2 * Math.sin(toRad(meio));
      rotulos.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="11" font-weight="700" fill="#fff" text-anchor="middle" dominant-baseline="middle" style="paint-order:stroke;stroke:rgba(0,0,0,.35);stroke-width:2px;">${Math.round(pct * 100)}%</text>`);
    }
    anguloAtual = anguloFim;
  });
  const fsCentro = !centroTexto ? 0 : (centroTexto.length > 5 ? 15 : 20);
  const centro = centroTexto
    ? `<circle cx="${cx}" cy="${cy}" r="${rBuraco}" fill="var(--surface)"></circle>
       <text x="${cx}" y="${cy}" font-size="${fsCentro}" font-weight="800" text-anchor="middle" dominant-baseline="middle" fill="var(--text)">${centroTexto}</text>`
    : '';
  return `<svg viewBox="0 0 180 180" width="140" height="140" style="flex-shrink:0;">${paths.join('')}${centro}${rotulos.join('')}</svg>`;
}
function legendaGrafico(fatias) {
  return `<div style="display:flex;flex-direction:column;gap:5px;font-size:12px;text-align:left;">${
    fatias.map(f => `<span style="display:flex;align-items:center;gap:6px;white-space:nowrap;">
      <span style="width:10px;height:10px;border-radius:2px;background:${f.cor};display:inline-block;flex-shrink:0;"></span>${f.label} <strong style="margin-left:auto;padding-left:10px;">${f.valor}</strong>
    </span>`).join('')
  }</div>`;
}
function cardGrafico(titulo, corpoSvg, legenda, fracaoTexto) {
  return `<div class="card" style="flex:1 1 260px;padding:16px;">
    <div style="font-size:13px;font-weight:600;margin-bottom:10px;text-align:center;">${titulo}</div>
    <div style="display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap;">
      ${corpoSvg}
      ${legenda}
    </div>
    ${fracaoTexto ? `<div style="font-size:12px;color:var(--text-muted);margin-top:10px;text-align:center;">${fracaoTexto}</div>` : ''}
  </div>`;
}
function svgVelocimetro(pct) {
  const p = Math.max(0, Math.min(100, pct));
  const raio = 44, cx = 50, cy = 50, L = Math.PI * raio;
  const zonas = [{ ini: 0, fim: 50, cor: '#c0392b' }, { ini: 50, fim: 80, cor: '#d97706' }, { ini: 80, fim: 100, cor: 'var(--verde, #2E7D32)' }];
  const arcoZona = z => {
    const comp = (z.fim - z.ini) / 100 * L, offset = -(z.ini / 100 * L);
    return `<path d="M 6 50 A ${raio} ${raio} 0 0 1 94 50" fill="none" stroke="${z.cor}" stroke-width="10"
      stroke-dasharray="${comp.toFixed(1)} ${L.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></path>`;
  };
  const theta = (180 - (p / 100) * 180) * Math.PI / 180;
  const x2 = cx + 34 * Math.cos(theta), y2 = cy - 34 * Math.sin(theta);
  return `<svg viewBox="0 0 100 68" width="160" height="109" style="flex-shrink:0;">
    ${zonas.map(arcoZona).join('')}
    <line x1="${cx}" y1="${cy}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--text, #222)" stroke-width="2.5" stroke-linecap="round"></line>
    <circle cx="${cx}" cy="${cy}" r="4" fill="var(--text, #222)"></circle>
    <text x="4" y="63" font-size="7" fill="var(--text-muted)">0%</text>
    <text x="96" y="63" font-size="7" fill="var(--text-muted)" text-anchor="end">100%</text>
    <text x="${cx}" y="42" font-size="16" font-weight="800" text-anchor="middle" fill="var(--text)">${p}%</text>
  </svg>`;
}
function renderKpisAcompanhamento(dfdId, status) {
  const wrap = document.getElementById('acomp-kpis');
  if (!_acompDados || !dfdId) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';

  const itens = _acompDados.itens || [];
  const totalSetores = status.setores.length;
  const setoresFinalizados = status.setores.filter(s => s.finalizado_em).length;

  const contagemExecucao = STATUS_EXECUCAO_KPI.map(s => ({
    label: s.label, cor: s.cor, valor: itens.filter(i => i.status_execucao === s.label).length,
  }));
  const itensFinalizados = itens.filter(i => i.status_execucao === 'Processo Finalizado').length;

  const t = _acompDados.totais || { estimado_tu_mlp: 0, estimado_rdc: 0, realizado_tu_mlp: 0, realizado_rdc: 0 };
  const estimadoTotal = t.estimado_tu_mlp + t.estimado_rdc;
  const realizadoTotal = t.realizado_tu_mlp + t.realizado_rdc;
  const pctRealizado = estimadoTotal ? Math.round((realizadoTotal / estimadoTotal) * 100) : 0;

  const fatiasSetores = [
    { label: 'Finalizados', valor: setoresFinalizados, cor: 'var(--verde, #2E7D32)' },
    { label: 'Pendentes', valor: totalSetores - setoresFinalizados, cor: '#c0392b' },
  ];

  wrap.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap;">${
    cardGrafico('Progresso de Setores', svgPizzaMulti(fatiasSetores, `${setoresFinalizados}/${totalSetores}`), legendaGrafico(fatiasSetores), '') +
    cardGrafico('Execução dos itens', svgPizzaMulti(contagemExecucao, `${itensFinalizados}/${itens.length}`), legendaGrafico(contagemExecucao), '') +
    cardGrafico('Valor realizado', svgVelocimetro(pctRealizado), '', `${fmtMoeda(realizadoTotal)} de ${fmtMoeda(estimadoTotal)}`)
  }</div>`;
}

async function gerarConsolidacao(dfdId) {
  if (!confirm('Isso irá gerar a numeração consolidada do PAC, mudar o status do DFD para "Em consolidação" (colunas originais ficam liberadas pra edição) e carregar a tela de Consolidação. Continuar?')) return;
  try {
    const res = await fetch(`/api/pac/dfds/${dfdId}/gerar-consolidacao`, { method: 'POST' });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    toast('Consolidação iniciada.');
    await carregarDfds(); // sincroniza _dfds com o novo status ('em_consolidacao')
    const dfd = _dfds.find(d => d.id === Number(dfdId));
    mudarAbaPac('consolidacao');
    if (dfd) await abrirConsolidadoDetalhe(dfd.id, dfd.titulo, dfd.ano_base);
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

async function alterarStatusExecucao(itemId, status) {
  try {
    const res = await fetch(`/api/pac/itens/${itemId}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status_execucao: status }),
    });
    if (!res.ok) throw new Error();
    toast('Status atualizado.');
  } catch {
    toast('Erro ao atualizar status', 'error');
    carregarAcompanhamento();
  }
}

function renderTabelaAcompanhamento() {
  if (!_acompDados) return;
  const filtroSetor = document.getElementById('acomp-filtro-setor').value;
  const filtroStatus = document.getElementById('acomp-filtro-status').value;
  const filtroFonte = document.getElementById('acomp-filtro-fonte').value;

  const itens = _acompDados.itens.filter(i =>
    (!filtroSetor || String(i.setor_id) === filtroSetor) &&
    (!filtroStatus || i.status_execucao === filtroStatus) &&
    // Fonte rateada entre 2+ (JSON) casa com o filtro se a fonte escolhida
    // fizer parte do rateio, não só no caso de fonte única.
    (!filtroFonte || i.fonte_pagadora === filtroFonte || !!(parseRateioFonte(i.fonte_pagadora) || {})[filtroFonte])
  );

  const linhaSaldo = v => v < 0 ? `<span class="pac-saldo-neg">${fmtMoeda(v)}</span>` : fmtMoeda(v);

  // Colunas do DFD (mesmas de Lançamento, "fiel ao processo do gestor" —
  // pedido explícito do Alex, 2026-09-06: não resumir, a largura se resolve
  // com a barra de rolagem que a tabela já tem). Ficam ENTRE "Setor" e o
  // bloco financeiro que já existia aqui.
  const colunasDfd = (_colunasCatalogo || []).filter(c => c.grupo === 'A' && c.slug !== 'numero_item');
  const colunasContrato = (_colunasCatalogo || []).filter(c => c.grupo === 'C');
  const temContrato = colunasContrato.length > 0;
  const todasColunas = _colunasCatalogo || [];
  const qtdColunasFixas = 4; // toggle, ID PAC, Nº PAC, Setor
  const qtdColunasFinais = 8; // Status, Solic., Real.x2, Saldo x2 já contam 6 + Est.x2 = 8

  document.getElementById('acomp-thead').innerHTML = `<tr>
    <th></th><th>ID PAC</th><th>Nº PAC</th><th>Setor</th>
    ${colunasDfd.map(c => `<th>${c.label}</th>`).join('')}${temContrato ? '<th>Contrato</th>' : ''}
    <th>Est. TU+MLP</th><th>Est. RDC</th><th>Status</th><th>Solic.</th>
    <th>Real. TU+MLP</th><th>Real. RDC</th><th>Saldo TU+MLP</th><th>Saldo RDC</th>
  </tr>`;
  const totalColunas = qtdColunasFixas + colunasDfd.length + (temContrato ? 1 : 0) + qtdColunasFinais;

  document.getElementById('acomp-tbody').innerHTML = itens.map(item => {
    _itensPorId[item.item_id] = item;
    return `
    <tr>
      <td class="acomp-toggle" onclick="toggleAcompLinha(${item.item_id})">${item.solicitacoes.length ? '▸' : ''}</td>
      <td>${item.codigo_pac || '—'}</td>
      <td><strong>${item.numero_pac || '—'}</strong></td>
      <td>${item.setor_nome}</td>
      ${colunasDfd.map(c => `<td>${formatarValorColuna(c, (item.valores || {})[c.id])}</td>`).join('')}
      ${temContrato ? celulaContratoLeitura(item, colunasContrato, todasColunas, item.item_id) : ''}
      <td>${fmtMoeda(item.estimado_tu_mlp)}</td>
      <td>${fmtMoeda(item.estimado_rdc)}</td>
      <td>
        <select onchange="alterarStatusExecucao(${item.item_id}, this.value)">
          ${STATUS_EXECUCAO_OPCOES.map(s => `<option value="${s}" ${s === item.status_execucao ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </td>
      <td>${item.solicitacoes.length}</td>
      <td>${fmtMoeda(item.realizado_tu_mlp)}</td>
      <td>${fmtMoeda(item.realizado_rdc)}</td>
      <td>${linhaSaldo(item.saldo_tu_mlp)}</td>
      <td>${linhaSaldo(item.saldo_rdc)}</td>
    </tr>
    <tr class="acomp-sub-row hidden" id="acomp-sub-${item.item_id}">
      <td colspan="${totalColunas}">
        ${item.solicitacoes.length ? `
          <table style="width:100%;">
            <thead><tr><th>Movimento</th><th>Data</th><th>TU+MLP</th><th>RDC</th><th>Observação</th></tr></thead>
            <tbody>
              ${item.solicitacoes.map(s => `
                <tr>
                  <td>${s.numero_movimento || '—'}</td>
                  <td>${fmtBrData(s.data_requisicao)}</td>
                  <td>${fmtMoeda(s.valor_tu_mlp)}</td>
                  <td>${fmtMoeda(s.valor_rdc)}</td>
                  <td>${s.observacao || '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : '<span class="text-muted">Nenhuma solicitação vinculada.</span>'}
      </td>
    </tr>
  `;
  }).join('') || `<tr><td colspan="${totalColunas}" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item consolidado ainda para este DFD.</td></tr>`;

  const t = itens.reduce((acc, i) => ({
    estimado_tu_mlp: acc.estimado_tu_mlp + i.estimado_tu_mlp, estimado_rdc: acc.estimado_rdc + i.estimado_rdc,
    realizado_tu_mlp: acc.realizado_tu_mlp + i.realizado_tu_mlp, realizado_rdc: acc.realizado_rdc + i.realizado_rdc,
    saldo_tu_mlp: acc.saldo_tu_mlp + i.saldo_tu_mlp, saldo_rdc: acc.saldo_rdc + i.saldo_rdc,
  }), { estimado_tu_mlp: 0, estimado_rdc: 0, realizado_tu_mlp: 0, realizado_rdc: 0, saldo_tu_mlp: 0, saldo_rdc: 0 });
  document.getElementById('acomp-tfoot').innerHTML = `
    <tr>
      <td colspan="${qtdColunasFixas + colunasDfd.length + (temContrato ? 1 : 0)}">Totais (${itens.length} itens)</td>
      <td>${fmtMoeda(t.estimado_tu_mlp)}</td><td>${fmtMoeda(t.estimado_rdc)}</td>
      <td colspan="2"></td>
      <td>${fmtMoeda(t.realizado_tu_mlp)}</td><td>${fmtMoeda(t.realizado_rdc)}</td>
      <td>${linhaSaldo(t.saldo_tu_mlp)}</td><td>${linhaSaldo(t.saldo_rdc)}</td>
    </tr>
  `;

  const semPacCard = document.getElementById('acomp-sem-pac-card');
  const semPac = _acompDados.sem_pac || [];
  semPacCard.style.display = semPac.length ? 'block' : 'none';
  document.getElementById('acomp-sem-pac-tbody').innerHTML = semPac.map(s => `
    <tr>
      <td>${s.numero_movimento || '—'}</td>
      <td>${s.numero_sei || '—'}</td>
      <td>${fmtBrData(s.data_requisicao)}</td>
      <td>${nomeSetorPac(s.setor_requisitante_id)}</td>
      <td>${s.descricao_objeto || '—'}</td>
      <td>${fmtMoeda(s.valor_tu_mlp)}</td>
      <td>${fmtMoeda(s.valor_rdc)}</td>
    </tr>
  `).join('');
}

function toggleAcompLinha(itemId) {
  document.getElementById(`acomp-sub-${itemId}`)?.classList.toggle('hidden');
}
