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

document.addEventListener('DOMContentLoaded', () => {
  atualizarCabecalhoUsuario();
  atualizarRelogioHeader();
  setInterval(atualizarRelogioHeader, 60 * 1000);
  carregarDfds();
});

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

async function carregarDfds() {
  try {
    const res = await fetch('/api/pac/dfds');
    const dfds = res.ok ? await res.json() : [];
    document.getElementById('dfds-tbody').innerHTML = dfds.map(d => `
      <tr>
        <td><strong>${d.titulo}</strong></td>
        <td>${d.ano_base}</td>
        <td>${badgeStatusDfd(d.status)}</td>
        <td>${d.itens_count ?? 0}</td>
        <td style="text-align:right;"><button class="btn btn-primary btn-sm" onclick="abrirDfd(${d.id})">Abrir →</button></td>
      </tr>
    `).join('') || `<tr><td colspan="5" style="padding:32px 20px;text-align:center;color:var(--text-subtle);">
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

  document.getElementById('pac-lanc-titulo').textContent = `${_dfdAtual.titulo} (${_dfdAtual.ano_base})`;
  const linha2 = document.getElementById('pac-lanc-linha2');
  linha2.innerHTML = `Lançamento · ${badgeStatusDfd(_dfdAtual.status)}`;
  linha2.style.display = '';

  await carregarListas();
  await renderMeusPedidos(); // calcula _pedidosLiberados antes da tabela usar
  await renderItens();
}

function fecharDfd() {
  _dfdAtualId = null; _dfdAtual = null;
  document.getElementById('pac-dfd-itens').style.display = 'none';
  document.getElementById('pac-dfd-lista').style.display = 'block';
  document.getElementById('pac-lanc-titulo').textContent = 'Lançamento';
  document.getElementById('pac-lanc-linha2').style.display = 'none';
  carregarDfds();
}

/* ── Tabela de itens ─────────────────────────────────────────────────────── */

// Grupo B (Possui Contrato?) e C (Nº/Razão Social/Vencimento) viram 1 coluna só
// ("Contrato") — badge com texto (Sim/Não já visível, sem depender de hover),
// clique abre popup com o seletor Sim/Não + os campos de C.
async function renderItens() {
  const colunasPrincipais = _dfdAtual.colunas.filter(c => c.grupo === 'A');
  const colunasContrato = _dfdAtual.colunas.filter(c => c.grupo === 'C');
  const temColContrato = colunasContrato.length > 0;

  const thead = document.getElementById('lanc-itens-thead');
  thead.innerHTML = `<tr>${colunasPrincipais.map((c, i) => `<th class="${i === 0 ? 'dfd-col-fixa-1' : i === 1 ? 'dfd-col-fixa-2' : ''}">${c.label}</th>`).join('')}${temColContrato ? '<th>Contrato</th>' : ''}<th></th></tr>`;

  const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/itens`);
  _itensAtuais = res.ok ? await res.json() : [];
  const contagem = document.getElementById('lanc-dfd-contagem');
  if (contagem) contagem.textContent = _itensAtuais.length === 1 ? '1 item lançado' : `${_itensAtuais.length} itens lançados`;

  const colspan = colunasPrincipais.length + (temColContrato ? 1 : 0) + 1;
  const tbody = document.getElementById('lanc-itens-tbody');
  tbody.innerHTML = _itensAtuais.map(item => {
    const liberado = _pedidosLiberados[item.id] || new Set();
    const podeExcluir = _dfdAtual.status === 'aberto' || liberado.has('excluir');
    const podeSolicitar = _dfdAtual.status === 'analise'; // fechado não aceita nem pedido
    return `
    <tr data-item-id="${item.id}">
      ${colunasPrincipais.map((c, i) => renderCelula(item, c, i, liberado)).join('')}
      ${temColContrato ? renderCelulaContrato(item, colunasContrato) : ''}
      <td style="text-align:right;white-space:nowrap;">
        ${podeExcluir
          ? `<button class="btn btn-danger btn-xs" onclick="excluirItem(${item.id})">Excluir</button>`
          : (podeSolicitar ? `<button class="btn btn-secondary btn-xs" onclick="abrirPedido(${item.id}, 'excluir')">Solicitar exclusão</button>` : '')}
        ${(!(_dfdAtual.status === 'aberto' || liberado.has('editar')) && podeSolicitar)
          ? `<button class="btn btn-secondary btn-xs" onclick="abrirPedido(${item.id}, 'editar')">Solicitar edição</button>` : ''}
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="${colspan}" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item lançado ainda.</td></tr>`;

  wireCelulas();
  renderFormNovoItem();
}

const ICONE_CONTRATO_SIM = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--verde)" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15l2 2 4-4"/></svg>`;
const ICONE_CONTRATO_NAO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;

function contratoPreenchido(item, colunasContrato) {
  return colunasContrato.some(c => {
    const v = item.valores[c.id];
    return v !== null && v !== undefined && v !== '';
  });
}

function renderCelulaContrato(item, colunasContrato) {
  const tem = contratoPreenchido(item, colunasContrato);
  const titulo = tem ? 'Clique para ver/editar os dados do contrato' : 'Clique para informar os dados do contrato';
  return `<td data-label="Contrato" style="text-align:center;">
    <button type="button" class="badge-contrato ${tem ? 'tem' : 'nao'}" title="${titulo}" onclick="abrirModalContrato(${item.id})">${tem ? ICONE_CONTRATO_SIM : ICONE_CONTRATO_NAO} ${tem ? 'Com contrato' : 'Sem contrato'}</button>
  </td>`;
}

function renderCelula(item, coluna, indice, liberado) {
  const classe = indice === 0 ? 'dfd-col-fixa-1' : indice === 1 ? 'dfd-col-fixa-2' : '';
  const valor = coluna.slug === 'numero_item' ? item.numero_item : item.valores[coluna.id];
  const editavel = _dfdAtual.status === 'aberto' || (liberado && liberado.has('editar'));

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

function abrirModalContrato(itemId) {
  const item = _itensAtuais.find(i => i.id === itemId);
  if (!item) return;
  _mcItemId = itemId;
  const colunasContrato = _dfdAtual.colunas.filter(c => c.grupo === 'C');
  const liberado = _pedidosLiberados[itemId] || new Set();
  const editavel = _dfdAtual.status === 'aberto' || liberado.has('editar');
  const tem = contratoPreenchido(item, colunasContrato);

  const selectPossui = document.getElementById('mc-possui');
  selectPossui.value = tem ? 'sim' : 'nao';
  selectPossui.disabled = !editavel;

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
}

// "Possui Contrato?" (grupo B) não aparece mais como coluna própria na
// tabela, mas agora tem um lugar explícito no popup (o seletor Sim/Não) em vez
// de ser deduzido silenciosamente do preenchimento dos campos — era isso que
// deixava a lógica pouco clara. Se "Não", os campos de C são zerados.
function valoresContratoDoForm() {
  const colunasContrato = _dfdAtual.colunas.filter(c => c.grupo === 'C');
  const sim = document.getElementById('mc-possui').value === 'sim';
  const valores = {};
  if (sim) {
    document.querySelectorAll('#mc-campos [data-coluna]').forEach(el => {
      let v = el.value;
      if (el.dataset.tipo === 'moeda') { const n = parseMoeda(v); v = n == null ? '' : String(n); }
      valores[el.dataset.coluna] = v === '' ? null : v;
    });
  } else {
    colunasContrato.forEach(c => { valores[c.id] = null; });
  }
  const possuiCol = _dfdAtual.colunas.find(c => c.slug === 'possui_contrato');
  if (possuiCol) valores[possuiCol.id] = sim ? 'Sim' : 'Não';
  return valores;
}

async function salvarContrato() {
  const valores = valoresContratoDoForm();
  try {
    const res = await fetch(`/api/pac/itens/${_mcItemId}`, {
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
    if (_dfdAtual.status !== 'aberto') await renderMeusPedidos();
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
    if (_dfdAtual.status !== 'aberto') { await renderMeusPedidos(); await renderItens(); }
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

  const selectSetor = _meusSetores.length > 1
    ? `<select id="novo-item-setor" style="margin-right:10px;">${_meusSetores.map(s => `<option value="${s.id}">${s.nome}</option>`).join('')}</select>`
    : `<input type="hidden" id="novo-item-setor" value="${_meusSetores[0].id}" />`;

  wrap.innerHTML = `${selectSetor}<button class="btn btn-primary btn-sm" onclick="criarItem()">+ Novo item</button>`;
}

async function criarItem() {
  const setorId = document.getElementById('novo-item-setor').value;
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/itens`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setor_id: Number(setorId), valores: {} }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    renderItens();
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
