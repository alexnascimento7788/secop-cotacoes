// DETIN — Contratos: listagem com filtros + modal de cadastro/edição (4 abas) + aditivos.

function toast(msg, tipo) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (tipo ? ' ' + tipo : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
}

function fmtMoedaInput(v) {
  if (v === null || v === undefined || v === '') return '';
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function parseMoedaInput(s) {
  if (!s || !String(s).trim()) return null;
  const v = parseFloat(String(s).replace(/[R$\s.]/g, '').replace(',', '.'));
  return isNaN(v) ? null : v;
}
function fmtBr(iso) {
  if (!iso) return '—';
  const d = String(iso).split(/[T ]/)[0].split('-');
  return d.length < 3 ? '—' : `${d[2]}/${d[1]}/${d[0]}`;
}
// Mesmo farol de detin-painel.js (duplicado — convenção do projeto, sem
// módulo compartilhado novo entre páginas).
function farolInfo(dias) {
  if (dias == null) return { cor: '#9ca3af' };
  if (dias <= 10) return { cor: '#c0392b' };
  if (dias <= 15) return { cor: '#d97706' };
  if (dias <= 30) return { cor: '#eab308' };
  if (dias <= 60) return { cor: '#16a34a' };
  return { cor: '#9ca3af' };
}

const LABEL_TIPO = { servico_continuado: 'Serviço contínuo', licenca: 'Licença', locacao: 'Locação', pagamento_unico: 'Pagamento único' };
const LABEL_STATUS = { ativo: 'Ativo', em_renovacao: 'Em renovação', encerrado: 'Encerrado', cancelado: 'Cancelado' };
const BADGE_STATUS_CLASS = { ativo: 'aberto', em_renovacao: 'analise', encerrado: 'fechado', cancelado: 'cancelado' };
const LABEL_ADITIVO = { prazo: 'Prazo', valor: 'Valor', objeto: 'Objeto', rescisao: 'Rescisão' };

let _contratos = [];
let _setores = [];
let _usuarios = [];
let _contratoEditandoId = null;
let _linhaExpandidaId = null;
const _aditivosCache = {};

/* ── Chips de resumo (mesmo dado do Painel, sempre geral — não filtrado) ──── */

async function carregarChips() {
  try {
    const res = await fetch('/api/detin/painel');
    if (!res.ok) throw new Error();
    const data = await res.json();
    const criticos = (data.alertas || []).filter(a => a.dias_restantes <= 10).length;
    document.getElementById('dt-chip-ativos').textContent = data.total_ativos;
    document.getElementById('dt-chip-comprometido').textContent = 'R$ ' + fmtMoedaInput(data.valor_mensal_total);
    document.getElementById('dt-chip-criticos').textContent = criticos;
  } catch {}
}

/* ── Listagem ────────────────────────────────────────────────────────────── */

async function carregarListaFornecedores() {
  try {
    const res = await fetch('/api/detin/contratos');
    const todos = res.ok ? await res.json() : [];
    const fornecedores = [...new Set(todos.map(c => c.fornecedor))].sort();
    document.getElementById('f-fornecedor').innerHTML = '<option value="">Todos</option>' + fornecedores.map(f => `<option value="${f}">${f}</option>`).join('');
  } catch {}
}

async function carregarContratos() {
  const params = new URLSearchParams();
  const status = document.getElementById('f-status').value; if (status) params.set('status', status);
  const fornecedor = document.getElementById('f-fornecedor').value; if (fornecedor) params.set('fornecedor', fornecedor);
  const tipo = document.getElementById('f-tipo').value; if (tipo) params.set('tipo', tipo);
  const vencAte = document.getElementById('f-vencimento').value; if (vencAte) params.set('vencimento_ate', vencAte);
  try {
    const res = await fetch(`/api/detin/contratos?${params}`);
    _contratos = res.ok ? await res.json() : [];
    renderTabela();
  } catch {
    toast('Erro ao carregar contratos', 'error');
  }
}

function limparFiltros() {
  document.getElementById('f-status').value = '';
  document.getElementById('f-fornecedor').value = '';
  document.getElementById('f-tipo').value = '';
  document.getElementById('f-vencimento').value = '';
  carregarContratos();
}

function nomeSetor(id) { return (_setores.find(s => s.id === id) || {}).nome || '—'; }
function nomeUsuario(id) { return (_usuarios.find(u => u.id === id) || {}).nome || '—'; }

// Proporção da barrinha de urgência: cheia (100%) quando vence hoje/já venceu,
// esvaziando conforme os dias aumentam até o teto de 180 dias (mesma janela
// visual usada no Painel pra normalizar prazos curtos e longos na mesma escala).
function vencPct(dias) {
  if (dias == null) return 0;
  return Math.max(100 - Math.min(Math.max(dias, 0), 180) / 180 * 100, 4);
}

function renderTabela() {
  const tbody = document.getElementById('contratos-tbody');
  if (!_contratos.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum contrato encontrado.</td></tr>`;
    return;
  }
  tbody.innerHTML = _contratos.map(c => {
    const f = farolInfo(c.dias_restantes);
    const vencTxt = c.data_vencimento
      ? `<span style="color:${f.cor};font-weight:600;">${fmtBr(c.data_vencimento)}</span><span class="dt-venc-bar"><span class="dt-venc-bar-fill" style="width:${vencPct(c.dias_restantes)}%;background:${f.cor};"></span></span>`
      : '<span class="text-muted">Sem vigência</span>';
    const valorMensal = c.valor_mensal_efetivo != null ? c.valor_mensal_efetivo : c.valor_mensal;
    const divergente = c.valor_mensal_efetivo != null && c.valor_mensal != null && c.valor_mensal_efetivo !== c.valor_mensal;
    const aberto = _linhaExpandidaId === c.id;
    const linhaPrincipal = `<tr class="dt-row-clicavel" onclick="alternarExpansaoLinha(${c.id})">
      <td><button type="button" class="dt-expand-btn${aberto ? ' aberto' : ''}" aria-label="Ver detalhes" onclick="event.stopPropagation();alternarExpansaoLinha(${c.id});">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button></td>
      <td>${c.numero_contrato || '<span class="text-muted">—</span>'}</td>
      <td>${c.fornecedor}</td>
      <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(c.objeto || '').replace(/"/g, '&quot;')}">${c.objeto || '—'}</td>
      <td>${LABEL_TIPO[c.tipo] || c.tipo}</td>
      <td>${vencTxt}</td>
      <td>${valorMensal != null ? 'R$ ' + fmtMoedaInput(valorMensal) : '—'}${divergente ? '<span class="dt-divergencia" title="Valor efetivo diverge do contratual">⚠️</span>' : ''}</td>
      <td><span class="badge badge-${BADGE_STATUS_CLASS[c.status] || 'fechado'}">${LABEL_STATUS[c.status] || c.status}</span></td>
      <td style="text-align:right;white-space:nowrap;"><button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();abrirModalContratoEditar(${c.id})">Editar</button></td>
    </tr>`;
    if (!aberto) return linhaPrincipal;
    const aditivosTxt = _aditivosCache[c.id] != null ? `${_aditivosCache[c.id]} registrado(s)` : 'Carregando...';
    const linhaDetalhe = `<tr class="dt-detalhe-row"><td colspan="9">
      <div class="dt-detalhe-grid">
        <div><div class="dt-detalhe-campo-label">Setor</div><div class="dt-detalhe-campo-valor">${nomeSetor(c.setor_id)}</div></div>
        <div><div class="dt-detalhe-campo-label">Responsável</div><div class="dt-detalhe-campo-valor">${nomeUsuario(c.responsavel_id)}</div></div>
        <div><div class="dt-detalhe-campo-label">Nº SEI</div><div class="dt-detalhe-campo-valor">${c.numero_sei || '—'}</div></div>
        <div><div class="dt-detalhe-campo-label">Aditivos</div><div class="dt-detalhe-campo-valor">${aditivosTxt}</div></div>
        <div class="dt-detalhe-acoes">
          ${c.tem_anexo ? `<button type="button" class="btn btn-secondary btn-sm" onclick="event.stopPropagation();verAnexoContrato(${c.id})">📎 Ver anexo</button>` : ''}
          <button type="button" class="btn btn-primary btn-sm" onclick="event.stopPropagation();abrirModalContratoEditar(${c.id})">Abrir ficha completa</button>
        </div>
      </div>
    </td></tr>`;
    return linhaPrincipal + linhaDetalhe;
  }).join('');
}

async function alternarExpansaoLinha(id) {
  _linhaExpandidaId = _linhaExpandidaId === id ? null : id;
  renderTabela();
  if (_linhaExpandidaId === id && _aditivosCache[id] == null) {
    try {
      const res = await fetch(`/api/detin/contratos/${id}/aditivos`);
      const lista = res.ok ? await res.json() : [];
      _aditivosCache[id] = lista.length;
    } catch { _aditivosCache[id] = 0; }
    if (_linhaExpandidaId === id) renderTabela();
  }
}

/* ── Modal de cadastro/edição ───────────────────────────────────────────── */

function mudarAbaModalContrato(tab) {
  document.querySelectorAll('.dt-modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.dt-modal-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));
}

async function garantirListasCarregadas() {
  if (_setores.length || _usuarios.length) return;
  try {
    const [sRes, uRes] = await Promise.all([fetch('/api/detin/setores'), fetch('/api/detin/usuarios')]);
    _setores = sRes.ok ? await sRes.json() : [];
    _usuarios = uRes.ok ? await uRes.json() : [];
    document.getElementById('mc-setor').innerHTML = '<option value="">—</option>' + _setores.map(s => `<option value="${s.id}">${s.nome}</option>`).join('');
    document.getElementById('mc-responsavel').innerHTML = '<option value="">—</option>' + _usuarios.map(u => `<option value="${u.id}">${u.nome}</option>`).join('');
  } catch {}
}

const CAMPOS_TEXTO_LIMPAR = ['mc-numero', 'mc-fornecedor', 'mc-sei', 'mc-data-assinatura', 'mc-data-inicio', 'mc-data-vencimento',
  'mc-valor-global', 'mc-valor-anual', 'mc-valor-mensal', 'mc-valor-mensal-efetivo', 'mc-obs-financeira', 'mc-objeto', 'mc-itens', 'mc-observacoes'];

function limparFormContrato() {
  CAMPOS_TEXTO_LIMPAR.forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('mc-setor').value = '';
  document.getElementById('mc-responsavel').value = '';
  document.getElementById('mc-tipo').value = 'servico_continuado';
  document.getElementById('mc-modalidade').value = '';
  document.getElementById('mc-status').value = 'ativo';
  document.getElementById('mc-permite-renovacao').value = '';
  document.getElementById('mc-frequencia').value = 'mensal';
  document.getElementById('mc-divergencia-aviso').style.display = 'none';
  document.getElementById('mcont-msg').textContent = '';
  document.getElementById('mc-anexo-status').textContent = '—';
}

async function abrirModalContratoNovo() {
  await garantirListasCarregadas();
  _contratoEditandoId = null;
  limparFormContrato();
  document.getElementById('mcont-titulo').textContent = 'Novo Contrato';
  document.getElementById('mc-aditivos-sec').style.display = 'none';
  document.getElementById('mc-btn-ficha').style.display = 'none';
  mudarAbaModalContrato('identificacao');
  document.getElementById('modal-contrato').classList.add('open');
}

async function abrirModalContratoEditar(id) {
  await garantirListasCarregadas();
  let c;
  try {
    const res = await fetch(`/api/detin/contratos/${id}`);
    if (!res.ok) throw new Error();
    c = await res.json();
  } catch { toast('Erro ao carregar contrato', 'error'); return; }

  _contratoEditandoId = c.id;
  limparFormContrato();
  document.getElementById('mcont-titulo').textContent = `Editar Contrato — ${c.numero_contrato || 'S/N'}`;
  document.getElementById('mc-numero').value = c.numero_contrato || '';
  document.getElementById('mc-fornecedor').value = c.fornecedor || '';
  document.getElementById('mc-setor').value = c.setor_id || '';
  document.getElementById('mc-responsavel').value = c.responsavel_id || '';
  document.getElementById('mc-tipo').value = c.tipo || 'servico_continuado';
  document.getElementById('mc-modalidade').value = c.modalidade || '';
  document.getElementById('mc-sei').value = c.numero_sei || '';
  document.getElementById('mc-status').value = c.status || 'ativo';
  document.getElementById('mc-permite-renovacao').value = c.permite_renovacao || '';
  document.getElementById('mc-data-assinatura').value = c.data_assinatura || '';
  document.getElementById('mc-data-inicio').value = c.data_inicio || '';
  document.getElementById('mc-data-vencimento').value = c.data_vencimento || '';
  document.getElementById('mc-valor-global').value = fmtMoedaInput(c.valor_global);
  document.getElementById('mc-valor-anual').value = fmtMoedaInput(c.valor_anual);
  document.getElementById('mc-valor-mensal').value = fmtMoedaInput(c.valor_mensal);
  document.getElementById('mc-valor-mensal-efetivo').value = fmtMoedaInput(c.valor_mensal_efetivo);
  document.getElementById('mc-frequencia').value = c.frequencia_pagamento || 'mensal';
  document.getElementById('mc-obs-financeira').value = c.observacao_financeira || '';
  document.getElementById('mc-objeto').value = c.objeto || '';
  document.getElementById('mc-itens').value = c.itens || '';
  document.getElementById('mc-observacoes').value = c.observacoes || '';
  document.getElementById('mc-divergencia-aviso').style.display =
    (c.valor_mensal_efetivo != null && c.valor_mensal != null && c.valor_mensal_efetivo !== c.valor_mensal) ? '' : 'none';
  document.getElementById('mc-anexo-status').innerHTML = c.tem_anexo
    ? `📎 ${c.anexo_nome || 'contrato.pdf'} — <a href="#" onclick="verAnexoContrato(${c.id});return false;">ver PDF</a>`
    : 'Nenhum PDF anexado.';

  document.getElementById('mc-aditivos-sec').style.display = '';
  document.getElementById('mc-btn-ficha').style.display = '';
  document.getElementById('mc-btn-ficha').textContent = 'Gerar Ficha (PDF)';
  document.getElementById('mc-btn-ficha').onclick = gerarFichaContrato;
  await carregarAditivos(c.id);
  mudarAbaModalContrato('identificacao');
  document.getElementById('modal-contrato').classList.add('open');
}

function fecharModalContrato() {
  document.getElementById('modal-contrato').classList.remove('open');
  _contratoEditandoId = null;
}

async function salvarContrato() {
  const msg = document.getElementById('mcont-msg');
  msg.style.color = '#c0392b';
  const fornecedor = document.getElementById('mc-fornecedor').value.trim();
  if (!fornecedor) { msg.textContent = 'Informe o fornecedor.'; mudarAbaModalContrato('identificacao'); return; }

  const body = {
    numero_contrato: document.getElementById('mc-numero').value.trim() || null,
    fornecedor,
    setor_id: document.getElementById('mc-setor').value || null,
    responsavel_id: document.getElementById('mc-responsavel').value || null,
    tipo: document.getElementById('mc-tipo').value,
    modalidade: document.getElementById('mc-modalidade').value || null,
    numero_sei: document.getElementById('mc-sei').value.trim() || null,
    status: document.getElementById('mc-status').value,
    permite_renovacao: document.getElementById('mc-permite-renovacao').value || null,
    data_assinatura: document.getElementById('mc-data-assinatura').value || null,
    data_inicio: document.getElementById('mc-data-inicio').value || null,
    data_vencimento: document.getElementById('mc-data-vencimento').value || null,
    objeto: document.getElementById('mc-objeto').value.trim() || null,
    itens: document.getElementById('mc-itens').value.trim() || null,
    valor_global: parseMoedaInput(document.getElementById('mc-valor-global').value),
    valor_anual: parseMoedaInput(document.getElementById('mc-valor-anual').value),
    valor_mensal: parseMoedaInput(document.getElementById('mc-valor-mensal').value),
    valor_mensal_efetivo: parseMoedaInput(document.getElementById('mc-valor-mensal-efetivo').value),
    frequencia_pagamento: document.getElementById('mc-frequencia').value,
    observacao_financeira: document.getElementById('mc-obs-financeira').value.trim() || null,
    observacoes: document.getElementById('mc-observacoes').value.trim() || null,
  };
  try {
    const url = _contratoEditandoId ? `/api/detin/contratos/${_contratoEditandoId}` : '/api/detin/contratos';
    const method = _contratoEditandoId ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Erro ao salvar'); }
    toast(_contratoEditandoId ? 'Contrato atualizado.' : 'Contrato criado.');
    fecharModalContrato();
    carregarListaFornecedores();
    carregarContratos();
    carregarChips();
  } catch (e) {
    msg.textContent = 'Erro: ' + e.message;
  }
}

/* ── Anexo (PDF do contrato) ─────────────────────────────────────────────── */

async function enviarAnexoContrato(input) {
  if (!_contratoEditandoId) { toast('Salve o contrato antes de anexar o PDF.', 'error'); input.value = ''; return; }
  const file = input.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch(`/api/detin/contratos/${_contratoEditandoId}/anexo?nome=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: buf,
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Erro ao anexar'); }
    toast('PDF anexado.');
    document.getElementById('mc-anexo-status').innerHTML = `📎 ${file.name} — <a href="#" onclick="verAnexoContrato(${_contratoEditandoId});return false;">ver PDF</a>`;
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
  input.value = '';
}
function verAnexoContrato(id) {
  window.open(`/api/detin/contratos/${id}/anexo`, '_blank');
}

/* ── Aditivos ────────────────────────────────────────────────────────────── */

async function carregarAditivos(contratoId) {
  let lista = [];
  try {
    const res = await fetch(`/api/detin/contratos/${contratoId}/aditivos`);
    lista = res.ok ? await res.json() : [];
  } catch {}
  document.getElementById('mc-aditivos-lista').innerHTML = lista.length
    ? lista.map(a => `<div class="dt-aditivo-item">
        <strong>${a.numero_aditivo || '—'}</strong> · ${fmtBr(a.data)} · ${LABEL_ADITIVO[a.tipo] || a.tipo}
        <span class="text-muted" style="flex:1;">${a.descricao || ''}</span>
        <button class="btn btn-danger btn-xs" onclick="excluirAditivo(${a.id},${contratoId})">Excluir</button>
      </div>`).join('')
    : '<span class="text-muted" style="font-size:12px;">Nenhum aditivo registrado.</span>';
}

function abrirModalAditivo() {
  if (!_contratoEditandoId) return;
  ['ad-numero', 'ad-data', 'ad-descricao', 'ad-novo-valor', 'ad-nova-data-venc'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('ad-tipo').value = 'prazo';
  document.getElementById('ad-msg').textContent = '';
  document.getElementById('modal-aditivo').classList.add('open');
}
function fecharModalAditivo() {
  document.getElementById('modal-aditivo').classList.remove('open');
}
async function salvarAditivo() {
  const msg = document.getElementById('ad-msg');
  msg.style.color = '#c0392b';
  const body = {
    numero_aditivo: document.getElementById('ad-numero').value.trim() || null,
    data: document.getElementById('ad-data').value || null,
    tipo: document.getElementById('ad-tipo').value,
    descricao: document.getElementById('ad-descricao').value.trim() || null,
    novo_valor_mensal: parseMoedaInput(document.getElementById('ad-novo-valor').value),
    nova_data_vencimento: document.getElementById('ad-nova-data-venc').value || null,
  };
  try {
    const res = await fetch(`/api/detin/contratos/${_contratoEditandoId}/aditivos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Erro ao salvar'); }
    fecharModalAditivo();
    await carregarAditivos(_contratoEditandoId);
    delete _aditivosCache[_contratoEditandoId];
    if (body.nova_data_vencimento) document.getElementById('mc-data-vencimento').value = body.nova_data_vencimento;
    if (body.novo_valor_mensal) document.getElementById('mc-valor-mensal').value = fmtMoedaInput(body.novo_valor_mensal);
    toast('Aditivo registrado.');
    carregarChips();
  } catch (e) {
    msg.textContent = 'Erro: ' + e.message;
  }
}
async function excluirAditivo(id, contratoId) {
  if (!confirm('Excluir este aditivo?')) return;
  try {
    const res = await fetch(`/api/detin/aditivos/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    await carregarAditivos(contratoId);
    delete _aditivosCache[contratoId];
    toast('Aditivo excluído.');
    carregarChips();
  } catch {
    toast('Erro ao excluir', 'error');
  }
}

/* ── Relatórios prontos (PDF) ───────────────────────────────────────────────
   Mesmo padrão popup-safe da Análise: fetch guarda o blob, um clique
   SEPARADO no botão que aparece é que abre/baixa — nunca automático depois
   de um await (navegador pode bloquear). */

function abrirDownloadBlob(blobUrl, nome) {
  const a = document.createElement('a');
  a.href = blobUrl; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
}

async function gerarRelatorio(tipo) {
  const spanId = `dtr-resultado-${tipo}`;
  const span = document.getElementById(spanId);
  span.innerHTML = ' <span class="text-muted" style="font-size:12px;">Gerando...</span>';
  let url, nomeArquivo;
  if (tipo === 'lista') {
    const params = new URLSearchParams();
    const status = document.getElementById('f-status').value; if (status) params.set('status', status);
    const fornecedor = document.getElementById('f-fornecedor').value; if (fornecedor) params.set('fornecedor', fornecedor);
    const tipoContrato = document.getElementById('f-tipo').value; if (tipoContrato) params.set('tipo', tipoContrato);
    const vencAte = document.getElementById('f-vencimento').value; if (vencAte) params.set('vencimento_ate', vencAte);
    url = `/api/detin/relatorios/contratos?${params}`;
    nomeArquivo = 'detin-lista-contratos.pdf';
  } else if (tipo === 'vencimentos') {
    const dias = document.getElementById('dtr-venc-dias').value;
    url = `/api/detin/relatorios/vencimentos?dias=${dias}`;
    nomeArquivo = 'detin-vencimentos.pdf';
  } else {
    url = '/api/detin/relatorios/financeiro';
    nomeArquivo = 'detin-financeiro.pdf';
  }
  try {
    const res = await fetch(url);
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Erro ao gerar'); }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    span.innerHTML = ` <button class="btn btn-primary btn-sm" onclick="abrirDownloadBlob('${blobUrl}','${nomeArquivo}')">📄 Abrir/Baixar</button>`;
  } catch (e) {
    span.innerHTML = '';
    toast('Erro: ' + e.message, 'error');
  }
}

function abrirModalRelatorios() {
  ['lista', 'vencimentos', 'financeiro'].forEach(t => { document.getElementById(`dtr-resultado-${t}`).innerHTML = ''; });
  document.getElementById('modal-relatorios').classList.add('open');
}

async function gerarFichaContrato() {
  if (!_contratoEditandoId) return;
  const btn = document.getElementById('mc-btn-ficha');
  const original = btn.textContent;
  btn.textContent = 'Gerando...'; btn.disabled = true;
  try {
    const res = await fetch(`/api/detin/contratos/${_contratoEditandoId}/ficha`);
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Erro ao gerar'); }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    btn.textContent = original; btn.disabled = false;
    btn.onclick = () => { abrirDownloadBlob(blobUrl, `detin-ficha-${_contratoEditandoId}.pdf`); btn.onclick = gerarFichaContrato; btn.textContent = original; };
    btn.textContent = '📄 Abrir/Baixar Ficha';
  } catch (e) {
    btn.textContent = original; btn.disabled = false;
    toast('Erro: ' + e.message, 'error');
  }
}

/* ── Acesso por Setor ────────────────────────────────────────────────────── */

async function abrirModalSetorAcesso() {
  await garantirListasCarregadas();
  const sel = document.getElementById('msa-setor');
  sel.innerHTML = _setores.map(s => `<option value="${s.id}">${s.nome}</option>`).join('');
  document.getElementById('modal-setor-acesso').classList.add('open');
  if (_setores.length) carregarUsuariosDoSetor();
}

async function carregarUsuariosDoSetor() {
  const setorId = document.getElementById('msa-setor').value;
  const cont = document.getElementById('msa-usuarios');
  if (!setorId) { cont.innerHTML = ''; return; }
  cont.innerHTML = '<span class="text-muted" style="font-size:12px;">Carregando...</span>';
  try {
    const res = await fetch(`/api/detin/setores/${setorId}/usuarios`);
    if (!res.ok) throw new Error();
    const usuarios = await res.json();
    cont.innerHTML = usuarios.map(u => `
      <label style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12.5px;">
        <input type="checkbox" ${u.vinculado ? 'checked' : ''} onchange="alterarVinculoSetor(${setorId},${u.id},this.checked)" />
        ${u.nome_completo || u.username}
      </label>
    `).join('') || '<span class="text-muted" style="font-size:12px;">Nenhum usuário.</span>';
  } catch {
    cont.innerHTML = '<span class="text-muted" style="font-size:12px;">Erro ao carregar.</span>';
  }
}

async function alterarVinculoSetor(setorId, userId, vinculado) {
  try {
    const res = await fetch(`/api/detin/setores/${setorId}/usuarios`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, vinculado }),
    });
    if (!res.ok) throw new Error();
    toast('Salvo.');
  } catch {
    toast('Erro ao salvar', 'error');
    carregarUsuariosDoSetor();
  }
}

/* ── Boot ────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  ['mc-valor-global', 'mc-valor-anual', 'mc-valor-mensal', 'mc-valor-mensal-efetivo'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('blur', () => { el.value = fmtMoedaInput(parseMoedaInput(el.value)); });
  });
  carregarListaFornecedores();
  carregarContratos();
  carregarChips();
  garantirListasCarregadas(); // pré-carrega setor/responsável pra linha expansível não esperar

  // Vindo de um link do Painel ("Ver contrato") — abre direto no detalhe.
  const idParam = new URLSearchParams(location.search).get('id');
  if (idParam) abrirModalContratoEditar(Number(idParam));
});
