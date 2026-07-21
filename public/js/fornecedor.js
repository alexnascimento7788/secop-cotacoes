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
let currentFornId = null;
let podeEditarForn = true;
let fornecedorAtivo = false; // só true depois de clicar "+ Novo fornecedor" ou "Editar" — trava edição acidental antes disso

function campoHabilitado() {
  return podeEditarForn && fornecedorAtivo;
}

// Bloqueia/libera os campos estáticos do formulário (fora da tabela de preços,
// que se regenera sozinha em renderTabelaPrecos usando campoHabilitado()).
function aplicarBloqueioSelecao() {
  if (!podeEditarForn) return; // aplicarPermissaoUI já cuida desse caso
  const habilitado = fornecedorAtivo;
  document.querySelectorAll('#forn-form-card input, #forn-form-card textarea')
    .forEach(el => { el.disabled = !habilitado; });
  document.getElementById('btn-salvar-forn').disabled = !habilitado;
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

  document.querySelectorAll('#forn-form-card input, #forn-form-card textarea')
    .forEach(el => { el.disabled = true; });

  const aviso = document.createElement('div');
  aviso.style.cssText = 'background:#FFF8E1;border:1px solid #FFE082;border-radius:6px;padding:10px 14px;font-size:13px;color:#795548;margin-bottom:16px;line-height:1.5;';
  aviso.textContent = 'Somente visualização — você não tem permissão para editar esta cotação.';
  document.getElementById('content').prepend(aviso);
}

// "Incluso Frete" (Sim/Não) é valor legado "Incluso" mapeado pra Sim; CIF/FOB é campo à parte.
const FRETE_LEGACY_MAP = { 'Incluso': 'Sim' };

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
    const freteVal = FRETE_LEGACY_MAP[f.frete] || f.frete || '';
    document.querySelectorAll('input[name="f-frete"]').forEach(r => { r.checked = r.value === freteVal; });
    document.querySelectorAll('input[name="f-frete-termo"]').forEach(r => { r.checked = r.value === (f.frete_termo || ''); });

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

  let total = 0;
  let rows  = '';
  itens.forEach(item => {
    const p         = precosMap[item.id] || {};
    const unit      = p.preco_unitario_mes ?? '';
    const storedTot = p.preco_total_ano;
    const tot       = storedTot ?? (unit !== '' ? parseFloat(unit) * item.quantidade : '');
    if (tot !== '') total += parseFloat(tot) || 0;

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
    rows += `
      <tr>
        <td class="col-fixed">${item.item_num}</td>
        <td class="col-fixed">${item.quantidade}</td>
        <td class="col-fixed">${item.unidade || ''}</td>
        <td class="col-fixed">${item.descricao}</td>
        <td><input type="text" class="preco-unit" data-item="${item.id}" data-qtd="${item.quantidade}"
          data-had-price="${hadPrice ? '1' : '0'}" ${campoHabilitado() ? '' : 'disabled'}
          value="${unit !== '' ? fmtMoeda(unit) : ''}" placeholder="R$ 0,00" /></td>
        <td class="mode-btn-td"><button type="button" class="mode-cycle-btn" data-mode="${initialMode}" ${campoHabilitado() ? '' : 'disabled'}
          title="${MODE_TITLES[initialMode]}">${MODE_LABELS[initialMode]}</button></td>
        <td><input type="text" class="preco-total" data-item="${item.id}"
          ${initialMode !== 'digitar' || !campoHabilitado() ? 'readonly' : ''}
          value="${tot !== '' ? fmtMoeda(tot) : ''}" placeholder="R$ 0,00" /></td>
      </tr>`;
  });

  rows += `
    <tr class="row-section-header">
      <td colspan="6">VALOR TOTAL</td>
      <td id="total-geral">${total > 0 ? fmtMoeda(total) : '—'}</td>
    </tr>`;

  tbody.innerHTML = rows;

  // ── Listeners nos campos de preço ─────────────────────────────────────────

  tbody.querySelectorAll('.preco-unit').forEach(inp => {
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
  let total = 0;
  document.querySelectorAll('#precos-tbody .preco-total').forEach(inp => {
    total += parseMoeda(inp.value) || 0;
  });
  const cell = document.getElementById('total-geral');
  if (cell) cell.textContent = total > 0 ? fmtMoeda(total) : '—';
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

  // Validação de preços mínimos
  const precoInputs = Array.from(document.querySelectorAll('#precos-tbody .preco-unit'));
  if (precoInputs.length > 0) {
    const preenchidos = precoInputs.filter(inp => {
      const u = parseMoeda(inp.value);
      const totInp = document.querySelector(`#precos-tbody .preco-total[data-item="${inp.dataset.item}"]`);
      const t = parseMoeda(totInp?.value);
      return (u !== null && u > 0) || (t !== null && t > 0);
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

  // Salvar preços de cada item
  for (const inp of document.querySelectorAll('#precos-tbody .preco-unit')) {
    const unit     = parseMoeda(inp.value);
    const totInp   = document.querySelector(`#precos-tbody .preco-total[data-item="${inp.dataset.item}"]`);
    const tot      = parseMoeda(totInp?.value);
    const hadPrice = inp.dataset.hadPrice === '1';
    if (unit === null && tot === null && !hadPrice) continue;

    await fetch('/api/precos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item_id:            inp.dataset.item,
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
