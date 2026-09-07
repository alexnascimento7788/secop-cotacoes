// PAC — Lançamento: DFDs disponíveis pro(s) setor(es) do usuário e a tabela de
// itens (colunas configuráveis pelo DEPLA, sticky + grupos colapsáveis).

function toast(msg, tipo) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (tipo ? ' ' + tipo : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
}

function fmtBr(iso) {
  if (!iso) return '';
  const d = String(iso).split(/[T ]/)[0].split('-');
  if (d.length < 3) return iso;
  return `${d[2]}/${d[1]}/${d[0]}`;
}
function brParaIso(br) {
  const m = String(br || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
function fmtMoeda(v) {
  if (v === null || v === undefined || v === '') return '';
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function parseMoeda(s) {
  if (!s || s === '') return null;
  const v = parseFloat(String(s).replace(/[R$\s.]/g, '').replace(',', '.'));
  return isNaN(v) ? null : v;
}

function badgeStatusDfd(status) {
  const icone = { aberto: '●', analise: '⚠', fechado: '🔒' };
  const map = { aberto: 'Aberto', analise: 'Em análise', fechado: 'Fechado' };
  return `<span class="badge badge-${status}">${icone[status] || ''} ${map[status] || status}</span>`;
}

// Lê a mensagem de erro real do corpo da resposta (qualquer status, não só
// 409) — sem isso, toda rejeição do backend (403 de setor, 404 de item já
// removido, etc.) virava o mesmo toast genérico "Erro ao X", escondendo o
// motivo de verdade. Corpo pode não ser JSON (ex.: erro 500 cru do Express)
// — nesse caso cai no fallback.
async function mensagemErro(res, fallback) {
  try {
    const e = await res.json();
    return e.error || fallback;
  } catch {
    return fallback;
  }
}

let _dfdAtualId = null;
let _dfdAtual = null;
let _meusSetores = [];
let _pedidosLiberados = {}; // item_id -> Set('editar'|'excluir') aprovados e ainda não consumidos
let _itensAtuais = [];
let _finalizacaoPorSetor = {}; // setor_id -> finalizado_em (ou null)

document.addEventListener('DOMContentLoaded', () => {
  atualizarCabecalhoUsuario();
  atualizarRelogioHeader();
  setInterval(atualizarRelogioHeader, 60 * 1000);
  carregarDfds();
  aplicarAcessoImportacao();
});

// Link "Importação" dentro do galho Gestão da sidebar — acesso é só por role
// (master/admin_sistema, ver routes/pac-importacao.js), não Perfil/Rotina;
// mesma checagem duplicada em pac-gestao.js/pac-acompanhamento.js (cada
// página tem sua própria sidebar, sem componente compartilhado).
let _usuarioPac = null; // guardado pra decidir a válvula de escape do master no bloqueio de pendências (ver renderFinalizacao)

async function aplicarAcessoImportacao() {
  try {
    const user = await window.getCurrentUser();
    _usuarioPac = user;
    const el = document.getElementById('nav-pac-importacao');
    if (el && user && (user.username === 'master' || user.role === 'admin_sistema')) el.style.display = '';
  } catch {}
}

const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function atualizarRelogioHeader() {
  const agora = new Date();
  const hora = document.getElementById('pac-lanc-hora');
  if (hora) hora.textContent = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
  const data = document.getElementById('pac-lanc-data');
  if (data) data.textContent = `${String(agora.getDate()).padStart(2, '0')}/${MESES_PT[agora.getMonth()]}/${agora.getFullYear()}`;
}

// Foto (mesmo endpoint que a sidebar já usa) ou, sem foto, iniciais do nome
// sobre fundo na cor do módulo — o avatar sai da sidebar e vive só aqui
// nesta página (ver guarda em auth.js/_injetarFoto).
function renderAvatarHeader(user) {
  const el = document.getElementById('pac-lanc-avatar');
  if (!el) return;
  if (user && user.tem_foto) {
    el.innerHTML = `<img src="/api/usuarios/${user.id}/foto" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;display:block;" />`;
    return;
  }
  const nome = (user && (user.nome_completo || user.username)) || '';
  const iniciais = nome.trim().split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() || '').join('') || '?';
  el.innerHTML = `<div style="width:36px;height:36px;border-radius:50%;background:var(--verde);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;">${iniciais}</div>`;
}

// Linha 3 do cabeçalho: nome + setor(es) + departamento gestor do módulo —
// tudo já vem de getCurrentUser()/meus-setores, nenhuma requisição nova.
// (Antes mostrava um texto fixo "Departamento de Planejamento (DEPLA)" —
// herdado por engano do pac-gestao.html; aqui quem lança pode ser gestor de
// qualquer setor, por isso vem dinâmico.)
async function atualizarCabecalhoUsuario() {
  const el = document.getElementById('pac-lanc-linha3');
  try {
    const [user, setoresRes] = await Promise.all([
      window.getCurrentUser(),
      fetch('/api/pac/meus-setores'),
    ]);
    _meusSetores = setoresRes.ok ? await setoresRes.json() : [];
    const nome = (user && (user.nome_completo || user.username)) || '';
    const setores = _meusSetores.map(s => s.nome).join(', ') || 'nenhum setor vinculado';
    const depto = (user && user.modulo_departamento_nome) || 'DEPLA';
    el.textContent = `${nome} — ${setores} → ${depto}`;
    renderAvatarHeader(user);
  } catch {
    el.textContent = '';
  }
}

const ICONE_VAZIO = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" stroke-width="1.5"><path d="M9 12h6M9 16h6M9 8h1"/><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;

// Código estável do DFD (nunca some/reaparece com outro dono) — pedido do
// Alex, 2026-09-06: testando com vários DFDs criados/apagados durante os
// testes, sem número nenhum na tela ficava difícil saber qual é qual.
// Deriva de `id` (AUTOINCREMENT de verdade — SQLite nunca reusa esse número,
// mesmo depois de excluir uma linha) + ano_base; não é uma coluna nova no
// banco, é só formatação (sempre reproduzível a partir do que já existe).
function codigoDfd(d) {
  return `DFD-${String(d.id).padStart(3, '0')}-${d.ano_base}`;
}

async function carregarDfds() {
  try {
    const res = await fetch('/api/pac/dfds');
    const dfds = res.ok ? await res.json() : [];
    document.getElementById('dfds-tbody').innerHTML = dfds.map(d => `
      <tr>
        <td><strong>${codigoDfd(d)}</strong></td>
        <td>${d.titulo}</td>
        <td>${d.ano_base}</td>
        <td>${badgeStatusDfd(d.status)}</td>
        <td>${d.itens_count ?? 0}</td>
        <td style="text-align:right;"><button class="btn btn-primary btn-sm" onclick="abrirDfd(${d.id})">Abrir →</button></td>
      </tr>
    `).join('') || `<tr><td colspan="6" style="padding:32px 20px;text-align:center;color:var(--text-subtle);">
        <div style="display:flex;flex-direction:column;align-items:center;gap:8px;">
          ${ICONE_VAZIO}
          <span>Nenhum DFD disponível para o seu setor no momento.</span>
        </div>
      </td></tr>`;
  } catch {
    toast('Erro ao carregar DFDs', 'error');
  }
}

async function abrirDfd(id) {
  _dfdAtualId = id;
  document.getElementById('pac-dfd-lista').style.display = 'none';
  document.getElementById('pac-dfd-itens').style.display = 'block';

  const [dfdRes, setoresRes] = await Promise.all([
    fetch(`/api/pac/dfds/${id}`),
    fetch('/api/pac/meus-setores'),
  ]);
  if (!dfdRes.ok) { toast('Erro ao abrir DFD', 'error'); fecharDfd(); return; }
  _dfdAtual = await dfdRes.json();
  _meusSetores = setoresRes.ok ? await setoresRes.json() : [];

  document.getElementById('pac-lanc-titulo').textContent = `${codigoDfd(_dfdAtual)} — ${_dfdAtual.titulo}`;
  const linha2 = document.getElementById('pac-lanc-linha2');
  // Data de vencimento (entrega) do DFD — pedido do Alex, 2026-09-07: aparecer
  // sempre que o DFD específico for aberto. DFD criado antes desta versão
  // pode não ter essa data (fica "não informado", não trava nada).
  const vencTexto = _dfdAtual.data_entrega ? `Vencimento: ${fmtBr(_dfdAtual.data_entrega)}` : 'Vencimento: não informado';
  linha2.innerHTML = `Lançamento · ${badgeStatusDfd(_dfdAtual.status)} · ${vencTexto}`;
  linha2.style.display = '';

  await carregarListas();
  await renderMeusPedidos(); // calcula _pedidosLiberados antes da tabela usar
  await carregarStatusFinalizacao(); // calcula _finalizacaoPorSetor antes da tabela usar
  await renderItens(); // popula _itensAtuais (renderFinalizacao precisa disso pra decidir "tem item lançado?")
  renderFinalizacao();
}

function fecharDfd() {
  _dfdAtualId = null; _dfdAtual = null;
  document.getElementById('pac-dfd-itens').style.display = 'none';
  document.getElementById('pac-dfd-lista').style.display = 'block';
  document.getElementById('pac-lanc-titulo').textContent = 'Lançamento';
  document.getElementById('pac-lanc-linha2').style.display = 'none';
  carregarDfds();
}

/* ── Popup "Acompanhamento" (do meu setor) ──────────────────────────────────
   Substitui a antiga página/rotina separada "pac-acompanhamento" pra quem
   lança — mesmas colunas de Lançamento (só leitura), com botão de imprimir
   e de fechar dentro do próprio popup (ver .modal-overlay-print no CSS). Não
   busca dado novo: reaproveita _itensAtuais, que já vem filtrado pro(s)
   setor(es) do usuário logado (mesma fonte que a tabela editável usa). */
function abrirAcompanhamentoPopup() {
  const nomeSetores = _meusSetores.map(s => s.nome).join(', ') || '—';
  const vencTexto = _dfdAtual.data_entrega ? `Vencimento: ${fmtBr(_dfdAtual.data_entrega)}` : 'Vencimento: não informado';
  document.getElementById('acomp-pop-subtitulo').textContent =
    `${codigoDfd(_dfdAtual)} — ${_dfdAtual.titulo} · ${nomeSetores} · ${vencTexto}`;

  const colunasPrincipais = _dfdAtual.colunas.filter(c => c.grupo === 'A' && c.slug !== 'numero_item');
  const colunasContrato = _dfdAtual.colunas.filter(c => c.grupo === 'C');
  const temColContrato = colunasContrato.length > 0;
  const multiSetor = _meusSetores.length > 1;

  renderKpisLancamento('acomp-pop-kpis');

  document.getElementById('acomp-pop-thead').innerHTML =
    `<tr>${multiSetor ? '<th>Setor</th>' : ''}<th>ID PAC</th><th>Nº PAC</th>${colunasPrincipais.map(c => `<th>${c.label}</th>`).join('')}${temColContrato ? '<th>Contrato</th>' : ''}</tr>`;

  const colspan = (multiSetor ? 1 : 0) + 2 + colunasPrincipais.length + (temColContrato ? 1 : 0);
  document.getElementById('acomp-pop-tbody').innerHTML = _itensAtuais.map(item => `
    <tr>
      ${multiSetor ? `<td data-label="Setor">${nomeSetorLanc(item.setor_id)}</td>` : ''}
      <td data-label="ID PAC">${item.codigo_pac || '—'}</td>
      <td data-label="Nº PAC">${item.numero_pac || '—'}</td>
      ${colunasPrincipais.map(c => `<td data-label="${c.label}">${formatarValorExibicao(c, item.valores[c.id])}</td>`).join('')}
      ${temColContrato ? renderCelulaContratoSomenteLeitura(item) : ''}
    </tr>
  `).join('') || `<tr><td colspan="${colspan}" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item lançado ainda.</td></tr>`;

  document.getElementById('modal-acompanhamento').classList.add('open');
}

// Indicadores — pedido do Alex, 2026-09-08: primeiro só no popup ("no botão
// de acompanhamento também"), depois direto na tela principal de Lançamento
// também ("não deveríamos ter valores somando nesta tela? só temos em
// acompanhamento") — mesma linha/estilo já aprovado em Gestão > Acompanhamento
// (ver renderKpisAcompanhamento em pac-gestao.js). Uma função só, recebe o id
// do container de destino; calculado com o que já está carregado
// (_itensAtuais/_dfdAtual/_finalizacaoPorSetor), sem requisição nova.
function renderKpisLancamento(elId) {
  const wrap = document.getElementById(elId);
  if (!wrap) return;
  const itens = _itensAtuais || [];

  const totalSetores = _meusSetores.length;
  const setoresFinalizados = _meusSetores.filter(s => _finalizacaoPorSetor[s.id]).length;
  const pctSetores = totalSetores ? Math.round((setoresFinalizados / totalSetores) * 100) : 0;

  const itensFinalizados = itens.filter(i => i.status_execucao === 'Processo Finalizado').length;
  const pctExecucao = itens.length ? Math.round((itensFinalizados / itens.length) * 100) : 0;

  const idValorEstimado = (_dfdAtual.colunas.find(c => c.slug === 'valor_estimado') || {}).id;
  const valorTotal = itens.reduce((soma, i) => soma + (Number((i.valores || {})[idValorEstimado]) || 0), 0);

  const linhaComBarra = (rotulo, pct, fracaoTexto) => `
    <div class="lanc-fin-linha">
      <strong class="pac-kpi-rotulo">${rotulo}</strong>
      <div class="pac-progress-track pac-kpi-barra"><div class="pac-progress-fill" style="width:${Math.min(pct, 100)}%;"></div></div>
      <span class="pac-kpi-fracao">${fracaoTexto} (${pct}%)</span>
    </div>`;

  wrap.innerHTML =
    (totalSetores > 1 ? linhaComBarra('Setores finalizados', pctSetores, `${setoresFinalizados} de ${totalSetores}`) : '') +
    `<div class="lanc-fin-linha">
      <strong class="pac-kpi-rotulo">Itens lançados</strong>
      <span class="text-muted pac-kpi-barra">${totalSetores > 1 ? 'Somando meus setores' : '—'}</span>
      <span class="pac-kpi-fracao">${itens.length}</span>
    </div>` +
    linhaComBarra('Execução dos itens', pctExecucao, `${itensFinalizados} de ${itens.length}`) +
    `<div class="lanc-fin-linha">
      <strong class="pac-kpi-rotulo">Valor estimado</strong>
      <span class="text-muted pac-kpi-barra">Somando todos os itens lançados</span>
      <span class="pac-kpi-fracao">R$ ${fmtMoeda(valorTotal)}</span>
    </div>`;
}

function renderCelulaContratoSomenteLeitura(item) {
  const cfg = cfgContrato(estadoContrato(item));
  return `<td data-label="Contrato" style="text-align:center;">${cfg.icone} ${cfg.texto}</td>`;
}

function fecharAcompanhamentoPopup() {
  document.getElementById('modal-acompanhamento').classList.remove('open');
}

/* ── Tabela de itens ─────────────────────────────────────────────────────── */

// Grupo B (Possui Contrato?) e C (Nº/Razão Social/Vencimento) viram 1 coluna só
// ("Contrato") — badge com texto (Sim/Não já visível, sem depender de hover),
// clique abre popup com o seletor Sim/Não + os campos de C.
// Setor do item só vira COLUNA (e ganha filtro) quando o usuário está
// vinculado a mais de 1 setor — pedido do Alex (2026-09-06, confirmado como
// situação real de produção, não só teste): sem isso, itens de setores
// diferentes apareciam misturados na mesma tabela sem nenhuma pista de qual
// é qual. Com 1 setor só (o caso comum), a tela continua idêntica a sempre.
function nomeSetorLanc(setorId) {
  return (_meusSetores.find(s => s.id === setorId) || {}).nome || '—';
}

async function renderItens() {
  // ID PAC e Nº PAC ficam fixos (sticky) no início da tabela — nenhum dos dois
  // é uma "coluna" configurável do catálogo (são campos diretos de dfd_itens:
  // codigo_pac e numero_pac), então são renderizados à parte, fora do loop de
  // colunasPrincipais. "Número" (numero_item, sequencial interno) não aparece
  // mais na tela — instrução do Alex era só ID_PAC + NUMERO_PAC visíveis; o
  // numero_item continua existindo por baixo, só pra ordenação.
  const colunasPrincipais = _dfdAtual.colunas.filter(c => c.grupo === 'A' && c.slug !== 'numero_item');
  const colunasContrato = _dfdAtual.colunas.filter(c => c.grupo === 'C');
  const temColContrato = colunasContrato.length > 0;
  const multiSetor = _meusSetores.length > 1;

  const filtroWrap = document.getElementById('lanc-filtro-setor-wrap');
  const filtroSelect = document.getElementById('lanc-filtro-setor');
  filtroWrap.style.display = multiSetor ? '' : 'none';
  if (multiSetor && !filtroSelect.dataset.montado) {
    filtroSelect.innerHTML = '<option value="">Todos os meus setores</option>' +
      _meusSetores.map(s => `<option value="${s.id}">${s.nome}</option>`).join('');
    filtroSelect.dataset.montado = '1';
  }
  const filtroSetorId = multiSetor && filtroSelect.value ? Number(filtroSelect.value) : null;

  const thead = document.getElementById('lanc-itens-thead');
  thead.innerHTML = `<tr>${multiSetor ? '<th>Setor</th>' : ''}<th class="dfd-col-fixa-1">ID PAC</th><th class="dfd-col-fixa-2">Nº PAC</th>${colunasPrincipais.map(c => `<th>${c.label}</th>`).join('')}${temColContrato ? '<th>Contrato</th>' : ''}<th></th></tr>`;

  const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/itens`);
  _itensAtuais = res.ok ? await res.json() : [];
  let itensExibidos = filtroSetorId ? _itensAtuais.filter(i => i.setor_id === filtroSetorId) : _itensAtuais;

  // Filtro "só itens com campo em branco" — pedido do Alex, 2026-09-07: o
  // aviso de pendência só cita os 5 primeiros números, isso deixa ver a
  // lista completa (com todas as colunas, pra achar o campo vazio de vez).
  const totalPendencias = itensExibidos.filter(itemTemPendencia).length;
  const pendWrap = document.getElementById('lanc-filtro-pendencia-wrap');
  const pendCheckbox = document.getElementById('lanc-filtro-pendencia');
  if (totalPendencias > 0) {
    pendWrap.style.display = 'flex';
    document.getElementById('lanc-filtro-pendencia-label').textContent =
      `Só itens com campo em branco (${totalPendencias})`;
  } else {
    pendWrap.style.display = 'none';
    pendCheckbox.checked = false; // nada pendente — não deixa o filtro "travado" ligado escondido
  }
  if (pendCheckbox.checked) itensExibidos = itensExibidos.filter(itemTemPendencia);

  const contagem = document.getElementById('lanc-dfd-contagem');
  if (contagem) {
    contagem.textContent = itensExibidos.length === _itensAtuais.length
      ? (_itensAtuais.length === 1 ? '1 item lançado' : `${_itensAtuais.length} itens lançados`)
      : `${itensExibidos.length} de ${_itensAtuais.length} itens (filtrado)`;
  }

  const colspan = (multiSetor ? 1 : 0) + 2 + colunasPrincipais.length + (temColContrato ? 1 : 0) + 1;
  const tbody = document.getElementById('lanc-itens-tbody');
  tbody.innerHTML = itensExibidos.map(item => {
    const liberado = _pedidosLiberados[item.id] || new Set();
    const setorFinalizado = !!_finalizacaoPorSetor[item.setor_id];
    const podeExcluir = (_dfdAtual.status === 'aberto' && !setorFinalizado) || liberado.has('excluir');
    // "análise" OU setor já finalizado (com DFD ainda aberto pros outros
    // setores) — nos dois casos, "fechado" não aceita nem pedido.
    const podeSolicitar = _dfdAtual.status !== 'fechado' && (_dfdAtual.status === 'analise' || setorFinalizado);
    return `
    <tr data-item-id="${item.id}">
      ${multiSetor ? `<td data-label="Setor">${nomeSetorLanc(item.setor_id)}</td>` : ''}
      <td class="dfd-col-fixa-1" data-label="ID PAC">${item.codigo_pac || '—'}</td>
      <td class="dfd-col-fixa-2" data-label="Nº PAC">${item.numero_pac || '—'}</td>
      ${colunasPrincipais.map(c => renderCelula(item, c, -1, liberado)).join('')}
      ${temColContrato ? renderCelulaContrato(item, colunasContrato) : ''}
      <td style="text-align:right;white-space:nowrap;">
        ${podeExcluir
          ? `<button class="btn btn-danger btn-xs" onclick="excluirItem(${item.id})">Excluir</button>`
          : (podeSolicitar ? `<button class="btn btn-secondary btn-xs" onclick="abrirPedido(${item.id}, 'excluir')">Solicitar exclusão</button>` : '')}
        ${(!itemEditavel(item, liberado) && podeSolicitar)
          ? `<button class="btn btn-secondary btn-xs" onclick="abrirPedido(${item.id}, 'editar')">Solicitar edição</button>` : ''}
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="${colspan}" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item lançado ainda.</td></tr>`;

  wireCelulas();
  renderFormNovoItem();
}

const ICONE_CONTRATO_SIM = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--verde)" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15l2 2 4-4"/></svg>`;
const ICONE_CONTRATO_NAO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;
const ICONE_CONTRATO_PENDENTE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a15c00" stroke-width="2"><path d="M12 9v4"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L14.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 17h.01"/></svg>`;
// Distinta de "Pendente" (que pede ação — item lançado ao vivo sem resposta
// ainda) — traço tracejado marca "dado histórico sem essa informação na
// planilha original", não uma pendência que alguém precisa resolver agora.
const ICONE_CONTRATO_NAO_INFORMADO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" stroke-width="1.5" stroke-dasharray="3 2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;

// "possui_contrato" (grupo B) é a fonte da verdade sobre o estado — não dá
// mais pra inferir isso pelo preenchimento das colunas de grupo C, porque
// "Não" deliberado e "ainda não respondido" ficavam iguais (colunas vazias
// nos dois casos). Ver valoresContratoDoForm() pra como "Não" é gravado.
function estadoContrato(item) {
  const possuiCol = _dfdAtual.colunas.find(c => c.slug === 'possui_contrato');
  const v = possuiCol ? item.valores[possuiCol.id] : null;
  if (v === 'Sim') return 'sim';
  if (v === 'Não') return 'nao';
  if (v === 'Não informado') return 'nao_informado';
  return 'pendente';
}

// Extraído de renderCelulaContrato pra ser reaproveitado tal e qual no popup
// de Acompanhamento (somente leitura) — mesmos ícones/textos/cores em
// qualquer tela que mostrar a coluna Contrato, por definição (mesma função).
function cfgContrato(estado) {
  return {
    sim: { icone: ICONE_CONTRATO_SIM, texto: 'Com contrato', titulo: 'Clique para ver/editar os dados do contrato' },
    nao: { icone: ICONE_CONTRATO_NAO, texto: 'Sem contrato', titulo: 'Clique para ver/editar os dados do contrato' },
    nao_informado: { icone: ICONE_CONTRATO_NAO_INFORMADO, texto: 'Não informado', titulo: 'Dado histórico importado sem essa informação na planilha original — clique para preencher se souber' },
    pendente: { icone: ICONE_CONTRATO_PENDENTE, texto: 'Pendente', titulo: 'Contrato ainda não informado — clique para responder' },
  }[estado];
}

function renderCelulaContrato(item, colunasContrato) {
  const estado = estadoContrato(item);
  const cfg = cfgContrato(estado);
  return `<td data-label="Contrato" style="text-align:center;">
    <button type="button" class="badge-contrato ${estado}" title="${cfg.titulo}" onclick="abrirModalContrato(${item.id})">${cfg.icone} ${cfg.texto}</button>
  </td>`;
}

// Editável = DFD aberto E o setor do item ainda não finalizado — OU um
// pedido de edição aprovado (uso único, ver liberado). Mesma trava do
// servidor (requireDfdEditavel em routes/pac.js), só pra não oferecer no
// front uma ação que vai voltar 409 na certa.
function itemEditavel(item, liberado) {
  if (liberado && liberado.has('editar')) return true;
  return _dfdAtual.status === 'aberto' && !_finalizacaoPorSetor[item.setor_id];
}

function renderCelula(item, coluna, indice, liberado) {
  const classe = indice === 0 ? 'dfd-col-fixa-1' : indice === 1 ? 'dfd-col-fixa-2' : '';
  const valor = coluna.slug === 'numero_item' ? item.numero_item : item.valores[coluna.id];
  const editavel = itemEditavel(item, liberado);

  if (coluna.tipo_input === 'auto') {
    return `<td class="${classe}" data-label="${coluna.label}">${valor ?? ''}</td>`;
  }
  if (!editavel) {
    return `<td class="${classe}" data-label="${coluna.label}">${formatarValorExibicao(coluna, valor)}</td>`;
  }
  return `<td class="${classe}" data-label="${coluna.label}">${renderInputCelula(item.id, coluna, valor)}</td>`;
}

function formatarValorExibicao(coluna, valor) {
  if (valor === null || valor === undefined || valor === '') return '—';
  if (coluna.tipo_input === 'data') return fmtBr(valor);
  if (coluna.tipo_input === 'moeda') return 'R$ ' + fmtMoeda(valor);
  return valor;
}

function renderInputCelula(itemId, coluna, valor) {
  const base = `data-item="${itemId}" data-coluna="${coluna.id}" data-tipo="${coluna.tipo_input}"`;
  if (coluna.tipo_input === 'select') {
    const opcoes = (_listasCache[coluna.lista] || []).map(o =>
      `<option value="${o.valor}" ${o.valor === valor ? 'selected' : ''}>${o.valor}</option>`).join('');
    return `<select ${base} style="min-width:120px;"><option value="">—</option>${opcoes}</select>`;
  }
  if (coluna.tipo_input === 'textarea') {
    return `<textarea ${base} rows="1" style="min-width:200px;">${valor || ''}</textarea>`;
  }
  if (coluna.tipo_input === 'moeda') {
    return `<input type="text" ${base} value="${valor != null ? fmtMoeda(valor) : ''}" style="width:110px;text-align:right;" placeholder="0,00" />`;
  }
  if (coluna.tipo_input === 'numero') {
    return `<input type="number" ${base} value="${valor ?? ''}" style="width:80px;" step="any" />`;
  }
  if (coluna.tipo_input === 'data') {
    return `<input type="date" ${base} value="${valor || ''}" style="width:140px;" />`;
  }
  return `<input type="text" ${base} value="${valor || ''}" style="min-width:140px;" />`;
}

/* ── Popup "Dados do contrato" (grupo C) — aberto pela coluna única Contrato ── */

let _mcItemId = null;
let _mcModoCriacao = false;
let _mcSetorNovo = null;

function abrirModalContrato(itemId) {
  const item = _itensAtuais.find(i => i.id === itemId);
  if (!item) return;
  _mcModoCriacao = false;
  _mcSetorNovo = null;
  _mcItemId = itemId;
  const colunasContrato = _dfdAtual.colunas.filter(c => c.grupo === 'C');
  const liberado = _pedidosLiberados[itemId] || new Set();
  const editavel = _dfdAtual.status === 'aberto' || liberado.has('editar');
  const estado = estadoContrato(item);

  const selectPossui = document.getElementById('mc-possui');
  // "Não informado" só aparece como opção quando o item JÁ está nesse estado
  // (dado histórico importado) — não faz sentido oferecer isso pra alguém
  // respondendo um item lançado ao vivo, só existe pra não perder a marca
  // sem querer ao abrir/salvar o popup de um item migrado.
  document.getElementById('mc-opcao-nao-informado').hidden = estado !== 'nao_informado';
  selectPossui.value = estado === 'pendente' ? 'nao' : estado;
  selectPossui.disabled = !editavel;

  document.getElementById('mc-subtitulo').textContent = '';
  document.getElementById('mc-campos').innerHTML = colunasContrato.map(c => {
    const valor = item.valores[c.id];
    const campo = editavel ? renderInputCelula(itemId, c, valor) : `<div style="padding:8px 0;">${formatarValorExibicao(c, valor)}</div>`;
    return `<div class="form-group" style="margin-bottom:10px;"><label>${c.label}</label>${campo}</div>`;
  }).join('') || '<p class="text-muted">Nenhuma coluna de contrato ativa neste DFD.</p>';

  mcAtualizarVisibilidadeCampos();
  document.getElementById('mc-salvar').style.display = editavel ? '' : 'none';
  document.getElementById('mc-msg').textContent = '';
  document.getElementById('modal-contrato').classList.add('open');
}

// Contrato é obrigatório antes do item existir — "+ Novo item" não cria mais
// uma linha em branco direto; abre este popup primeiro (Sim/Não já aqui),
// e só cria o item de fato em salvarContrato() quando o usuário confirmar.
// Sem isso dava pra clicar "+ Novo item" e nunca mais tocar no Contrato.
function abrirModalContratoNovoItem(setorId) {
  _mcModoCriacao = true;
  _mcItemId = null;
  _mcSetorNovo = Number(setorId);
  const colunasContrato = _dfdAtual.colunas.filter(c => c.grupo === 'C');
  const nomeSetor = (_meusSetores.find(s => s.id === _mcSetorNovo) || {}).nome;

  const selectPossui = document.getElementById('mc-possui');
  selectPossui.value = 'nao';
  selectPossui.disabled = false;

  document.getElementById('mc-subtitulo').textContent = `Novo item${nomeSetor ? ' — ' + nomeSetor : ''}`;
  document.getElementById('mc-campos').innerHTML = colunasContrato.map(c =>
    `<div class="form-group" style="margin-bottom:10px;"><label>${c.label}</label>${renderInputCelula('novo', c, '')}</div>`
  ).join('') || '<p class="text-muted">Nenhuma coluna de contrato ativa neste DFD.</p>';

  mcAtualizarVisibilidadeCampos();
  document.getElementById('mc-salvar').style.display = '';
  document.getElementById('mc-msg').textContent = '';
  document.getElementById('modal-contrato').classList.add('open');
}

// Os campos de contrato (grupo C) só fazem sentido enquanto "Sim" está
// selecionado — evita a confusão de mostrar Nº/Razão Social/Vencimento
// junto de um "Não" (era exatamente essa mistura que deixava a lógica pouco clara).
function mcAtualizarVisibilidadeCampos() {
  const sim = document.getElementById('mc-possui').value === 'sim';
  document.getElementById('mc-campos').style.display = sim ? '' : 'none';
}

function fecharModalContrato() {
  document.getElementById('modal-contrato').classList.remove('open');
  _mcItemId = null;
  _mcModoCriacao = false;
  _mcSetorNovo = null;
}

// "Possui Contrato?" (grupo B) não aparece mais como coluna própria na
// tabela, mas agora tem um lugar explícito no popup (o seletor Sim/Não) em vez
// de ser deduzido silenciosamente do preenchimento dos campos — era isso que
// deixava a lógica pouco clara. Se "Não", os campos de C são zerados.
function valoresContratoDoForm() {
  const colunasContrato = _dfdAtual.colunas.filter(c => c.grupo === 'C');
  const escolha = document.getElementById('mc-possui').value; // 'sim' | 'nao' | 'nao_informado'
  const valores = {};
  if (escolha === 'sim') {
    document.querySelectorAll('#mc-campos [data-coluna]').forEach(el => {
      let v = el.value;
      if (el.dataset.tipo === 'moeda') { const n = parseMoeda(v); v = n == null ? '' : String(n); }
      valores[el.dataset.coluna] = v === '' ? null : v;
    });
  } else if (escolha === 'nao_informado') {
    // Mantém a marca de dado histórico (mesma convenção da importação: texto
    // vira "Não informado", data fica NULL — ver routes/pac-importacao.js).
    colunasContrato.forEach(c => { valores[c.id] = c.tipo_input === 'data' ? null : 'Não informado'; });
  } else {
    // "Não" precisa ficar distinguível de "ainda não respondido" (ver
    // estadoContrato) — os campos de texto/número seguem nulos, mas a coluna
    // de data ganha uma sentinela (01/01/1900) em vez de NULL, porque
    // "Sem contrato" é uma resposta completa e definitiva, não uma ausência.
    colunasContrato.forEach(c => { valores[c.id] = c.tipo_input === 'data' ? '1900-01-01' : null; });
  }
  const possuiCol = _dfdAtual.colunas.find(c => c.slug === 'possui_contrato');
  if (possuiCol) valores[possuiCol.id] = escolha === 'sim' ? 'Sim' : escolha === 'nao_informado' ? 'Não informado' : 'Não';
  return valores;
}

async function salvarContrato() {
  const valores = valoresContratoDoForm();
  try {
    const res = _mcModoCriacao
      ? await fetch(`/api/pac/dfds/${_dfdAtualId}/itens`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setor_id: _mcSetorNovo, valores }),
        })
      : await fetch(`/api/pac/itens/${_mcItemId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ valores }),
        });
    if (res.status === 409) {
      const e = await res.json();
      if (e.pedeEdicao) { fecharModalContrato(); ofertarPedidoEdicao(_mcItemId); return; }
      document.getElementById('mc-msg').style.color = '#c00';
      document.getElementById('mc-msg').textContent = e.error || 'Não foi possível salvar.';
      return;
    }
    if (!res.ok) {
      document.getElementById('mc-msg').style.color = '#c00';
      document.getElementById('mc-msg').textContent = await mensagemErro(res, 'Não foi possível salvar.');
      return;
    }
    if (!_mcModoCriacao && _dfdAtual.status !== 'aberto') await renderMeusPedidos();
    fecharModalContrato();
    renderItens();
  } catch {
    document.getElementById('mc-msg').style.color = '#c00';
    document.getElementById('mc-msg').textContent = 'Erro ao salvar.';
  }
}


let _listasCache = {};

async function carregarListas() {
  const listas = [...new Set(_dfdAtual.colunas.filter(c => c.lista).map(c => c.lista))];
  const entradas = await Promise.all(listas.map(async l => {
    const res = await fetch(`/api/pac/parametros?lista=${encodeURIComponent(l)}`);
    return [l, res.ok ? (await res.json()).filter(p => p.ativo) : []];
  }));
  _listasCache = Object.fromEntries(entradas);
}

function wireCelulas() {
  document.querySelectorAll('#lanc-itens-tbody [data-item][data-coluna]').forEach(el => {
    const evento = (el.tagName === 'SELECT') ? 'change' : 'blur';
    el.addEventListener(evento, () => salvarCampoItem(el));
  });
}

async function salvarCampoItem(el) {
  const itemId = el.dataset.item;
  const colunaId = el.dataset.coluna;
  const tipo = el.dataset.tipo;
  let valor = el.value;
  if (tipo === 'moeda') { const n = parseMoeda(valor); valor = n == null ? '' : String(n); el.value = valor === '' ? '' : fmtMoeda(n); }

  try {
    const res = await fetch(`/api/pac/itens/${itemId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valores: { [colunaId]: valor === '' ? null : valor } }),
    });
    if (res.status === 409) {
      const e = await res.json();
      if (e.pedeEdicao) { ofertarPedidoEdicao(itemId); return; }
      toast(e.error || 'Não foi possível salvar.', 'error');
      return;
    }
    if (!res.ok) { toast(await mensagemErro(res, 'Erro ao salvar campo'), 'error'); return; }
    // Edição sob um pedido aprovado consome o pedido (uso único) — recarrega
    // pra refletir que a linha volta a ficar bloqueada.
    if (_dfdAtual.status !== 'aberto') { await renderMeusPedidos(); await renderItens(); return; }
    // Atualiza o item em memória e reroda o aviso de pendência na hora — sem
    // isso, corrigir um campo em branco só refletia depois de um F5 (pedido
    // do Alex, 2026-09-07). Se o filtro "só pendências" está ligado, o item
    // corrigido pode sair da lista — renderItens() de novo cobre isso.
    const item = _itensAtuais.find(i => String(i.id) === String(itemId));
    if (item) {
      item.valores = item.valores || {};
      item.valores[colunaId] = valor === '' ? null : valor;
    }
    if (document.getElementById('lanc-filtro-pendencia')?.checked) await renderItens();
    renderFinalizacao();
  } catch {
    toast('Erro ao salvar campo', 'error');
  }
}

function ofertarPedidoEdicao(itemId) {
  if (!confirm('Este DFD está em análise. Deseja solicitar um pedido de edição para este item?')) return;
  abrirPedido(itemId, 'editar');
}

async function abrirPedido(itemId, tipo) {
  const justificativa = prompt(tipo === 'excluir' ? 'Justificativa para excluir este item:' : 'Justificativa para editar este item:');
  if (justificativa === null || !justificativa.trim()) return;
  try {
    const res = await fetch('/api/pac/pedidos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId, tipo, justificativa: justificativa.trim() }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    toast('Pedido enviado ao DEPLA.');
    renderMeusPedidos();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

async function excluirItem(itemId) {
  if (!confirm('Excluir este item?')) return;
  try {
    const res = await fetch(`/api/pac/itens/${itemId}`, { method: 'DELETE' });
    if (res.status === 409) {
      const e = await res.json();
      if (e.pedeEdicao) { ofertarPedidoEdicaoExcluir(itemId); return; }
      toast(e.error || 'Não foi possível excluir.', 'error');
      return;
    }
    if (!res.ok) { toast(await mensagemErro(res, 'Erro ao excluir item'), 'error'); return; }
    await renderItens();
    renderFinalizacao();
  } catch {
    toast('Erro ao excluir item', 'error');
  }
}

function ofertarPedidoEdicaoExcluir(itemId) {
  if (!confirm('Este DFD está em análise. Deseja solicitar um pedido de exclusão para este item?')) return;
  abrirPedido(itemId, 'excluir');
}

/* ── Novo item ───────────────────────────────────────────────────────────── */

function renderFormNovoItem() {
  const wrap = document.getElementById('lanc-novo-item');
  if (_dfdAtual.status !== 'aberto') { wrap.innerHTML = ''; return; }
  if (!_meusSetores.length) { wrap.innerHTML = '<span class="text-muted">Você não está vinculado a nenhum setor.</span>'; return; }

  // Setor já finalizado ("Finalizar meu DFD") não entra mais como opção pra
  // lançar item novo — a trava do servidor já bloqueia, isso só evita
  // oferecer uma ação que vai falhar na certa.
  const disponiveis = _meusSetores.filter(s => !_finalizacaoPorSetor[s.id]);
  if (!disponiveis.length) { wrap.innerHTML = '<span class="text-muted">Todos os seus setores já foram finalizados neste DFD.</span>'; return; }

  const selectSetor = disponiveis.length > 1
    ? `<select id="novo-item-setor" style="margin-right:10px;">${disponiveis.map(s => `<option value="${s.id}">${s.nome}</option>`).join('')}</select>`
    : `<input type="hidden" id="novo-item-setor" value="${disponiveis[0].id}" />`;

  wrap.innerHTML = `${selectSetor}<button class="btn btn-primary btn-sm" onclick="iniciarNovoItem()">+ Novo item</button>`;
}

// Contrato é obrigatório (ver abrirModalContratoNovoItem) — só pula direto
// pra criarItem() quando o DFD nem tem a coluna de contrato ativada.
function iniciarNovoItem() {
  const temColContrato = _dfdAtual.colunas.some(c => c.grupo === 'C');
  if (temColContrato) {
    abrirModalContratoNovoItem(document.getElementById('novo-item-setor').value);
  } else {
    criarItem();
  }
}

async function criarItem() {
  const setorId = document.getElementById('novo-item-setor').value;
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/itens`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setor_id: Number(setorId), valores: {} }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    await renderItens();
    renderFinalizacao(); // item novo nasce com tudo em branco — pendência aparece na hora
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

/* ── Finalização por setor ("Finalizar meu DFD") ────────────────────────────
   Sinaliza ao DEPLA que o setor terminou de lançar — trava escrita nesse
   setor (mesma trava do DFD "em análise", ver requireDfdEditavel no
   servidor) mesmo com o DFD continuando aberto pros OUTROS setores. Um
   gestor com mais de um setor vinculado finaliza cada um separadamente. ── */

async function carregarStatusFinalizacao() {
  if (!_meusSetores.length) { _finalizacaoPorSetor = {}; return; }
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/status-finalizacao`);
    const info = res.ok ? await res.json() : { setores: [] };
    _finalizacaoPorSetor = Object.fromEntries(info.setores.map(s => [s.setor_id, s.finalizado_em]));
  } catch { _finalizacaoPorSetor = {}; }
}

// Item com algum campo do grupo A (o "corpo" do lançamento, exceto Contrato
// — que tem regra própria, vazio lá vira "Não informado" na importação e
// isso NÃO conta como pendência) ainda em branco — mesmo critério de
// itensComPendencia() no servidor (routes/pac.js). Pedido do Alex,
// 2026-09-06/07: precisa aparecer ANTES de tentar finalizar, e dar pra ver a
// lista completa (não só os 5 primeiros), não só um erro depois do clique.
function itemTemPendencia(item) {
  const colunas = (_dfdAtual.colunas || []).filter(c => c.grupo === 'A' && c.slug !== 'numero_item');
  return colunas.some(c => {
    const v = (item.valores || {})[c.id];
    return v === undefined || v === null || String(v).trim() === '';
  });
}

function pendenciasDoSetor(setorId) {
  return _itensAtuais.filter(i => i.setor_id === setorId).filter(itemTemPendencia);
}

// Chamado DEPOIS de renderItens() — precisa de _itensAtuais pra só oferecer o
// botão quando o setor já tem ao menos 1 item lançado (Alex: "visível somente
// quando... o gestor tem ao menos 1 item lançado").
function renderFinalizacao() {
  // Indicadores da tela principal — mesmo gatilho de atualização que o resto
  // desta função (toda mudança que mexe em pendência/finalização também pode
  // mudar itens lançados/execução/valor estimado). Pedido do Alex,
  // 2026-09-08: "não deveríamos ter valores somando nesta tela?".
  renderKpisLancamento('lanc-kpis');

  const wrap = document.getElementById('lanc-finalizar-wrap');
  if (!wrap) return;
  if (_dfdAtual.status !== 'aberto' || !_meusSetores.length) { wrap.innerHTML = ''; return; }

  wrap.innerHTML = _meusSetores.map(s => {
    const fin = _finalizacaoPorSetor[s.id];
    if (fin) return `<div class="lanc-fin-linha"><strong>${s.nome}:</strong> <span class="badge badge-aberto">✅ Finalizado em ${fmtBr(String(fin).split(' ')[0])}</span></div>`;
    const temItem = _itensAtuais.some(i => i.setor_id === s.id);
    if (!temItem) return '';
    const pendentes = pendenciasDoSetor(s.id);
    if (pendentes.length) {
      const souMaster = _usuarioPac && _usuarioPac.username === 'master';
      return `<div class="lanc-fin-linha lanc-fin-pendente">
        <strong>${s.nome}:</strong>
        <span class="text-muted">⚠️ ${pendentes.length} item(ns) com campo(s) em branco — preencha antes de finalizar.</span>
        <button type="button" class="btn btn-secondary btn-xs" onclick="verPendenciasSetor()">Ver todos</button>
        ${souMaster
          ? `<button class="btn btn-secondary btn-xs" onclick="finalizarMeuSetor(${s.id}, true)" title="Só master: finaliza mesmo com pendência">Finalizar assim mesmo (master)</button>`
          : `<button class="btn btn-secondary btn-xs" disabled title="Preencha os campos em branco antes de finalizar">Finalizar meu DFD</button>`}
      </div>`;
    }
    return `<div class="lanc-fin-linha"><strong>${s.nome}:</strong> <button class="btn btn-secondary btn-xs" onclick="finalizarMeuSetor(${s.id})">Finalizar meu DFD</button></div>`;
  }).join('');
}

// Liga o filtro "só itens com campo em branco" e rola até a tabela — atalho
// do botão "Ver todos" no aviso de pendência (que só cita a contagem, não a
// lista, ver renderFinalizacao()).
function verPendenciasSetor() {
  const checkbox = document.getElementById('lanc-filtro-pendencia');
  checkbox.checked = true;
  renderItens();
  document.getElementById('lanc-itens-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Botão "🔄 Atualizar" — pedido do Alex, 2026-09-07: depois de corrigir um
// item, o aviso de pendência não se atualizava sozinho (precisava de F5).
// salvarCampoItem() já corrige isso pra edição de campo direto na tabela;
// este botão cobre o resto (pedido aprovado por outra aba/pessoa, etc.).
async function atualizarLancamento() {
  await carregarStatusFinalizacao();
  await renderItens();
  renderFinalizacao();
  toast('Atualizado.');
}

async function finalizarMeuSetor(setorId, forcar) {
  const aviso = forcar
    ? 'Existem itens com campo(s) em branco. Como master, você pode finalizar assim mesmo — confirma?'
    : 'Ao finalizar, você não poderá mais incluir ou editar itens deste setor sem solicitar autorização ao DEPLA. Confirmar?';
  if (!confirm(aviso)) return;
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/setores/${setorId}/finalizar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ forcar: !!forcar }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    toast('Setor finalizado.');
    await carregarStatusFinalizacao();
    await renderItens();
    renderFinalizacao();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

/* ── Meus pedidos ────────────────────────────────────────────────────────── */

async function renderMeusPedidos() {
  const res = await fetch('/api/pac/pedidos');
  const pedidos = res.ok ? await res.json() : [];
  const doDfd = pedidos.filter(p => p.dfd_id === _dfdAtualId);

  _pedidosLiberados = {};
  doDfd.forEach(p => {
    if (p.status === 'aprovado' && !p.consumido_em && p.item_id) {
      (_pedidosLiberados[p.item_id] ??= new Set()).add(p.tipo);
    }
  });

  const card = document.getElementById('lanc-pedidos-card');
  if (!doDfd.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  document.getElementById('lanc-pedidos-tbody').innerHTML = doDfd.map(p => `
    <tr>
      <td>#${p.item_id ?? '—'}</td>
      <td>${p.tipo}</td>
      <td>${p.justificativa || '—'}</td>
      <td>${p.status}</td>
      <td>${p.resposta || '—'}</td>
    </tr>
  `).join('');
}
