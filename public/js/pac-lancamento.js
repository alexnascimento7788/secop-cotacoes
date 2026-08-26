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
  const map = { aberto: 'Aberto', analise: 'Em análise', fechado: 'Fechado' };
  return `<span class="badge badge-${status}">${map[status] || status}</span>`;
}

let _dfdAtualId = null;
let _dfdAtual = null;
let _meusSetores = [];
let _grupoColapsado = {};
let _pedidosLiberados = {}; // item_id -> Set('editar'|'excluir') aprovados e ainda não consumidos

document.addEventListener('DOMContentLoaded', () => {
  carregarDfds();
});

async function carregarDfds() {
  try {
    const res = await fetch('/api/pac/dfds');
    const dfds = res.ok ? await res.json() : [];
    document.getElementById('dfds-tbody').innerHTML = dfds.map(d => `
      <tr>
        <td><strong>${d.titulo}</strong></td>
        <td>${d.ano_base}</td>
        <td>${badgeStatusDfd(d.status)}</td>
        <td style="text-align:right;"><button class="btn btn-secondary btn-sm" onclick="abrirDfd(${d.id})">Abrir</button></td>
      </tr>
    `).join('') || `<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum DFD disponível para o seu setor no momento.</td></tr>`;
  } catch {
    toast('Erro ao carregar DFDs', 'error');
  }
}

async function abrirDfd(id) {
  _dfdAtualId = id;
  document.getElementById('pac-dfd-lista').style.display = 'none';
  document.getElementById('pac-dfd-itens').style.display = 'block';
  const key = `secop_pac_grupos_${id}`;
  try { _grupoColapsado = JSON.parse(localStorage.getItem(key) || '{}'); } catch { _grupoColapsado = {}; }

  const [dfdRes, setoresRes] = await Promise.all([
    fetch(`/api/pac/dfds/${id}`),
    fetch('/api/pac/meus-setores'),
  ]);
  if (!dfdRes.ok) { toast('Erro ao abrir DFD', 'error'); fecharDfd(); return; }
  _dfdAtual = await dfdRes.json();
  _meusSetores = setoresRes.ok ? await setoresRes.json() : [];

  document.getElementById('lanc-dfd-titulo').textContent = `${_dfdAtual.titulo} (${_dfdAtual.ano_base})`;
  const badge = document.getElementById('lanc-dfd-badge');
  const map = { aberto: 'Aberto', analise: 'Em análise', fechado: 'Fechado' };
  badge.className = `badge badge-${_dfdAtual.status}`;
  badge.textContent = map[_dfdAtual.status] || _dfdAtual.status;

  renderGrupoToggle();
  await carregarListas();
  await renderMeusPedidos(); // calcula _pedidosLiberados antes da tabela usar
  await renderItens();
}

function fecharDfd() {
  _dfdAtualId = null; _dfdAtual = null;
  document.getElementById('pac-dfd-itens').style.display = 'none';
  document.getElementById('pac-dfd-lista').style.display = 'block';
  carregarDfds();
}

function renderGrupoToggle() {
  const grupos = [...new Set(_dfdAtual.colunas.map(c => c.grupo))];
  const nomes = { A: 'Demanda', B: 'Contrato?', C: 'Dados do contrato' };
  document.getElementById('lanc-grupos-toggle').innerHTML = grupos.map(g => `
    <button class="btn btn-secondary btn-sm" onclick="toggleGrupo('${g}')">
      ${_grupoColapsado[g] ? '▸' : '▾'} ${nomes[g] || g}
    </button>
  `).join('');
}

function toggleGrupo(g) {
  _grupoColapsado[g] = !_grupoColapsado[g];
  localStorage.setItem(`secop_pac_grupos_${_dfdAtualId}`, JSON.stringify(_grupoColapsado));
  renderGrupoToggle();
  document.querySelectorAll(`[data-grupo="${g}"]`).forEach(el => el.classList.toggle('colapsado', !!_grupoColapsado[g]));
}

/* ── Tabela de itens ─────────────────────────────────────────────────────── */

async function renderItens() {
  const colunas = _dfdAtual.colunas;
  const thead = document.getElementById('lanc-itens-thead');
  thead.innerHTML = `<tr>${colunas.map((c, i) => `<th class="${i === 0 ? 'dfd-col-fixa-1' : i === 1 ? 'dfd-col-fixa-2' : ''}" data-grupo="${c.grupo}">${c.label}</th>`).join('')}<th></th></tr>`;

  const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/itens`);
  const itens = res.ok ? await res.json() : [];

  const tbody = document.getElementById('lanc-itens-tbody');
  tbody.innerHTML = itens.map(item => {
    const liberado = _pedidosLiberados[item.id] || new Set();
    const podeExcluir = _dfdAtual.status === 'aberto' || liberado.has('excluir');
    const podeSolicitar = _dfdAtual.status === 'analise'; // fechado não aceita nem pedido
    return `
    <tr data-item-id="${item.id}">
      ${colunas.map((c, i) => renderCelula(item, c, i, liberado)).join('')}
      <td style="text-align:right;white-space:nowrap;">
        ${podeExcluir
          ? `<button class="btn btn-danger btn-xs" onclick="excluirItem(${item.id})">Excluir</button>`
          : (podeSolicitar ? `<button class="btn btn-secondary btn-xs" onclick="abrirPedido(${item.id}, 'excluir')">Solicitar exclusão</button>` : '')}
        ${(!(_dfdAtual.status === 'aberto' || liberado.has('editar')) && podeSolicitar)
          ? `<button class="btn btn-secondary btn-xs" onclick="abrirPedido(${item.id}, 'editar')">Solicitar edição</button>` : ''}
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="${colunas.length + 1}" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item lançado ainda.</td></tr>`;

  // Grupos colapsados persistidos
  Object.entries(_grupoColapsado).forEach(([g, colapsado]) => {
    if (colapsado) document.querySelectorAll(`[data-grupo="${g}"]`).forEach(el => el.classList.add('colapsado'));
  });

  wireCelulas();
  renderFormNovoItem();
}

function renderCelula(item, coluna, indice, liberado) {
  const classe = indice === 0 ? 'dfd-col-fixa-1' : indice === 1 ? 'dfd-col-fixa-2' : '';
  const valor = coluna.slug === 'numero_item' ? item.numero_item : item.valores[coluna.id];
  const editavel = _dfdAtual.status === 'aberto' || (liberado && liberado.has('editar'));

  if (coluna.tipo_input === 'auto') {
    return `<td class="${classe}" data-grupo="${coluna.grupo}" data-label="${coluna.label}">${valor ?? ''}</td>`;
  }
  if (!editavel) {
    return `<td class="${classe}" data-grupo="${coluna.grupo}" data-label="${coluna.label}">${formatarValorExibicao(coluna, valor)}</td>`;
  }
  return `<td class="${classe}" data-grupo="${coluna.grupo}" data-label="${coluna.label}">${renderInputCelula(item.id, coluna, valor)}</td>`;
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
    if (!res.ok) throw new Error();
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
    if (!res.ok) throw new Error();
    renderItens();
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
