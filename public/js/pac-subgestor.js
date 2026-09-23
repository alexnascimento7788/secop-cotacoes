// PAC — tela própria do Sub-gestor DEPLA (pedido do Alex, 2026-09-23): lança
// itens em nome de QUALQUER setor do DFD (sem pertencer a nenhum via
// setor_usuarios), restrito automaticamente à unidade que ele tem em
// unidade_usuarios. Nunca vê a lista de lançamentos do gestor oficial —
// só os próprios (GET /dfds/:id/itens já filtra isso no servidor pra quem
// tem esse papel). Formulário simples, sem tabela de edição inline: cria o
// item já preenchido de uma vez (mesmo padrão de valoresContratoDoForm em
// pac-lancamento.js, mas achatado pra 1 form só).

function toast(msg, tipo) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (tipo ? ' ' + tipo : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
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
function fmtBr(iso) {
  if (!iso) return '—';
  const d = String(iso).split(/[T ]/)[0].split('-');
  return d.length < 3 ? '—' : `${d[2]}/${d[1]}/${d[0]}`;
}

let _dfds = [];
let _dfdAtual = null;
let _listasCache = {};

async function boot() {
  try {
    const res = await fetch('/api/pac/dfds');
    _dfds = res.ok ? await res.json() : [];
  } catch { _dfds = []; }
  // Só interessa DFD ainda aberto pra lançamento — os demais já passaram da
  // fase em que um lançamento novo faz sentido.
  _dfds = _dfds.filter(d => d.status === 'aberto');
  if (!_dfds.length) {
    document.getElementById('sg-subtitulo').textContent = 'Nenhum DFD disponível';
    document.getElementById('sg-sem-dfd').style.display = '';
    return;
  }
  document.getElementById('sg-conteudo').style.display = '';
  const wrapSel = document.getElementById('sg-dfd-wrap');
  const sel = document.getElementById('sg-dfd-select');
  if (_dfds.length > 1) {
    wrapSel.style.display = '';
    sel.innerHTML = _dfds.map(d => `<option value="${d.id}">${d.titulo} (${d.ano_base})</option>`).join('');
  }
  await carregarDfdEscolhido();
}

async function carregarDfdEscolhido() {
  const sel = document.getElementById('sg-dfd-select');
  const dfdId = _dfds.length > 1 ? Number(sel.value) : _dfds[0].id;
  const res = await fetch(`/api/pac/dfds/${dfdId}`);
  if (!res.ok) { toast('Erro ao carregar o DFD', 'error'); return; }
  _dfdAtual = await res.json();
  document.getElementById('sg-subtitulo').textContent = `${_dfdAtual.titulo} (${_dfdAtual.ano_base})`;

  document.getElementById('sg-setor-select').innerHTML =
    (_dfdAtual.setores || []).map(s => `<option value="${s.id}">${s.nome}</option>`).join('') || '<option value="">Nenhum setor participante</option>';

  await carregarListas();
  renderCampos();
  await renderMeusLancamentos();
}

async function carregarListas() {
  const listas = [...new Set((_dfdAtual.colunas || []).filter(c => c.grupo === 'A' && c.lista).map(c => c.lista))];
  const entradas = await Promise.all(listas.map(async l => {
    const res = await fetch(`/api/pac/parametros?lista=${encodeURIComponent(l)}`);
    return [l, res.ok ? (await res.json()).filter(p => p.ativo) : []];
  }));
  _listasCache = Object.fromEntries(entradas);
}

// Só grupo A (dados do item em si) — Contrato (grupo C) fica de fora do
// lançamento cego do sub-gestor por ora; o gestor oficial completa isso
// depois, ao revisar o item pendente na tela normal de Lançamento.
function renderCampos() {
  const colunas = (_dfdAtual.colunas || []).filter(c => c.grupo === 'A' && c.slug !== 'numero_item');
  document.getElementById('sg-campos').innerHTML = colunas.map(c => `
    <div class="form-group">
      <label>${c.label}${c.obrigatoria ? ' *' : ''}</label>
      ${renderCampoNovo(c)}
    </div>
  `).join('');
}

function renderCampoNovo(coluna) {
  const id = `campo-novo-${coluna.id}`;
  const base = `id="${id}" data-coluna="${coluna.id}" data-tipo="${coluna.tipo_input}"`;
  if (coluna.tipo_input === 'select') {
    const opcoes = (_listasCache[coluna.lista] || []).map(o => `<option value="${o.valor}">${o.valor}</option>`).join('');
    return `<select ${base}><option value="">—</option>${opcoes}</select>`;
  }
  if (coluna.tipo_input === 'textarea') return `<textarea ${base} rows="2"></textarea>`;
  if (coluna.tipo_input === 'moeda') return `<input type="text" ${base} placeholder="0,00" />`;
  if (coluna.tipo_input === 'numero') return `<input type="number" ${base} step="any" />`;
  if (coluna.tipo_input === 'data') return `<input type="date" ${base} />`;
  return `<input type="text" ${base} />`;
}

function coletarValoresNovo() {
  const valores = {};
  document.querySelectorAll('#sg-campos [data-coluna]').forEach(el => {
    let v = el.value;
    if (el.dataset.tipo === 'moeda') { const n = parseMoeda(v); v = n == null ? '' : String(n); }
    valores[el.dataset.coluna] = v === '' ? null : v;
  });
  return valores;
}

async function lancarItemSubgestor() {
  const msg = document.getElementById('sg-msg');
  msg.style.color = '#c00';
  const setorId = Number(document.getElementById('sg-setor-select').value);
  if (!setorId) { msg.textContent = 'Selecione o setor.'; return; }
  const valores = coletarValoresNovo();
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtual.id}/itens`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setor_id: setorId, valores }), // unidade_id NUNCA vem daqui — o servidor atribui automaticamente a unidade do sub-gestor
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Erro ao lançar'); }
    msg.style.color = '#2E7D32';
    msg.textContent = 'Item lançado — aguardando aprovação do gestor oficial do setor.';
    renderCampos(); // limpa o formulário pro próximo lançamento
    await renderMeusLancamentos();
    toast('Item lançado.');
  } catch (e) {
    msg.textContent = 'Erro: ' + e.message;
  }
}

const LABEL_STATUS_SUBGESTOR = { pendente: 'Pendente de aprovação', aprovado: 'Aprovado' };
const CLASSE_STATUS_SUBGESTOR = { pendente: 'badge-analise', aprovado: 'badge-aberto' };

async function renderMeusLancamentos() {
  const tbody = document.getElementById('sg-meus-tbody');
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtual.id}/itens`);
    const itens = res.ok ? await res.json() : [];
    tbody.innerHTML = itens.map(i => {
      const setorNome = (_dfdAtual.setores || []).find(s => s.id === i.setor_id)?.nome || '—';
      const status = i.aprovacao_subgestor || 'pendente';
      return `<tr>
        <td>${setorNome}</td>
        <td>${fmtBr(i.criado_em)}</td>
        <td><span class="badge ${CLASSE_STATUS_SUBGESTOR[status] || 'badge-fechado'}">${LABEL_STATUS_SUBGESTOR[status] || status}</span></td>
      </tr>`;
    }).join('') || `<tr><td colspan="3" style="padding:16px;text-align:center;color:var(--text-subtle);">Nenhum lançamento seu ainda neste DFD.</td></tr>`;
  } catch {
    tbody.innerHTML = `<tr><td colspan="3" style="padding:16px;text-align:center;color:var(--text-subtle);">Erro ao carregar.</td></tr>`;
  }
}

document.addEventListener('DOMContentLoaded', boot);
