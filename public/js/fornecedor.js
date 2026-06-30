// ── Utilitários ───────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
const processoId = params.get('processo_id');

function fmtBr(iso) {
  if (!iso) return '—';
  const d = iso.split('T')[0].split('-');
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

// ── Estado global ─────────────────────────────────────────────────────────────

let processo      = null;
let fornecedores  = [];
let itens         = [];
let currentFornId = null;

const FRETE_INCLUSO_VALS = ['Sim', 'Incluso'];

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

    document.getElementById('bread-processo').textContent =
      `Processo ${processo.numero_processo} — ${processo.objeto}`;
    document.title = `Fornecedores — ${processo.numero_processo}`;

    renderFornecedores();
    renderTabelaPrecos({});
    atualizarBtnQuadro();

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
      <button class="btn btn-secondary btn-sm" onclick="editarFornecedor(${f.id})">Editar</button>
      <button class="btn btn-danger btn-sm" onclick="removerFornecedor(${f.id}, '${(f.nome || '').replace(/'/g, "\\'")}')">Remover</button>
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

    // Frete Sim/Não — compatível com valores antigos (Incluso → Sim, etc.)
    const freteVal = f.frete || '';
    const freteSimNao = FRETE_INCLUSO_VALS.includes(freteVal) ? 'Sim'
      : (freteVal && freteVal !== '' ? 'Não' : '');
    document.querySelectorAll('input[name="f-frete"]').forEach(r => { r.checked = r.value === freteSimNao; });

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

    document.getElementById('forn-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    toast('Erro ao carregar fornecedor.', 'error');
  }
}

// ── Remover fornecedor ────────────────────────────────────────────────────────

async function removerFornecedor(id, nome) {
  if (!confirm(`Remover fornecedor "${nome}" e todos os seus preços?`)) return;
  try {
    await fetch(`/api/fornecedores/${id}`, { method: 'DELETE' });
    toast('Fornecedor removido.', 'success');
    await recarregarFornecedores();
    if (currentFornId === id) limparFormulario();
  } catch {
    toast('Erro ao remover fornecedor.', 'error');
  }
}

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
  renderTabelaPrecos({});
}

// ── Tabela de preços ──────────────────────────────────────────────────────────

function renderTabelaPrecos(precosMap) {
  const tbody = document.getElementById('precos-tbody');

  if (!itens.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#aaa;">Nenhum item cadastrado no processo.</td></tr>';
    return;
  }

  let total = 0;
  let rows  = '';
  itens.forEach(item => {
    const p    = precosMap[item.id] || {};
    const unit = p.preco_unitario_mes ?? '';
    const tot  = p.preco_total_ano    ?? (unit !== '' ? parseFloat(unit) * item.quantidade : '');
    if (tot !== '') total += parseFloat(tot) || 0;
    rows += `
      <tr>
        <td class="col-fixed">${item.item_num}</td>
        <td class="col-fixed">${item.quantidade}</td>
        <td class="col-fixed">${item.unidade || ''}</td>
        <td class="col-fixed">${item.descricao}</td>
        <td><input type="text" class="preco-unit" data-item="${item.id}" data-qtd="${item.quantidade}"
          value="${unit !== '' ? fmtMoeda(unit) : ''}" placeholder="R$ 0,00" /></td>
        <td><input type="text" class="preco-total" data-item="${item.id}"
          value="${tot !== '' ? fmtMoeda(tot) : ''}" placeholder="R$ 0,00" /></td>
      </tr>`;
  });

  rows += `
    <tr class="row-section-header">
      <td colspan="4">VALOR TOTAL</td>
      <td colspan="2" id="total-geral">${total > 0 ? fmtMoeda(total) : '—'}</td>
    </tr>`;

  tbody.innerHTML = rows;

  // ── Listeners nos campos de preço ─────────────────────────────────────────

  tbody.querySelectorAll('.preco-unit').forEach(inp => {
    // 'input': calcula total da linha imediatamente enquanto o usuário digita
    inp.addEventListener('input', () => {
      const qty  = parseFloat(inp.dataset.qtd) || 0;
      const unit = parseMoeda(inp.value);
      if (unit === null) return;
      const tot    = unit * qty;
      const totInp = tbody.querySelector(`.preco-total[data-item="${inp.dataset.item}"]`);
      if (totInp) totInp.value = fmtMoeda(tot);
      recalcTotal();
    });
    // 'blur': formata o valor digitado como moeda
    inp.addEventListener('blur', () => { inp.value = fmtMoeda(parseMoeda(inp.value)); });
  });

  tbody.querySelectorAll('.preco-total').forEach(inp => {
    inp.addEventListener('input',  recalcTotal);
    inp.addEventListener('blur',   () => { inp.value = fmtMoeda(parseMoeda(inp.value)); });
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
  const frete = document.querySelector('input[name="f-frete"]:checked')?.value || '';

  const payload = {
    nome:             document.getElementById('f-nome').value.trim(),
    contato:          document.getElementById('f-contato').value.trim(),
    telefone:         document.getElementById('f-telefone').value.trim(),
    celular:          document.getElementById('f-celular').value.trim(),
    email:            document.getElementById('f-email').value.trim(),
    data_proposta:    document.getElementById('f-data-proposta').value,
    frete,
    prazo_entrega:    document.getElementById('f-prazo-ent').value.trim(),
    prazo_pagamento:  document.getElementById('f-prazo-pag').value.trim(),
    prazo_garantia:   document.getElementById('f-prazo-gar').value.trim(),
    observacoes:      document.getElementById('f-observacoes').value.trim() || null,
    proposta_inicial: parseFloat(document.getElementById('f-prop-ini').value) || null,
    proposta_final:   parseFloat(document.getElementById('f-prop-fin').value) || null,
  };

  if (!payload.nome) throw new Error('Nome obrigatório');

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
    const unit   = parseMoeda(inp.value);
    const totInp = document.querySelector(`#precos-tbody .preco-total[data-item="${inp.dataset.item}"]`);
    const tot    = parseMoeda(totInp?.value);
    if (unit === null && tot === null) continue;

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
  limparFormulario();
});

// ── Cancelar ──────────────────────────────────────────────────────────────────

document.getElementById('btn-cancelar').addEventListener('click', limparFormulario);


// ── Init ──────────────────────────────────────────────────────────────────────

carregar();
