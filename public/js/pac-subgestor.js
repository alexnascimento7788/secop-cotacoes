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
let _meusItens = [];
let _editandoItemId = null;

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
  resetarFluxoNovoItem();
  await renderMeusLancamentos();
}

// Passo 1: só "+ Novo item" visível. Passo 2 (contrato, se o DFD tiver essa
// coluna) e Passo 3 (resto dos campos) só aparecem depois de uma ação
// explícita — mesma sequência que o gestor de setor já tem
// (iniciarNovoItem → abrirModalContratoNovoItem → criarItem, em
// pac-lancamento.js). Pedido do Alex, 2026-09-23: "não tem a validação de
// contrato para iniciar a lançar um item".
function resetarFluxoNovoItem() {
  _editandoItemId = null;
  document.getElementById('sg-setor-select').disabled = false;
  document.getElementById('sg-btn-novo-item').style.display = '';
  document.getElementById('sg-form-item').style.display = 'none';
  document.getElementById('modal-sg-contrato').classList.remove('open');
  document.getElementById('sg-edit-contrato-wrap').style.display = 'none';
  document.getElementById('sg-btn-lancar-texto').textContent = 'Lançar item';
  document.getElementById('sg-msg').textContent = '';
}

function temColunaContrato() {
  return (_dfdAtual.colunas || []).some(c => c.grupo === 'C');
}

function iniciarNovoItemSubgestor() {
  _editandoItemId = null;
  const setorId = document.getElementById('sg-setor-select').value;
  if (!setorId) { toast('Selecione o setor primeiro.', 'error'); return; }
  if (temColunaContrato()) {
    renderContrato();
    document.getElementById('modal-sg-contrato').classList.add('open');
  } else {
    mostrarFormItem();
  }
}

// Edição do PRÓPRIO lançamento, só enquanto pendente de aprovação (pedido do
// Alex, 2026-09-23: "e se ele precisar excluir, ou alterar?"). Diferente da
// criação, aqui já existem valores — mostra tudo direto (grupo A + contrato),
// sem o gate do modal, e manda PUT em vez de POST no final.
function editarItemSubgestor(id) {
  const item = _meusItens.find(i => i.id === id);
  if (!item) return;
  _editandoItemId = id;
  const selSetor = document.getElementById('sg-setor-select');
  selSetor.value = item.setor_id;
  selSetor.disabled = true; // setor não muda numa edição — só o servidor que decide o setor na criação
  renderCampos();
  preencherCamposComValores(item.valores, '#sg-campos');
  // Fonte pagadora não é um <input>/<select> genérico (pode ser rateio JSON)
  // — reconstrói a exibição a partir do valor que preencherCamposComValores
  // acabou de jogar no hidden.
  (_dfdAtual.colunas || []).filter(c => c.grupo === 'A' && c.slug === 'fonte_pagadora').forEach(c => atualizarExibicaoFonteSubgestor(c.id));
  if (temColunaContrato()) {
    renderContratoEdicao(item.valores);
    document.getElementById('sg-edit-contrato-wrap').style.display = '';
  } else {
    document.getElementById('sg-edit-contrato-wrap').style.display = 'none';
  }
  document.getElementById('sg-btn-lancar-texto').textContent = 'Salvar alterações';
  document.getElementById('sg-btn-novo-item').style.display = 'none';
  document.getElementById('sg-form-item').style.display = '';
}

function preencherCamposComValores(valores, containerSelector) {
  document.querySelectorAll(`${containerSelector} [data-coluna]`).forEach(el => {
    const v = valores?.[el.dataset.coluna];
    if (v == null) return;
    el.value = el.dataset.tipo === 'moeda' ? fmtMoeda(v) : v;
  });
}

function renderContratoEdicao(valores) {
  const colunasContrato = (_dfdAtual.colunas || []).filter(c => c.grupo === 'C');
  const possuiCol = (_dfdAtual.colunas || []).find(c => c.slug === 'possui_contrato');
  document.getElementById('sg-edit-possui').value = (possuiCol && valores?.[possuiCol.id] === 'Sim') ? 'sim' : 'nao';
  document.getElementById('sg-edit-campos-contrato').innerHTML = colunasContrato.map(c => `
    <div class="form-group">
      <label>${c.label}</label>
      ${renderCampoNovo(c)}
    </div>
  `).join('');
  preencherCamposComValores(valores, '#sg-edit-campos-contrato');
  sgEditAtualizarVisibilidadeContrato();
}
function sgEditAtualizarVisibilidadeContrato() {
  const sim = document.getElementById('sg-edit-possui').value === 'sim';
  document.getElementById('sg-edit-campos-contrato').style.display = sim ? '' : 'none';
}

async function excluirItemSubgestor(id) {
  if (!confirm('Excluir este lançamento? Essa ação não pode ser desfeita.')) return;
  try {
    const res = await fetch(`/api/pac/itens/${id}`, { method: 'DELETE' });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Erro ao excluir'); }
    toast('Item excluído.');
    await renderMeusLancamentos();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function verItemSubgestor(id) {
  const item = _meusItens.find(i => i.id === id);
  if (!item) return;
  const colunas = (_dfdAtual.colunas || []).filter(c => c.slug !== 'numero_item');
  document.getElementById('sg-detalhe-corpo').innerHTML = colunas.map(c => {
    let v = item.valores?.[c.id];
    if (v == null || v === '') v = '—';
    else if (c.slug === 'fonte_pagadora' && textoRateioFonteSubgestor(v)) v = textoRateioFonteSubgestor(v);
    else if (c.tipo_input === 'moeda') v = 'R$ ' + fmtMoeda(v);
    else if (c.tipo_input === 'data') v = fmtBr(v);
    return `<div style="margin-bottom:10px;"><div style="font-size:11px;color:var(--text-subtle);font-weight:600;">${c.label}</div><div>${v}</div></div>`;
  }).join('');
  document.getElementById('modal-sg-detalhe').classList.add('open');
}
function fecharModalDetalheSubgestor() {
  document.getElementById('modal-sg-detalhe').classList.remove('open');
}

function cancelarNovoItemSubgestor() {
  document.getElementById('modal-sg-contrato').classList.remove('open');
}

function confirmarContratoSubgestor() {
  document.getElementById('modal-sg-contrato').classList.remove('open');
  mostrarFormItem();
}

function mostrarFormItem() {
  renderCampos();
  document.getElementById('sg-btn-novo-item').style.display = 'none';
  document.getElementById('sg-form-item').style.display = '';
}

async function carregarListas() {
  const listas = [...new Set((_dfdAtual.colunas || []).filter(c => c.grupo === 'A' && c.lista).map(c => c.lista))];
  const entradas = await Promise.all(listas.map(async l => {
    const res = await fetch(`/api/pac/parametros?lista=${encodeURIComponent(l)}`);
    return [l, res.ok ? (await res.json()).filter(p => p.ativo) : []];
  }));
  _listasCache = Object.fromEntries(entradas);
}

// Só grupo A (dados do item em si) — chamado depois que o contrato (se
// existir na configuração do DFD) já foi confirmado no modal.
function renderCampos() {
  const colunas = (_dfdAtual.colunas || []).filter(c => c.grupo === 'A' && c.slug !== 'numero_item');
  document.getElementById('sg-campos').innerHTML = colunas.map(c => `
    <div class="form-group">
      <label>${c.label}${c.obrigatoria ? ' *' : ''}</label>
      ${renderCampoNovo(c)}
    </div>
  `).join('');
  // Popula o <select>/rateio da fonte pagadora (o wrapper sai vazio de
  // renderCampoFontePagadoraSubgestor — precisa desse passo pra aparecer).
  colunas.filter(c => c.slug === 'fonte_pagadora').forEach(c => atualizarExibicaoFonteSubgestor(c.id));
}

// Pergunta "Este item possui contrato?" + campos do grupo C, dentro do modal
// que trava o início do lançamento — mesmo fluxo que o gestor de setor já
// tem (mcAtualizarVisibilidadeCampos/valoresContratoDoForm em
// pac-lancamento.js). Pedido do Alex, 2026-09-23: "não tem a validação de
// contrato para iniciar a lançar um item, precisa ter".
function renderContrato() {
  const colunasContrato = (_dfdAtual.colunas || []).filter(c => c.grupo === 'C');
  document.getElementById('sg-possui').value = 'nao';
  document.getElementById('sg-campos-contrato').innerHTML = colunasContrato.map(c => `
    <div class="form-group">
      <label>${c.label}</label>
      ${renderCampoNovo(c)}
    </div>
  `).join('');
  sgAtualizarVisibilidadeContrato();
}
function sgAtualizarVisibilidadeContrato() {
  const sim = document.getElementById('sg-possui').value === 'sim';
  document.getElementById('sg-campos-contrato').style.display = sim ? '' : 'none';
}

function renderCampoNovo(coluna) {
  const id = `campo-novo-${coluna.id}`;
  const base = `id="${id}" data-coluna="${coluna.id}" data-tipo="${coluna.tipo_input}"`;
  if (coluna.slug === 'fonte_pagadora') return renderCampoFontePagadoraSubgestor(coluna, id);
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

/* ── Rateio de fonte pagadora (mesmo recurso do gestor de setor em
   Lançamento, botão "⚖") — pedido do Alex, 2026-09-24: "a insercao dos
   percentuais por fonte pagadora nao existe [na tela do sub-gestor],
   precisamos disto tbm". Diferença daqui pro de pac-lancamento.js: lá o
   item já existe e o modal salva na hora (PUT); aqui o item pode nem
   existir ainda (form de criação), então o rateio só fica guardado num
   <input type="hidden"> (data-coluna, lido por coletarValoresNovo() como
   qualquer outro campo) e vai junto no POST/PUT geral do form. */
function parseRateioFonteSubgestor(valor) {
  if (!valor) return null;
  const s = String(valor).trim();
  if (!s.startsWith('{')) return null;
  try {
    const obj = JSON.parse(s);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch { return null; }
}
function textoRateioFonteSubgestor(valor) {
  const rateio = parseRateioFonteSubgestor(valor);
  if (!rateio) return null;
  return Object.entries(rateio).map(([f, p]) => `${f} ${p}%`).join(' / ');
}

function renderCampoFontePagadoraSubgestor(coluna, id) {
  return `<div id="fonte-visivel-${coluna.id}"></div><input type="hidden" id="${id}" data-coluna="${coluna.id}" data-tipo="${coluna.tipo_input}" value="" />`;
}

// Reconstrói o <select> (ou o texto do rateio + botão "⚖") a partir do valor
// atual guardado no hidden — chamado depois de renderCampos() (estado
// inicial em branco) e depois de preencherCamposComValores() na edição
// (estado já preenchido).
function atualizarExibicaoFonteSubgestor(colunaId) {
  const coluna = (_dfdAtual.colunas || []).find(c => c.id === colunaId);
  const wrap = document.getElementById(`fonte-visivel-${colunaId}`);
  if (!coluna || !wrap) return;
  const hidden = document.getElementById(`campo-novo-${colunaId}`);
  const valor = hidden ? hidden.value : '';
  const rateio = parseRateioFonteSubgestor(valor);
  const btnRateio = `<button type="button" class="btn btn-secondary btn-xs" style="padding:2px 7px;flex-shrink:0;" onclick="abrirModalRateioFonteSubgestor(${colunaId})" title="Ratear entre mais de uma fonte pagadora">⚖</button>`;
  wrap.style.display = 'flex'; wrap.style.alignItems = 'center'; wrap.style.gap = '6px';
  if (rateio) {
    wrap.innerHTML = `<span style="font-size:12.5px;flex:1;" title="${textoRateioFonteSubgestor(valor)}">${textoRateioFonteSubgestor(valor)}</span>${btnRateio}`;
  } else {
    const opcoes = (_listasCache[coluna.lista] || []).map(o => `<option value="${o.valor}"${o.valor === valor ? ' selected' : ''}>${o.valor}</option>`).join('');
    wrap.innerHTML = `<select onchange="document.getElementById('campo-novo-${colunaId}').value=this.value" style="flex:1;"><option value="">—</option>${opcoes}</select>${btnRateio}`;
  }
}

let _sgRfColunaId = null;
function abrirModalRateioFonteSubgestor(colunaId) {
  const coluna = (_dfdAtual.colunas || []).find(c => c.id === colunaId);
  if (!coluna) return;
  _sgRfColunaId = colunaId;
  const hidden = document.getElementById(`campo-novo-${colunaId}`);
  const valorAtual = hidden ? hidden.value : '';
  const rateioAtual = parseRateioFonteSubgestor(valorAtual) || (valorAtual ? { [valorAtual]: 100 } : {});
  const opcoes = (_listasCache[coluna.lista] || []).map(o => o.valor);
  document.getElementById('sg-rateio-fonte-linhas').innerHTML = opcoes.map(op => `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <label style="display:flex;align-items:center;gap:6px;flex:1;cursor:pointer;">
        <input type="checkbox" id="sg-rf-chk-${op}" ${rateioAtual[op] != null ? 'checked' : ''} onchange="atualizarTotalRateioFonteSubgestor()"> ${op}
      </label>
      <input type="number" id="sg-rf-pct-${op}" min="0" max="100" step="0.01" value="${rateioAtual[op] ?? ''}"
        style="width:80px;text-align:right;" placeholder="%" oninput="atualizarTotalRateioFonteSubgestor()">
    </div>`).join('');
  document.getElementById('sg-rateio-fonte-msg').textContent = '';
  atualizarTotalRateioFonteSubgestor();
  document.getElementById('modal-sg-rateio-fonte').classList.add('open');
}
function fecharModalRateioFonteSubgestor() {
  document.getElementById('modal-sg-rateio-fonte').classList.remove('open');
  _sgRfColunaId = null;
}
function lerRateioFonteFormSubgestor() {
  const coluna = (_dfdAtual.colunas || []).find(c => c.id === _sgRfColunaId);
  const opcoes = (_listasCache[coluna?.lista] || []).map(o => o.valor);
  const rateio = {};
  opcoes.forEach(op => {
    const chk = document.getElementById(`sg-rf-chk-${op}`);
    if (chk && chk.checked) rateio[op] = Number(document.getElementById(`sg-rf-pct-${op}`).value) || 0;
  });
  return rateio;
}
function atualizarTotalRateioFonteSubgestor() {
  const rateio = lerRateioFonteFormSubgestor();
  const total = Object.values(rateio).reduce((s, v) => s + v, 0);
  const el = document.getElementById('sg-rateio-fonte-total');
  if (!el) return;
  el.textContent = `Total: ${total}%`;
  el.style.color = Math.abs(total - 100) < 0.01 ? 'var(--verde,#2E7D32)' : '#c0392b';
}
function salvarRateioFonteSubgestor() {
  const rateio = lerRateioFonteFormSubgestor();
  const fontes = Object.keys(rateio);
  const msg = document.getElementById('sg-rateio-fonte-msg');
  if (!fontes.length) { msg.textContent = 'Marque ao menos uma fonte pagadora.'; return; }
  const total = fontes.reduce((s, f) => s + rateio[f], 0);
  if (Math.abs(total - 100) > 0.01) { msg.textContent = `A soma dos percentuais precisa ser 100% (está em ${total}%).`; return; }
  // 1 fonte só = mesmo formato simples de sempre (texto puro), igual ao
  // gestor de setor — não vira JSON pra um caso que já era 100% implícito.
  const valor = fontes.length === 1 ? fontes[0] : JSON.stringify(rateio);
  const hidden = document.getElementById(`campo-novo-${_sgRfColunaId}`);
  if (hidden) hidden.value = valor;
  atualizarExibicaoFonteSubgestor(_sgRfColunaId);
  fecharModalRateioFonteSubgestor();
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

// Espelha valoresContratoDoForm() de pac-lancamento.js — sem a opção "Não
// informado" (só faz sentido pra dado histórico importado, nunca pra um
// lançamento ao vivo). "Não" grava a sentinela 1900-01-01 na coluna de
// data, mesma convenção usada em todo o resto do projeto pra "resposta
// completa e definitiva" (ver [[project_secop_pac_dfd]]).
function coletarValoresContrato() {
  const colunasContrato = (_dfdAtual.colunas || []).filter(c => c.grupo === 'C');
  const possuiEl = document.getElementById('sg-possui');
  if (!possuiEl || !colunasContrato.length) return {};
  const escolha = possuiEl.value;
  const valores = {};
  if (escolha === 'sim') {
    document.querySelectorAll('#sg-campos-contrato [data-coluna]').forEach(el => {
      let v = el.value;
      if (el.dataset.tipo === 'moeda') { const n = parseMoeda(v); v = n == null ? '' : String(n); }
      valores[el.dataset.coluna] = v === '' ? null : v;
    });
  } else {
    colunasContrato.forEach(c => { valores[c.id] = c.tipo_input === 'data' ? '1900-01-01' : null; });
  }
  const possuiCol = (_dfdAtual.colunas || []).find(c => c.slug === 'possui_contrato');
  if (possuiCol) valores[possuiCol.id] = escolha === 'sim' ? 'Sim' : 'Não';
  return valores;
}

async function lancarItemSubgestor() {
  const msg = document.getElementById('sg-msg');
  msg.style.color = '#c00';
  const setorId = Number(document.getElementById('sg-setor-select').value);
  if (!setorId) { msg.textContent = 'Selecione o setor.'; return; }
  const editando = !!_editandoItemId;
  const valores = { ...coletarValoresNovo(), ...(editando ? coletarValoresContratoEdicao() : coletarValoresContrato()) };
  try {
    const res = editando
      ? await fetch(`/api/pac/itens/${_editandoItemId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ valores }),
        })
      : await fetch(`/api/pac/dfds/${_dfdAtual.id}/itens`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setor_id: setorId, valores }), // unidade_id NUNCA vem daqui — o servidor atribui automaticamente a unidade do sub-gestor
        });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || (editando ? 'Erro ao salvar' : 'Erro ao lançar')); }
    resetarFluxoNovoItem(); // volta pro Passo 1 — próximo lançamento passa pela trava de contrato de novo
    await renderMeusLancamentos();
    toast(editando ? 'Alterações salvas.' : 'Item lançado — aguardando aprovação do gestor oficial do setor.');
  } catch (e) {
    msg.textContent = 'Erro: ' + e.message;
  }
}

// Espelha coletarValoresContrato(), mas lendo do bloco de edição (sem gate) —
// ver [[project_secop_pac_unidades_subgestor]].
function coletarValoresContratoEdicao() {
  const colunasContrato = (_dfdAtual.colunas || []).filter(c => c.grupo === 'C');
  const possuiEl = document.getElementById('sg-edit-possui');
  if (!possuiEl || !colunasContrato.length) return {};
  const escolha = possuiEl.value;
  const valores = {};
  if (escolha === 'sim') {
    document.querySelectorAll('#sg-edit-campos-contrato [data-coluna]').forEach(el => {
      let v = el.value;
      if (el.dataset.tipo === 'moeda') { const n = parseMoeda(v); v = n == null ? '' : String(n); }
      valores[el.dataset.coluna] = v === '' ? null : v;
    });
  } else {
    colunasContrato.forEach(c => { valores[c.id] = c.tipo_input === 'data' ? '1900-01-01' : null; });
  }
  const possuiCol = (_dfdAtual.colunas || []).find(c => c.slug === 'possui_contrato');
  if (possuiCol) valores[possuiCol.id] = escolha === 'sim' ? 'Sim' : 'Não';
  return valores;
}

const LABEL_STATUS_SUBGESTOR = { pendente: 'Pendente de aprovação', aprovado: 'Aprovado', rejeitado: 'Rejeitado' };
const CLASSE_STATUS_SUBGESTOR = { pendente: 'badge-analise', aprovado: 'badge-aberto', rejeitado: 'badge-cancelado' };

async function renderMeusLancamentos() {
  const tbody = document.getElementById('sg-meus-tbody');
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtual.id}/itens`);
    _meusItens = res.ok ? await res.json() : [];
    tbody.innerHTML = _meusItens.map(i => {
      const setorNome = (_dfdAtual.setores || []).find(s => s.id === i.setor_id)?.nome || '—';
      const status = i.aprovacao_subgestor || 'pendente';
      // Só dá pra editar/excluir enquanto pendente — depois de aprovado o
      // item passa a ser do setor oficial, não é mais um rascunho dele.
      const podeEditar = status === 'pendente';
      return `<tr>
        <td>${setorNome}</td>
        <td>${fmtBr(i.criado_em)}</td>
        <td><span class="badge ${CLASSE_STATUS_SUBGESTOR[status] || 'badge-fechado'}">${LABEL_STATUS_SUBGESTOR[status] || status}</span></td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="btn btn-secondary btn-xs" onclick="verItemSubgestor(${i.id})">Ver</button>
          ${podeEditar ? `
            <button class="btn btn-secondary btn-xs" onclick="editarItemSubgestor(${i.id})">Editar</button>
            <button class="btn btn-danger btn-xs" onclick="excluirItemSubgestor(${i.id})">Excluir</button>
          ` : ''}
        </td>
      </tr>`;
    }).join('') || `<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--text-subtle);">Nenhum lançamento seu ainda neste DFD.</td></tr>`;
  } catch {
    tbody.innerHTML = `<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--text-subtle);">Erro ao carregar.</td></tr>`;
  }
}

document.addEventListener('DOMContentLoaded', boot);
