// ── Utilitários ───────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
const processoId = params.get('processo_id');

function fmtBr(iso) {
  if (!iso) return '—';
  // Separador entre data e hora varia: 'T' em datas ISO, espaço em DATETIME do SQLite (criado_em)
  const d = iso.split(/[T ]/)[0].split('-');
  if (d.length < 3) return iso;
  return `${d[2]}/${d[1]}/${d[0]}`;
}

function fmtMoeda(v) {
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '';
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function parseMoeda(s) {
  if (!s || s === '') return null;
  const v = parseFloat(String(s).replace(/[R$\s.]/g, '').replace(',', '.'));
  return isNaN(v) ? null : v;
}

// Campo de valor percentual: não tem separador de milhar, então (diferente de
// parseMoeda) não pode remover "." da string — só troca vírgula por ponto.
function parsePercentual(s) {
  if (!s || s === '') return null;
  const v = parseFloat(String(s).trim().replace(',', '.'));
  return isNaN(v) ? null : v;
}
function fmtPercentualCampo(v) {
  return v === null || v === undefined || isNaN(v) ? '' : String(v).replace('.', ',');
}

function fmtPercentualTotal(v) {
  const arred = Math.round(v * 100) / 100;
  return `${arred.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  setTimeout(() => { el.className = ''; }, 3500);
}

// ── Labels de coluna (editáveis, salvas por processo no localStorage) ─────────

const COL_DEFAULTS  = { unit: 'R$ UNIT/MÊS', total: 'R$ TOTAL/ANO' };
const MODE_LABELS   = { '*': '×', '=': '=', 'digitar': '✎' };
const MODE_TITLES   = { '*': 'Total = Qtde × Unit', '=': 'Total = Unit', 'digitar': 'Digitar total' };;

function getColLabel(key) {
  return localStorage.getItem(`secop_col_${key}_${processoId}`) || COL_DEFAULTS[key];
}

function aplicarCabecalhosColuna() {
  const u = document.getElementById('lbl-col-unit');
  const t = document.getElementById('lbl-col-total');
  if (u) u.textContent = getColLabel('unit');
  if (t) t.textContent = getColLabel('total');
}

function editarCabecalhoColuna(key) {
  const novo = prompt('Nome da coluna:', getColLabel(key));
  if (novo !== null && novo.trim()) {
    localStorage.setItem(`secop_col_${key}_${processoId}`, novo.trim());
    aplicarCabecalhosColuna();
  }
}

// ── Estado global ─────────────────────────────────────────────────────────────

let processo      = null;
let fornecedores  = [];
let itens         = [];
let tiposExtra    = []; // catálogo Unidade+Descrição (Configurações → Itens Extras)
let currentFornId = null;
let podeEditarForn = true;
let fornecedorAtivo = false; // só true depois de clicar "+ Novo fornecedor" ou "Editar" — trava edição acidental antes disso

function campoHabilitado() {
  return podeEditarForn && fornecedorAtivo;
}

// Sinal (positivo/negativo) e tipo de valor (fixo em R$ ou percentual) vêm do
// catálogo tipos_extra, amarrados à Unidade escolhida
function sinalDoTipo(unidade) {
  const t = tiposExtra.find(x => x.unidade === unidade);
  return t?.sinal === 'negativo' ? 'negativo' : 'positivo';
}
function tipoValorDoTipo(unidade) {
  const t = tiposExtra.find(x => x.unidade === unidade);
  return t?.tipo_valor === 'percentual' ? 'percentual' : 'fixo';
}

// Bloqueia/libera os campos estáticos do formulário (fora da tabela de preços,
// que se regenera sozinha em renderTabelaPrecos usando campoHabilitado()).
function aplicarBloqueioSelecao() {
  if (!podeEditarForn) return; // aplicarPermissaoUI já cuida desse caso
  const habilitado = fornecedorAtivo;
  document.querySelectorAll('#forn-form-card input, #forn-form-card textarea')
    .forEach(el => { el.disabled = !habilitado; });
  document.getElementById('btn-salvar-forn').disabled = !habilitado;
  document.getElementById('btn-novo-extra').disabled  = !habilitado;
  if (!habilitado) {
    document.getElementById('forn-form-title').textContent =
      'Selecione "+ Novo fornecedor" ou clique em "Editar" num fornecedor da lista';
  }
}

function aplicarPermissaoUI() {
  if (podeEditarForn) return;

  document.getElementById('btn-novo-forn').style.display   = 'none';
  document.getElementById('btn-salvar-forn').style.display = 'none';
  document.getElementById('btn-cancelar').style.display    = 'none';
  document.getElementById('btn-novo-extra').style.display  = 'none';

  document.querySelectorAll('#forn-form-card input, #forn-form-card textarea')
    .forEach(el => { el.disabled = true; });

  const aviso = document.createElement('div');
  aviso.style.cssText = 'background:#FFF8E1;border:1px solid #FFE082;border-radius:6px;padding:10px 14px;font-size:13px;color:#795548;margin-bottom:16px;line-height:1.5;';
  aviso.textContent = 'Somente visualização — você não tem permissão para editar esta cotação.';
  document.getElementById('content').prepend(aviso);
}

// "Incluso Frete" (Sim/Não) e "Termo" (CIF/FOB) são marcações independentes.
// Normaliza também registros salvos na janela entre v3.8.2 e v3.8.3, quando
// CIF/FOB ainda podiam vir gravados direto em "frete" (sem frete_termo existir).
function normalizarFrete(f) {
  let frete = f.frete || '';
  let termo = f.frete_termo || '';
  if (!termo && (frete === 'CIF' || frete === 'FOB')) { termo = frete; frete = ''; }
  else if (frete === 'Incluso') { frete = 'Sim'; }
  return { frete, termo };
}

// ── Carregar processo ─────────────────────────────────────────────────────────

async function carregar() {
  if (!processoId) {
    document.getElementById('loader').textContent = 'ID do processo não informado.';
    return;
  }
  try {
    const res = await fetch(`/api/processos/${processoId}`);
    if (!res.ok) throw new Error();
    const data = await res.json();

    processo    = data;
    fornecedores = data.fornecedores || [];
    itens        = data.itens || [];

    try {
      const resExtra = await fetch('/api/tipos-extra');
      tiposExtra = resExtra.ok ? await resExtra.json() : [];
    } catch { tiposExtra = []; }

    const user = await getCurrentUser();
    podeEditarForn = !!user && (user.role === 'admin' || data.criado_por_id === user.id);

    document.getElementById('bread-processo').textContent =
      `Processo ${processo.numero_processo} — ${processo.objeto}`;
    document.title = `Fornecedores — ${processo.numero_processo}`;

    renderFornecedores();
    renderTabelaPrecos({});
    atualizarBtnQuadro();
    aplicarCabecalhosColuna();
    aplicarPermissaoUI();
    aplicarBloqueioSelecao();

    document.getElementById('loader').style.display  = 'none';
    document.getElementById('content').style.display = 'block';
  } catch {
    document.getElementById('loader').textContent = 'Processo não encontrado.';
  }
}

// ── Re-busca lista do banco e re-renderiza badges ────────────────────────────

async function recarregarFornecedores() {
  const res = await fetch(`/api/processos/${processoId}`);
  const data = await res.json();
  fornecedores = data.fornecedores || [];
  renderFornecedores();
  atualizarBtnQuadro();
}

// ── Lista de fornecedores (badges) ────────────────────────────────────────────

function renderFornecedores() {
  const container = document.getElementById('forn-list');
  if (!fornecedores.length) {
    container.innerHTML = '<span class="text-muted" style="font-size:13px;">Nenhum fornecedor cadastrado ainda.</span>';
    return;
  }
  container.innerHTML = fornecedores.map(f => `
    <div style="display:inline-flex;align-items:center;gap:6px;background:#f0f4f8;border:1.5px solid #d1d9e0;border-radius:8px;padding:7px 12px;">
      <span style="font-size:13px;font-weight:600;color:#222;">${f.nome || '(sem nome)'}</span>
      <button class="btn btn-secondary btn-sm" onclick="editarFornecedor(${f.id})">${podeEditarForn ? 'Editar' : 'Ver'}</button>
      ${podeEditarForn ? `<button class="btn btn-danger btn-sm" onclick="removerFornecedor(${f.id}, '${(f.nome || '').replace(/'/g, "\\'")}')">Remover</button>` : ''}
    </div>
  `).join('');
}

function atualizarBtnQuadro() {
  const btn = document.getElementById('btn-ver-quadro');
  if (fornecedores.length >= 2) {
    btn.style.display = 'inline-flex';
    btn.href = `cotacao.html?id=${processoId}`;
  } else {
    btn.style.display = 'none';
  }
}

// ── Carregar fornecedor para edição ───────────────────────────────────────────

async function editarFornecedor(id) {
  try {
    const res = await fetch(`/api/fornecedores/${id}`);
    if (!res.ok) throw new Error();
    const f = await res.json();

    currentFornId = f.id;
    fornecedorAtivo = true;
    aplicarBloqueioSelecao();
    document.getElementById('forn-form-title').textContent = `Editando: ${f.nome || 'Fornecedor'}`;

    document.getElementById('f-nome').value     = f.nome     || '';
    document.getElementById('f-contato').value  = f.contato  || '';
    document.getElementById('f-telefone').value = f.telefone || '';
    document.getElementById('f-celular').value  = f.celular  || '';
    document.getElementById('f-email').value    = f.email    || '';

    // data_proposta já vem como YYYY-MM-DD do banco; suporta também DD/MM/AAAA antigo
    let dp = f.data_proposta || '';
    if (dp && dp.includes('/')) {
      const parts = dp.split('/');
      if (parts.length === 3) dp = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
    }
    document.getElementById('f-data-proposta').value = dp;

    // Incluso Frete (Sim/Não) e Termo (CIF/FOB) são marcações independentes
    const { frete: freteVal, termo: termoVal } = normalizarFrete(f);
    document.querySelectorAll('input[name="f-frete"]').forEach(r => { r.checked = r.value === freteVal; });
    document.querySelectorAll('input[name="f-frete-termo"]').forEach(r => { r.checked = r.value === termoVal; });

    document.getElementById('f-prazo-ent').value   = f.prazo_entrega   || '';
    document.getElementById('f-prazo-pag').value   = f.prazo_pagamento || '';
    document.getElementById('f-prazo-gar').value   = f.prazo_garantia  || '';
    document.getElementById('f-observacoes').value = f.observacoes     || '';

    // Proposta: campos manuais — valor numérico puro (sem formatação de moeda)
    document.getElementById('f-prop-ini').value = f.proposta_inicial != null ? f.proposta_inicial : '';
    document.getElementById('f-prop-fin').value = f.proposta_final   != null ? f.proposta_final   : '';

    const precosMap = {};
    (f.precos || []).forEach(p => {
      precosMap[p.item_id] = { preco_unitario_mes: p.preco_unitario_mes, preco_total_ano: p.preco_total_ano };
    });
    renderTabelaPrecos(precosMap);

    document.getElementById('f-pesquisa-internet').checked = !!f.pesquisa_internet;
    document.getElementById('f-pesquisa-compra-publica').checked = !!f.pesquisa_compra_publica;
    document.getElementById('f-declinio').checked = !!f.declinio;

    document.getElementById('forn-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    toast('Erro ao carregar fornecedor.', 'error');
  }
}

// ── Remover fornecedor ────────────────────────────────────────────────────────
// Confirmação reforçada com modal (em vez do confirm() nativo, fácil de clicar
// sem prestar atenção) — o botão "Sim, remover" nunca fica com foco padrão.

let _removerPendente = null;

function removerFornecedor(id, nome) {
  _removerPendente = { id, nome };
  document.getElementById('modal-remover-texto').textContent =
    `Tem certeza que deseja remover "${nome}" e todos os preços já preenchidos para ele? Essa ação não pode ser desfeita.`;
  document.getElementById('modal-remover-forn').classList.add('open');
  setTimeout(() => document.getElementById('btn-cancelar-remover').focus(), 50);
}

function fecharModalRemover() {
  _removerPendente = null;
  document.getElementById('modal-remover-forn').classList.remove('open');
}

document.getElementById('btn-cancelar-remover').addEventListener('click', fecharModalRemover);
document.getElementById('modal-remover-forn').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-remover-forn')) fecharModalRemover();
});

document.getElementById('btn-confirmar-remover').addEventListener('click', async () => {
  if (!_removerPendente) return;
  const { id } = _removerPendente;
  fecharModalRemover();
  try {
    await fetch(`/api/fornecedores/${id}`, { method: 'DELETE' });
    toast('Fornecedor removido.', 'success');
    await recarregarFornecedores();
    if (currentFornId === id) {
      fornecedorAtivo = false;
      limparFormulario();
      aplicarBloqueioSelecao();
    }
  } catch {
    toast('Erro ao remover fornecedor.', 'error');
  }
});

// ── Limpar formulário ─────────────────────────────────────────────────────────

function limparFormulario() {
  currentFornId = null;
  document.getElementById('forn-form-title').textContent = 'Novo fornecedor';
  ['f-nome','f-contato','f-telefone','f-celular','f-email',
   'f-prazo-ent','f-prazo-pag','f-prazo-gar','f-prop-ini','f-prop-fin'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('f-data-proposta').value = '';
  document.getElementById('f-observacoes').value  = '';
  document.querySelectorAll('input[name="f-frete"]').forEach(r => { r.checked = false; });
  document.querySelectorAll('input[name="f-frete-termo"]').forEach(r => { r.checked = false; });
  document.getElementById('f-pesquisa-internet').checked = false;
  document.getElementById('f-pesquisa-compra-publica').checked = false;
  document.getElementById('f-declinio').checked = false;
  renderTabelaPrecos({});
}

// ── Tabela de preços ──────────────────────────────────────────────────────────

function aplicarModo(unitInp, totInp, mode) {
  const unit = parseMoeda(unitInp.value);
  if (unit === null) return;
  const qty = parseFloat(unitInp.dataset.qtd) || 0;
  totInp.value = mode === '=' ? fmtMoeda(unit) : fmtMoeda(unit * qty);
  recalcTotal();
}

function renderTabelaPrecos(precosMap) {
  const tbody = document.getElementById('precos-tbody');

  if (!itens.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#aaa;">Nenhum item cadastrado no processo.</td></tr>';
    return;
  }

  let total      = 0;
  let totalMoeda = 0; // só a parte em R$ (itens normais + extras fixos) — decide se o total geral vira % ou R$
  let rows  = '';
  itens.forEach(item => {
    const p = precosMap[item.id] || {};
    const rawTot = p.preco_total_ano ?? (p.preco_unitario_mes != null ? p.preco_unitario_mes * item.quantidade : '');
    if (rawTot !== '') {
      let v = parseFloat(rawTot) || 0;
      // Sinal relido do catálogo atual, não do que foi gravado — se o Sinal do
      // tipo mudar depois de já ter valor lançado, o total já reflete na hora.
      if (item.extra) v = sinalDoTipo(item.unidade) === 'negativo' ? -Math.abs(v) : Math.abs(v);
      total += v;
      if (!(item.extra && tipoValorDoTipo(item.unidade) === 'percentual')) totalMoeda += v;
    }

    let unit      = p.preco_unitario_mes ?? '';
    let storedTot = p.preco_total_ano;
    // Linha extra: o sinal (+/-) é definido pelo tipo, não digitado — o campo
    // sempre mostra a magnitude (valor absoluto), o sinal é aplicado ao salvar.
    if (item.extra) {
      if (unit !== '')       unit      = Math.abs(parseFloat(unit));
      if (storedTot != null) storedTot = Math.abs(parseFloat(storedTot));
    }
    const tot = storedTot ?? (unit !== '' ? parseFloat(unit) * item.quantidade : '');

    // Detectar modo inicial com base nos valores armazenados
    let initialMode = '*';
    if (storedTot != null && unit !== '') {
      const u = parseFloat(unit) || 0;
      const t = parseFloat(storedTot) || 0;
      const q = parseFloat(item.quantidade) || 0;
      if (u > 0 && Math.abs(t - u) < 0.01)       initialMode = '=';
      else if (u > 0 && Math.abs(t - u * q) >= 0.01) initialMode = 'digitar';
    }

    const hadPrice = p.preco_unitario_mes != null || p.preco_total_ano != null;
    const habilitado = campoHabilitado();
    const sinalItem     = item.extra ? sinalDoTipo(item.unidade)     : null;
    const tipoValorItem = item.extra ? tipoValorDoTipo(item.unidade) : 'fixo';

    // Colunas Item/Qtde/Unid./Descrição: fixas pra item normal, editáveis pra linha extra
    const colsEsquerda = item.extra
      ? `
        <td class="col-fixed">
          <span style="font-size:10px;font-weight:700;">EXTRA</span>
          <span class="extra-sinal-badge" style="font-size:10px;font-weight:700;">${sinalItem === 'negativo' ? '(-)' : '(+)'}</span>
          <button type="button" onclick="removerItemExtra(${item.id})" title="Remover linha extra" ${habilitado ? '' : 'disabled'}
            style="margin-left:4px;background:none;border:none;cursor:pointer;color:inherit;">✕</button>
        </td>
        <td class="col-fixed"><input type="number" class="extra-qtd" data-item="${item.id}" step="any" ${habilitado ? '' : 'disabled'}
          value="${item.quantidade ?? ''}" style="width:60px;" /></td>
        <td class="col-fixed">
          <select class="extra-unidade" data-item="${item.id}" ${habilitado ? '' : 'disabled'} style="max-width:110px;">
            <option value="">Selecione...</option>
            ${tiposExtra.map(t => `<option value="${t.unidade}" data-desc="${t.descricao.replace(/"/g,'&quot;')}"${t.unidade === item.unidade ? ' selected' : ''}>${t.unidade}</option>`).join('')}
          </select>
        </td>
        <td class="col-fixed"><input type="text" class="extra-desc" data-item="${item.id}" ${habilitado ? '' : 'disabled'}
          value="${item.descricao || ''}" style="min-width:160px;" /></td>`
      : `
        <td class="col-fixed">${item.item_num}</td>
        <td class="col-fixed">${item.quantidade}</td>
        <td class="col-fixed">${item.unidade || ''}</td>
        <td class="col-fixed">${item.descricao}</td>`;

    // Linha extra percentual: um único campo "valor %" — sem qtde × unitário,
    // sem alternância de modo (não faz sentido multiplicar percentual por qtde).
    const colsPreco = (item.extra && tipoValorItem === 'percentual')
      ? `
        <td><input type="text" class="preco-unit extra-pct" data-item="${item.id}"
          data-had-price="${hadPrice ? '1' : '0'}" ${habilitado ? '' : 'disabled'}
          value="${unit !== '' ? fmtPercentualCampo(unit) : ''}" placeholder="0" style="text-align:right;" /></td>
        <td class="mode-btn-td" style="text-align:center;font-weight:700;">%</td>
        <td><input type="text" class="preco-total extra-pct" data-item="${item.id}" readonly
          value="${tot !== '' ? fmtPercentualCampo(tot) : ''}" placeholder="0" style="text-align:right;background:var(--surface-2);" /></td>`
      : `
        <td><input type="text" class="preco-unit" data-item="${item.id}" data-qtd="${item.quantidade}"
          data-had-price="${hadPrice ? '1' : '0'}" ${habilitado ? '' : 'disabled'}
          value="${unit !== '' ? fmtMoeda(unit) : ''}" placeholder="R$ 0,00" /></td>
        <td class="mode-btn-td"><button type="button" class="mode-cycle-btn" data-mode="${initialMode}" ${habilitado ? '' : 'disabled'}
          title="${MODE_TITLES[initialMode]}">${MODE_LABELS[initialMode]}</button></td>
        <td><input type="text" class="preco-total" data-item="${item.id}"
          ${initialMode !== 'digitar' || !habilitado ? 'readonly' : ''}
          value="${tot !== '' ? fmtMoeda(tot) : ''}" placeholder="R$ 0,00" /></td>`;

    rows += `
      <tr class="${item.extra ? 'row-extra ' + (sinalItem === 'negativo' ? 'row-extra-neg' : 'row-extra-pos') : ''}">
        ${colsEsquerda}
        ${colsPreco}
      </tr>`;
  });

  const totalEhPercentual = totalMoeda === 0 && total !== 0;
  rows += `
    <tr class="row-section-header">
      <td colspan="6">VALOR TOTAL</td>
      <td id="total-geral">${total === 0 ? '—' : (totalEhPercentual ? fmtPercentualTotal(total) : fmtMoeda(total))}</td>
    </tr>`;

  tbody.innerHTML = rows;

  // ── Linhas extras: selecionar Unidade preenche a Descrição e re-renderiza —
  // sinal (cor) e tipo de valor (fixo × percentual) mudam a estrutura da linha,
  // então um patch incremental não é suficiente, precisa recriar a linha inteira.
  tbody.querySelectorAll('.extra-unidade').forEach(sel => {
    sel.addEventListener('change', () => {
      const opt  = sel.options[sel.selectedIndex];
      const desc = sel.closest('tr').querySelector('.extra-desc');
      if (desc && opt?.dataset.desc) desc.value = opt.dataset.desc;

      const precosAtuais = coletarPrecosAtuais();
      sincronizarExtrasDoDOM();
      renderTabelaPrecos(precosAtuais);
    });
  });

  // ── Listeners nos campos de preço ─────────────────────────────────────────

  tbody.querySelectorAll('.preco-unit').forEach(inp => {
    // Linha extra percentual: campo único, sem moeda e sem modo — só espelha o
    // número digitado no campo total (que é readonly) e recalcula.
    if (inp.classList.contains('extra-pct')) {
      inp.addEventListener('input', () => {
        const totInp = inp.closest('tr').querySelector('.preco-total');
        if (totInp) totInp.value = inp.value;
        recalcTotal();
      });
      inp.addEventListener('blur', () => {
        const v = parsePercentual(inp.value);
        inp.value = fmtPercentualCampo(v);
        const totInp = inp.closest('tr').querySelector('.preco-total');
        if (totInp) totInp.value = inp.value;
      });
      return;
    }
    inp.addEventListener('input', () => {
      const row     = inp.closest('tr');
      const modeBtn = row.querySelector('.mode-cycle-btn');
      const mode    = modeBtn?.dataset.mode || '*';
      const totInp  = row.querySelector('.preco-total');
      const unit    = parseMoeda(inp.value);
      if (unit === null && mode !== 'digitar') {
        totInp.value = '';
        recalcTotal();
      } else if (mode !== 'digitar') {
        aplicarModo(inp, totInp, mode);
      } else {
        recalcTotal();
      }
    });
    inp.addEventListener('blur', () => { inp.value = fmtMoeda(parseMoeda(inp.value)); });
  });

  tbody.querySelectorAll('.preco-total').forEach(inp => {
    if (inp.classList.contains('extra-pct')) return; // espelhado a partir do campo % acima, não reformata
    inp.addEventListener('input',  recalcTotal);
    inp.addEventListener('blur',   () => { inp.value = fmtMoeda(parseMoeda(inp.value)); });
  });

  // ── Listeners nos botões de modo ──────────────────────────────────────────
  tbody.querySelectorAll('.mode-cycle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row     = btn.closest('tr');
      const unitInp = row.querySelector('.preco-unit');
      const totInp  = row.querySelector('.preco-total');
      const modes   = ['*', '=', 'digitar'];
      const newMode = modes[(modes.indexOf(btn.dataset.mode) + 1) % modes.length];
      btn.dataset.mode  = newMode;
      btn.textContent   = MODE_LABELS[newMode];
      btn.title         = MODE_TITLES[newMode];
      totInp.readOnly   = newMode !== 'digitar';
      if (newMode !== 'digitar') aplicarModo(unitInp, totInp, newMode);
    });
  });

  recalcTotal();
}

function recalcTotal() {
  let total      = 0;
  let totalMoeda = 0; // só a parte em R$ — decide se o total geral vira % ou R$
  document.querySelectorAll('#precos-tbody .preco-total').forEach(inp => {
    const itemId = inp.dataset.item;
    const item   = itens.find(i => String(i.id) === String(itemId));
    const ehPercentual = inp.classList.contains('extra-pct');
    let v = (ehPercentual ? parsePercentual(inp.value) : parseMoeda(inp.value)) || 0;
    // Linhas extras exibem magnitude no campo — aplica o sinal do tipo pro total geral bater com o que será salvo
    if (item?.extra) {
      const uniSel = document.querySelector(`.extra-unidade[data-item="${itemId}"]`);
      const sinal  = sinalDoTipo(uniSel?.value || '');
      v = sinal === 'negativo' ? -Math.abs(v) : Math.abs(v);
    }
    total += v;
    if (!ehPercentual) totalMoeda += v;
  });
  const cell = document.getElementById('total-geral');
  if (!cell) return;
  const totalEhPercentual = totalMoeda === 0 && total !== 0;
  cell.textContent = total === 0 ? '—' : (totalEhPercentual ? fmtPercentualTotal(total) : fmtMoeda(total));
}

// ── Linha extra (item ad-hoc do fornecedor, ex: TAXA) ─────────────────────────

// Lê o que já está digitado na tabela (preços de todos os itens + qtde/unidade/
// descrição das linhas extras) — usado antes de re-renderizar, pra não perder
// nada que o usuário já tinha preenchido e ainda não salvou.
function coletarPrecosAtuais() {
  const map = {};
  document.querySelectorAll('#precos-tbody .preco-unit').forEach(inp => {
    const id = inp.dataset.item;
    const totInp = document.querySelector(`#precos-tbody .preco-total[data-item="${id}"]`);
    const parse  = inp.classList.contains('extra-pct') ? parsePercentual : parseMoeda;
    map[id] = {
      preco_unitario_mes: parse(inp.value),
      preco_total_ano:    parse(totInp?.value)
    };
  });
  return map;
}

function sincronizarExtrasDoDOM() {
  itens.forEach(item => {
    if (!item.extra) return;
    const qtdInp  = document.querySelector(`.extra-qtd[data-item="${item.id}"]`);
    const uniSel  = document.querySelector(`.extra-unidade[data-item="${item.id}"]`);
    const descInp = document.querySelector(`.extra-desc[data-item="${item.id}"]`);
    if (qtdInp)  item.quantidade = parseFloat(qtdInp.value) || 0;
    if (uniSel)  item.unidade    = uniSel.value || '';
    if (descInp) item.descricao  = descInp.value || '';
  });
}

async function adicionarItemExtra() {
  if (!campoHabilitado()) return;
  const proximoNum = itens.reduce((max, i) => Math.max(max, i.item_num || 0), 0) + 1;
  try {
    const res = await fetch(`/api/processos/${processoId}/itens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_num: proximoNum, quantidade: 1, unidade: '', descricao: '', extra: 1 })
    });
    if (!res.ok) throw new Error();
    const { id } = await res.json();
    const precosAtuais = coletarPrecosAtuais();
    sincronizarExtrasDoDOM();
    itens.push({ id, processo_id: processoId, item_num: proximoNum, quantidade: 1, unidade: '', descricao: '', extra: 1 });
    renderTabelaPrecos(precosAtuais);
  } catch {
    toast('Erro ao adicionar item extra.', 'error');
  }
}

async function removerItemExtra(id) {
  if (!confirm('Remover esta linha extra?')) return;
  try {
    await fetch(`/api/itens/${id}`, { method: 'DELETE' });
    const precosAtuais = coletarPrecosAtuais();
    sincronizarExtrasDoDOM();
    itens = itens.filter(i => i.id !== id);
    renderTabelaPrecos(precosAtuais);
  } catch {
    toast('Erro ao remover item extra.', 'error');
  }
}

// ── Salvar fornecedor (lógica extraída para reuso) ────────────────────────────

async function salvarFornecedorAtual() {
  const frete       = document.querySelector('input[name="f-frete"]:checked')?.value || '';
  const frete_termo = document.querySelector('input[name="f-frete-termo"]:checked')?.value || '';

  const payload = {
    nome:             document.getElementById('f-nome').value.trim(),
    contato:          document.getElementById('f-contato').value.trim(),
    telefone:         document.getElementById('f-telefone').value.trim(),
    celular:          document.getElementById('f-celular').value.trim(),
    email:            document.getElementById('f-email').value.trim(),
    data_proposta:    document.getElementById('f-data-proposta').value,
    frete,
    frete_termo,
    prazo_entrega:    document.getElementById('f-prazo-ent').value.trim(),
    prazo_pagamento:  document.getElementById('f-prazo-pag').value.trim(),
    prazo_garantia:   document.getElementById('f-prazo-gar').value.trim(),
    observacoes:        document.getElementById('f-observacoes').value.trim() || null,
    proposta_inicial:   parseFloat(document.getElementById('f-prop-ini').value) || null,
    proposta_final:     parseFloat(document.getElementById('f-prop-fin').value) || null,
    pesquisa_internet:        document.getElementById('f-pesquisa-internet').checked ? 1 : 0,
    pesquisa_compra_publica:  document.getElementById('f-pesquisa-compra-publica').checked ? 1 : 0,
    declinio:                 document.getElementById('f-declinio').checked ? 1 : 0,
  };

  if (!payload.nome) throw new Error('Nome obrigatório');

  // Sinal atual de cada linha extra (lido do <select> na tela, não do array local
  // que pode estar desatualizado) — usado na trava abaixo e no salvamento dos preços.
  const unidadesExtraAtuais = {};
  document.querySelectorAll('#precos-tbody .extra-unidade').forEach(sel => {
    unidadesExtraAtuais[sel.dataset.item] = sel.value;
  });

  // Trava: não pode lançar valor numa linha extra sem o tipo (Unidade) definido
  for (const item of itens.filter(i => i.extra)) {
    const unitInp = document.querySelector(`#precos-tbody .preco-unit[data-item="${item.id}"]`);
    const totInp  = document.querySelector(`#precos-tbody .preco-total[data-item="${item.id}"]`);
    const parse    = unitInp?.classList.contains('extra-pct') ? parsePercentual : parseMoeda;
    const temValor = parse(unitInp?.value) !== null || parse(totInp?.value) !== null;
    if (temValor && !unidadesExtraAtuais[item.id]) throw new Error('extra_sem_tipo');
  }

  // Validação de preços mínimos
  const precoInputs = Array.from(document.querySelectorAll('#precos-tbody .preco-unit'));
  if (precoInputs.length > 0) {
    const preenchidos = precoInputs.filter(inp => {
      const parse = inp.classList.contains('extra-pct') ? parsePercentual : parseMoeda;
      const u = parse(inp.value);
      const totInp = document.querySelector(`#precos-tbody .preco-total[data-item="${inp.dataset.item}"]`);
      const t = parse(totInp?.value);
      return (u !== null && u !== 0) || (t !== null && t !== 0);
    });
    if (itens.length === 1 && preenchidos.length === 0) throw new Error('preco_obrigatorio');
    if (itens.length > 1  && preenchidos.length === 0) throw new Error('preco_minimo');
  }

  let resolvedId = currentFornId;
  if (!resolvedId) {
    const res = await fetch(`/api/processos/${processoId}/fornecedores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    resolvedId    = json.id;
    currentFornId = resolvedId;
  } else {
    await fetch(`/api/fornecedores/${resolvedId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  // Salvar quantidade/unidade/descrição das linhas extras (itens normais não mudam esses campos aqui)
  for (const item of itens.filter(i => i.extra)) {
    const qtdInp  = document.querySelector(`.extra-qtd[data-item="${item.id}"]`);
    const uniSel  = document.querySelector(`.extra-unidade[data-item="${item.id}"]`);
    const descInp = document.querySelector(`.extra-desc[data-item="${item.id}"]`);
    if (!qtdInp) continue; // linha não está mais na tela (não deveria acontecer, mas por segurança)
    await fetch(`/api/itens/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item_num:  item.item_num,
        quantidade: parseFloat(qtdInp.value) || 0,
        unidade:    uniSel?.value || '',
        descricao:  descInp?.value.trim() || ''
      })
    });
  }

  // Salvar preços de cada item
  for (const inp of document.querySelectorAll('#precos-tbody .preco-unit')) {
    const itemId   = inp.dataset.item;
    const item     = itens.find(i => String(i.id) === String(itemId));
    const parse    = inp.classList.contains('extra-pct') ? parsePercentual : parseMoeda;
    let unit       = parse(inp.value);
    const totInp   = document.querySelector(`#precos-tbody .preco-total[data-item="${itemId}"]`);
    let tot        = parse(totInp?.value);
    const hadPrice = inp.dataset.hadPrice === '1';
    if (unit === null && tot === null && !hadPrice) continue;

    // Linha extra: campo mostra magnitude — o sinal do tipo é aplicado só agora, ao gravar
    if (item?.extra) {
      const sinal = sinalDoTipo(unidadesExtraAtuais[itemId] || '');
      if (unit !== null) unit = sinal === 'negativo' ? -Math.abs(unit) : Math.abs(unit);
      if (tot  !== null) tot  = sinal === 'negativo' ? -Math.abs(tot)  : Math.abs(tot);
    }

    await fetch('/api/precos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item_id:            itemId,
        fornecedor_id:      resolvedId,
        preco_unitario_mes: unit,
        preco_total_ano:    tot ?? (unit !== null ? unit * (parseFloat(inp.dataset.qtd) || 1) : null)
      })
    });
  }

  return { resolvedId, nome: payload.nome };
}

// ── Botão Salvar fornecedor ───────────────────────────────────────────────────

document.getElementById('btn-salvar-forn').addEventListener('click', async () => {
  const btn = document.getElementById('btn-salvar-forn');
  btn.disabled    = true;
  btn.textContent = 'Salvando...';
  try {
    const { nome } = await salvarFornecedorAtual();
    toast('Fornecedor salvo com sucesso!', 'success');
    await recarregarFornecedores();
    document.getElementById('forn-form-title').textContent = `Editando: ${nome}`;
  } catch (e) {
    if (e.message === 'Nome obrigatório') {
      toast('Informe o nome do fornecedor.', 'error');
    } else if (e.message === 'preco_obrigatorio') {
      toast('O único item não pode ficar sem preço ou com valor zero.', 'error');
    } else if (e.message === 'preco_minimo') {
      toast('Preencha o preço de pelo menos 1 item.', 'error');
    } else if (e.message === 'extra_sem_tipo') {
      toast('Selecione o tipo (Unidade) do item extra antes de lançar o valor.', 'error');
    } else {
      toast('Erro ao salvar fornecedor.', 'error');
      console.error(e);
    }
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Salvar fornecedor';
  }
});

// ── Botão Novo fornecedor (salva atual se preenchido, depois limpa) ───────────

document.getElementById('btn-novo-forn').addEventListener('click', async () => {
  const nome = document.getElementById('f-nome').value.trim();
  if (nome) {
    try {
      await salvarFornecedorAtual();
      toast('Fornecedor salvo!', 'success');
    } catch (e) {
      toast('Erro ao salvar fornecedor atual.', 'error');
      console.error(e);
      return; // não avança se falhou
    }
  }
  // Sempre re-busca a lista do banco antes de limpar
  await recarregarFornecedores();
  fornecedorAtivo = true;
  limparFormulario();
  aplicarBloqueioSelecao();
});

// ── Cancelar ──────────────────────────────────────────────────────────────────

document.getElementById('btn-cancelar').addEventListener('click', () => {
  fornecedorAtivo = false;
  limparFormulario();
  aplicarBloqueioSelecao();
});

// ── Adicionar item extra ──────────────────────────────────────────────────────

document.getElementById('btn-novo-extra').addEventListener('click', adicionarItemExtra);


// ── Pesquisa Internet / Pesquisa Compra Pública / Declínio são mutuamente exclusivos ──

const tipoFlags = ['f-pesquisa-internet', 'f-pesquisa-compra-publica', 'f-declinio'];
tipoFlags.forEach(id => {
  document.getElementById(id).addEventListener('change', function () {
    if (this.checked) tipoFlags.filter(o => o !== id).forEach(o => {
      document.getElementById(o).checked = false;
    });
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────

carregar();
initDatalistAutocomplete('f-nome',     'fornecedor_nome');
initDatalistAutocomplete('f-contato',  'fornecedor_contato');
initDatalistAutocomplete('f-prazo-ent','prazo_entrega');
initDatalistAutocomplete('f-prazo-pag','prazo_pagamento');
initDatalistAutocomplete('f-prazo-gar','prazo_garantia');
initSuggestAutocomplete('f-observacoes', 'fornecedor_observacoes');
