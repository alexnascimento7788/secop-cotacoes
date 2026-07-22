function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  setTimeout(() => { el.className = ''; }, 3500);
}

function fmtDataBr(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

const params = new URLSearchParams(location.search);
const editId = params.get('id') ? parseInt(params.get('id')) : null;

let currentStep = 1;
let itemCount = 0;
let originalItemIds = []; // IDs dos itens que existiam no banco ao carregar

// ── Modo edição: ajusta títulos e carrega dados ───────────────────────────────

if (editId) {
  document.getElementById('page-title').textContent = 'Editar Processo — SECOP Cotações';
  document.getElementById('header-title').textContent = 'Editar Processo';
  document.getElementById('header-subtitle').textContent = 'Altere os dados do processo de cotação';
  document.getElementById('btn-salvar').textContent = 'Salvar Alterações';
}

async function carregarTiposContratacao() {
  try {
    const res = await fetch('/api/tipos-contratacao');
    const tipos = res.ok ? await res.json() : [];
    const sel = document.getElementById('tipo_contratacao');
    tipos.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.nome; opt.textContent = t.nome;
      sel.appendChild(opt);
    });
  } catch {}
}

async function carregarProcessoParaEdicao() {
  if (!editId) return;
  try {
    const res = await fetch(`/api/processos/${editId}`);
    if (!res.ok) { toast('Processo não encontrado.', 'error'); return; }
    const p = await res.json();

    const user = await getCurrentUser();
    if (user && user.role !== 'admin' && p.criado_por_id !== user.id) {
      toast('Você não tem permissão para editar esta cotação.', 'error');
      setTimeout(() => { window.location.href = 'processos.html'; }, 1200);
      return;
    }

    document.getElementById('objeto').value            = p.objeto || '';
    document.getElementById('setor_solicitante').value = p.setor_solicitante || '';
    document.getElementById('tipo_contratacao').value  = p.tipo_contratacao || '';
    document.getElementById('responsavel').value       = p.responsavel || '';
    document.getElementById('data_abertura').value     = p.data_abertura ? p.data_abertura.split('T')[0] : '';
    document.getElementById('previsao_inicio').value   = p.previsao_inicio ? p.previsao_inicio.split('T')[0] : '';
    document.getElementById('previsao_termino').value  = p.previsao_termino ? p.previsao_termino.split('T')[0] : '';
    document.getElementById('descricao').value         = p.descricao || '';

    // Carrega itens existentes
    originalItemIds = [];
    // Linhas extras (ex: TAXA) são criadas e geridas na tela de Fornecedores,
    // não devem aparecer aqui pra não serem editadas/apagadas sem querer.
    (p.itens || []).filter(item => !item.extra).forEach(item => {
      addItem(item);
      originalItemIds.push(item.id);
    });
  } catch {
    toast('Erro ao carregar processo.', 'error');
  }
}

// ── Navegação de etapas ───────────────────────────────────────────────────────

function goToStep(step) {
  document.querySelectorAll('.step-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.step-tab').forEach(t => t.classList.remove('active'));

  document.getElementById(`pane-${step}`).classList.add('active');
  document.querySelector(`.step-tab[data-step="${step}"]`).classList.add('active');

  currentStep = step;

  if (step === 3) preencherRevisao();
}

document.querySelectorAll('.step-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const s = parseInt(tab.dataset.step);
    if (s < currentStep) goToStep(s);
  });
});

document.getElementById('btn-step1-next').addEventListener('click', () => {
  const obj = document.getElementById('objeto').value.trim();
  if (!obj) {
    toast('O campo Objeto é obrigatório.', 'error');
    document.getElementById('objeto').focus();
    return;
  }
  goToStep(2);
  if (itemCount === 0) addItem();
});

document.getElementById('btn-step2-back').addEventListener('click', () => goToStep(1));
document.getElementById('btn-step2-next').addEventListener('click', () => {
  const rows = document.querySelectorAll('.item-row');
  if (!rows.length) {
    toast('Adicione ao menos um item.', 'error');
    return;
  }
  let num = 0;
  for (const row of rows) {
    num++;
    const qtd  = parseFloat(row.querySelector('.item-qtd').value);
    const unid = row.querySelector('.item-unid').value.trim();
    const desc = row.querySelector('.item-desc').value.trim();
    if (!qtd || qtd <= 0) {
      toast(`Item ${num}: Quantidade deve ser maior que zero.`, 'error');
      row.querySelector('.item-qtd').focus();
      return;
    }
    if (!unid) {
      toast(`Item ${num}: Unidade é obrigatória.`, 'error');
      row.querySelector('.item-unid').focus();
      return;
    }
    if (!desc) {
      toast(`Item ${num}: Descrição é obrigatória.`, 'error');
      row.querySelector('.item-desc').focus();
      return;
    }
  }
  goToStep(3);
});

document.getElementById('btn-step3-back').addEventListener('click', () => goToStep(2));

// ── Itens ─────────────────────────────────────────────────────────────────────

// data: objeto opcional com { id, item_num, quantidade, unidade, descricao }
function addItem(data) {
  itemCount++;
  const n = itemCount;
  const container = document.getElementById('itens-container');
  const div = document.createElement('div');
  div.className = 'item-row';
  div.dataset.itemIndex = n;
  if (data && data.id) div.dataset.itemId = data.id; // ID do banco (edição)

  div.innerHTML = `
    <div class="form-group" style="min-width:52px;max-width:52px;">
      <label>Item</label>
      <span class="item-num-display" style="display:flex;align-items:center;justify-content:center;height:38px;background:var(--surface-2,#f0f4f8);border:1px solid var(--cinza-b,#d1d9e0);border-radius:6px;font-weight:700;font-size:14px;color:var(--text,#222);">${n}</span>
    </div>
    <div class="form-group">
      <label>Qtde</label>
      <input type="number" class="item-qtd" placeholder="1" min="0" step="any" value="${data ? (data.quantidade || '') : ''}" />
    </div>
    <div class="form-group">
      <label>Unid.</label>
      <input type="text" class="item-unid" placeholder="UN" value="${data ? (data.unidade || '') : ''}" />
    </div>
    <div class="form-group">
      <label>Descrição</label>
      <input type="text" class="item-desc" placeholder="Descrição do item..." value="${data ? (data.descricao || '') : ''}" />
    </div>
    <button class="btn btn-icon" title="Remover" onclick="removeItem(this)" style="margin-bottom:2px;">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;
  container.appendChild(div);
}

function removeItem(btn) {
  btn.closest('.item-row').remove();
  renumerarItens();
}

function renumerarItens() {
  document.querySelectorAll('.item-row').forEach((row, idx) => {
    const span = row.querySelector('.item-num-display');
    if (span) span.textContent = idx + 1;
    row.dataset.itemIndex = idx + 1;
  });
  itemCount = document.querySelectorAll('.item-row').length;
}

document.getElementById('btn-add-item').addEventListener('click', () => addItem());

function coletarItens() {
  return Array.from(document.querySelectorAll('.item-row')).map((row, idx) => ({
    id:        row.dataset.itemId ? parseInt(row.dataset.itemId) : null,
    item_num:  idx + 1,
    quantidade: parseFloat(row.querySelector('.item-qtd').value) || 0,
    unidade:   row.querySelector('.item-unid').value.trim(),
    descricao: row.querySelector('.item-desc').value.trim()
  })).filter(i => i.descricao);
}

// ── Revisão ───────────────────────────────────────────────────────────────────

function preencherRevisao() {
  const get = id => document.getElementById(id).value || '—';

  document.getElementById('rev-objeto').textContent      = get('objeto');
  document.getElementById('rev-setor').textContent       = get('setor_solicitante');
  document.getElementById('rev-tipo').textContent        = get('tipo_contratacao');
  document.getElementById('rev-responsavel').textContent = get('responsavel');
  document.getElementById('rev-inicio').textContent      = fmtDataBr(document.getElementById('previsao_inicio').value);
  document.getElementById('rev-termino').textContent     = fmtDataBr(document.getElementById('previsao_termino').value);
  const revAbertura = document.getElementById('rev-abertura');
  if (revAbertura) revAbertura.textContent = fmtDataBr(document.getElementById('data_abertura').value);

  const itens = coletarItens();
  document.getElementById('rev-itens-count').textContent = itens.length;

  const tbody = document.getElementById('rev-itens-tbody');
  if (!itens.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="padding:10px;color:#aaa;">Nenhum item.</td></tr>`;
    return;
  }
  tbody.innerHTML = itens.map(i => `
    <tr>
      <td style="padding:6px 10px;">${i.item_num}</td>
      <td style="padding:6px 10px;">${i.descricao}</td>
      <td style="padding:6px 10px;">${i.quantidade}</td>
      <td style="padding:6px 10px;">${i.unidade || '—'}</td>
    </tr>`).join('');
}

// ── Salvar ────────────────────────────────────────────────────────────────────

document.getElementById('btn-salvar').addEventListener('click', async () => {
  const btn = document.getElementById('btn-salvar');
  btn.disabled = true;
  btn.textContent = 'Salvando...';

  const body = {
    objeto:            document.getElementById('objeto').value.trim(),
    setor_solicitante: document.getElementById('setor_solicitante').value.trim(),
    tipo_contratacao:  document.getElementById('tipo_contratacao').value,
    responsavel:       document.getElementById('responsavel').value.trim(),
    data_abertura:     document.getElementById('data_abertura').value,
    previsao_inicio:   document.getElementById('previsao_inicio').value,
    previsao_termino:  document.getElementById('previsao_termino').value,
    descricao:         document.getElementById('descricao').value.trim()
  };

  try {
    let processoId;

    if (editId) {
      // ── Modo edição ────────────────────────────────────────────────────────
      const res = await fetch(`/api/processos/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const err = await res.json();
        toast(err.error || 'Erro ao atualizar processo', 'error');
        btn.disabled = false;
        btn.textContent = 'Salvar Alterações';
        return;
      }
      processoId = editId;

      const itensAtuais = coletarItens();
      const idsAtuais   = itensAtuais.filter(i => i.id).map(i => i.id);

      // Exclui itens removidos pelo usuário
      for (const origId of originalItemIds) {
        if (!idsAtuais.includes(origId)) {
          await fetch(`/api/itens/${origId}`, { method: 'DELETE' });
        }
      }

      // Atualiza existentes e cria novos
      for (const item of itensAtuais) {
        if (item.id) {
          await fetch(`/api/itens/${item.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item)
          });
        } else {
          await fetch(`/api/processos/${processoId}/itens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item)
          });
        }
      }

      toast('Processo atualizado com sucesso!', 'success');

    } else {
      // ── Modo criação ───────────────────────────────────────────────────────
      const res = await fetch('/api/processos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const err = await res.json();
        toast(err.error || 'Erro ao criar processo', 'error');
        btn.disabled = false;
        btn.textContent = 'Salvar Processo';
        return;
      }

      const { id } = await res.json();
      processoId = id;

      for (const item of coletarItens()) {
        await fetch(`/api/processos/${processoId}/itens`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item)
        });
      }

      toast('Processo criado com sucesso!', 'success');
    }

    const redirect = editId
      ? `cotacao.html?id=${processoId}`
      : `fornecedor.html?processo_id=${processoId}`;
    setTimeout(() => { window.location.href = redirect; }, 800);

  } catch {
    toast('Erro de rede ao salvar processo', 'error');
    btn.disabled = false;
    btn.textContent = editId ? 'Salvar Alterações' : 'Salvar Processo';
  }
});

// ── Import Excel ──────────────────────────────────────────────────────────────

async function carregarXLSX() {
  if (window.XLSX) return window.XLSX;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload  = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('Falha ao carregar biblioteca Excel'));
    document.head.appendChild(s);
  });
}

async function importarExcel(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;

  const aviso = document.getElementById('import-aviso');
  aviso.style.display = 'none';

  try {
    const XLSX = await carregarXLSX();
    const data = await file.arrayBuffer();
    const wb   = XLSX.read(data, { type: 'array' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Ignora linha de cabeçalho (row 0); colunas: [0]=Quantidade [1]=Unidade [2]=Descrição
    const itens = [];
    for (let i = 1; i < rows.length; i++) {
      const row  = rows[i];
      const qtd  = parseFloat(row[0]) || 0;
      const unid = String(row[1] || '').trim();
      const desc = String(row[2] || '').trim();
      if (!desc) continue;
      itens.push({ quantidade: qtd, unidade: unid, descricao: desc });
    }

    if (!itens.length) {
      aviso.style.display    = 'block';
      aviso.style.background = '#FFF8E1';
      aviso.style.borderColor = '#FFE082';
      aviso.style.color      = '#795548';
      aviso.textContent      = 'Nenhum item válido encontrado na planilha.';
      return;
    }

    document.getElementById('itens-container').innerHTML = '';
    itemCount = 0;
    itens.forEach(item => addItem(item));
    renumerarItens();

    aviso.style.display    = 'block';
    aviso.style.background = '#E8F5E9';
    aviso.style.borderColor = '#A5D6A7';
    aviso.style.color      = '#1B5E20';
    aviso.textContent      = `✓ ${itens.length} iten${itens.length>1?'s':''} importado${itens.length>1?'s':''} de "${file.name}".`;

  } catch(e) {
    aviso.style.display    = 'block';
    aviso.style.background = '#FFEBEE';
    aviso.style.borderColor = '#EF9A9A';
    aviso.style.color      = '#C62828';
    aviso.textContent      = 'Erro ao ler o arquivo: ' + e.message;
  }
}

// ── Inicialização ─────────────────────────────────────────────────────────────

carregarTiposContratacao().then(carregarProcessoParaEdicao);
initDatalistAutocomplete('objeto',             'objeto');
initDatalistAutocomplete('setor_solicitante',  'setor_solicitante');
initDatalistAutocomplete('responsavel',        'responsavel');
initSuggestAutocomplete('descricao', 'descricao');
