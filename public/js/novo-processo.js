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
    // 'admin' é role antigo (pré-v4.0.0) — mesmo bug corrigido em processos.js/
    // cotacao.js/fornecedor.js, ver [[project_secop_role_admin_legado]].
    // edicaoLivre é o parâmetro de Configurações → Parâmetros que libera
    // edição pra qualquer usuário, não só admin/dono.
    let edicaoLivre = false;
    try { const cfg = await (await fetch('/api/config')).json(); edicaoLivre = cfg.secop_edicao_livre === '1'; } catch {}
    const podeAdmin = edicaoLivre || (user && ['admin', 'admin_sistema', 'admin_operacional'].includes(user.role));
    if (user && !podeAdmin && p.criado_por_id !== user.id) {
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
  for (const row of rows) {
    const num  = row.dataset.num;
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
//
// O código do item (item_num) NÃO é mais recalculado pela posição na lista
// (idx+1) — fica gravado em row.dataset.num e só muda quando: (a) o item vem
// do banco/importação já com um número, (b) é um item novo (herda o número
// seguinte ao do último da lista) ou (c) o usuário edita manualmente clicando
// no número (ver editarNumeroItem). Motivo (pedido do Alex, 2026-09-24): ao
// importar um novo TR (termo de referência) depois de excluir algum item no
// meio, a numeração da planilha nova pode não "fechar o buraco" do jeito que
// a exclusão fechava — precisa poder corrigir o número de 1 item e cascatear
// a partir dali, sem que um simples excluir/adicionar embaralhe tudo nem
// force reinício em 1.
function addItem(data) {
  itemCount++;
  const container = document.getElementById('itens-container');
  const linhas = container.querySelectorAll('.item-row');
  const ultimaLinha = linhas[linhas.length - 1];
  const numero = (data && data.item_num != null && data.item_num !== '')
    ? data.item_num
    : (ultimaLinha ? (parseInt(ultimaLinha.dataset.num, 10) || linhas.length) + 1 : 1);

  const div = document.createElement('div');
  div.className = 'item-row';
  div.dataset.num = numero;
  if (data && data.id) div.dataset.itemId = data.id; // ID do banco (edição)

  div.innerHTML = `
    <div class="form-group" style="min-width:52px;max-width:52px;">
      <label>Item</label>
      <span class="item-num-display" title="Clique para corrigir o código deste item" onclick="editarNumeroItem(this)" style="cursor:pointer;display:flex;align-items:center;justify-content:center;height:38px;background:var(--surface-2,#f0f4f8);border:1px solid var(--cinza-b,#d1d9e0);border-radius:6px;font-weight:700;font-size:14px;color:var(--text,#222);">${numero}</span>
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
  // Não renumera o resto — excluir um item não deve embaralhar o código dos
  // outros (ver comentário em addItem). Quem precisar fechar o número
  // agora "errado" corrige clicando nele.
  itemCount = document.querySelectorAll('.item-row').length;
}

// Clique no número do item: vira um campo editável. Confirmar (Enter/blur com
// valor válido) grava o número digitado nesta linha e recalcula sequencialmente
// TODAS as linhas abaixo dela (numero+1, numero+2, ...) — as de cima ficam como
// estavam. Esc cancela sem mudar nada.
function editarNumeroItem(span) {
  if (span.tagName === 'INPUT') return;
  const row = span.closest('.item-row');
  const valorAtual = row.dataset.num;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.step = '1';
  input.value = valorAtual;
  input.className = 'item-num-edit';
  input.style.cssText = 'width:100%;height:38px;text-align:center;font-weight:700;font-size:14px;border:1px solid var(--verde,#1A6B35);border-radius:6px;';
  span.replaceWith(input);
  input.focus();
  input.select();

  let concluido = false;
  function confirmar() {
    if (concluido) return;
    concluido = true;
    const novo = parseInt(input.value, 10);
    if (!novo || novo < 1) {
      toast('Código do item deve ser um número maior que zero.', 'error');
      restaurarSpan(valorAtual);
      return;
    }
    row.dataset.num = novo;
    restaurarSpan(novo);
    renumerarAPartirDe(row);
  }
  function cancelar() {
    if (concluido) return;
    concluido = true;
    restaurarSpan(valorAtual);
  }
  function restaurarSpan(valor) {
    const novoSpan = document.createElement('span');
    novoSpan.className = 'item-num-display';
    novoSpan.title = 'Clique para corrigir o código deste item';
    novoSpan.onclick = () => editarNumeroItem(novoSpan);
    novoSpan.style.cssText = 'cursor:pointer;display:flex;align-items:center;justify-content:center;height:38px;background:var(--surface-2,#f0f4f8);border:1px solid var(--cinza-b,#d1d9e0);border-radius:6px;font-weight:700;font-size:14px;color:var(--text,#222);';
    novoSpan.textContent = valor;
    input.replaceWith(novoSpan);
  }

  input.addEventListener('blur', confirmar);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelar(); }
  });
}

function renumerarAPartirDe(row) {
  let anterior = parseInt(row.dataset.num, 10);
  let atual = row.nextElementSibling;
  while (atual && atual.classList.contains('item-row')) {
    anterior += 1;
    atual.dataset.num = anterior;
    const span = atual.querySelector('.item-num-display');
    if (span) span.textContent = anterior;
    atual = atual.nextElementSibling;
  }
}

document.getElementById('btn-add-item').addEventListener('click', () => addItem());

function coletarItens() {
  return Array.from(document.querySelectorAll('.item-row')).map(row => ({
    id:        row.dataset.itemId ? parseInt(row.dataset.itemId) : null,
    item_num:  parseInt(row.dataset.num, 10),
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

    abrirModalImportacao(itens, file.name);

  } catch(e) {
    aviso.style.display    = 'block';
    aviso.style.background = '#FFEBEE';
    aviso.style.borderColor = '#EF9A9A';
    aviso.style.color      = '#C62828';
    aviso.textContent      = 'Erro ao ler o arquivo: ' + e.message;
  }
}

let _itensParaImportar = null;

function abrirModalImportacao(itens, nomeArquivo) {
  _itensParaImportar = itens;
  document.getElementById('import-modal-arquivo').textContent = `"${nomeArquivo}"`;
  document.getElementById('import-modal-count').textContent = itens.length;
  const tbody = document.getElementById('import-modal-tbody');
  tbody.innerHTML = '';
  itens.forEach((item, i) => {
    const tr = document.createElement('tr');
    tr.style.borderTop = '1px solid #eee';
    const tdNum = document.createElement('td');
    tdNum.style.padding = '5px 10px'; tdNum.style.color = '#888';
    tdNum.textContent = i + 1;
    const tdQtd = document.createElement('td');
    tdQtd.style.padding = '5px 10px';
    tdQtd.textContent = item.quantidade;
    const tdUnid = document.createElement('td');
    tdUnid.style.padding = '5px 10px';
    tdUnid.textContent = item.unidade;
    const tdDesc = document.createElement('td');
    tdDesc.style.padding = '5px 10px';
    tdDesc.textContent = item.descricao;
    tr.append(tdNum, tdQtd, tdUnid, tdDesc);
    tbody.appendChild(tr);
  });
  document.getElementById('modal-import-excel').classList.add('open');
}

function cancelarImportacaoExcel() {
  _itensParaImportar = null;
  document.getElementById('modal-import-excel').classList.remove('open');
}

function confirmarImportacaoExcel() {
  if (!_itensParaImportar) return;
  const itens = _itensParaImportar;
  document.getElementById('itens-container').innerHTML = '';
  itemCount = 0;
  itens.forEach(item => addItem(item));

  const aviso = document.getElementById('import-aviso');
  aviso.style.display    = 'block';
  aviso.style.background = '#E8F5E9';
  aviso.style.borderColor = '#A5D6A7';
  aviso.style.color      = '#1B5E20';
  aviso.textContent      = `✓ ${itens.length} iten${itens.length>1?'s':''} importado${itens.length>1?'s':''}.`;

  cancelarImportacaoExcel();
}

// ── Inicialização ─────────────────────────────────────────────────────────────

carregarTiposContratacao().then(carregarProcessoParaEdicao);
initDatalistAutocomplete('objeto',             'objeto');
initDatalistAutocomplete('setor_solicitante',  'setor_solicitante');
initDatalistAutocomplete('responsavel',        'responsavel');
initSuggestAutocomplete('descricao', 'descricao');
