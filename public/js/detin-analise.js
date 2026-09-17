// DETIN — Análise de Contratos: fluxo em 3 fases (seleção → perguntas → PDF).

function toast(msg, tipo) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (tipo ? ' ' + tipo : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
}
function fmtBr(iso) {
  if (!iso) return '—';
  const d = String(iso).split(/[T ]/)[0].split('-');
  return d.length < 3 ? '—' : `${d[2]}/${d[1]}/${d[0]}`;
}
function fmtMoeda(v) {
  if (v == null) return '—';
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const LABEL_RENOVACAO = { renovacao: 'Renovação', nova_licitacao: 'Nova Licitação', extincao: 'Extinção do Serviço' };

let _contratosAtivos = [];
let _selecionados = new Set();
let _analiseId = null;
let _analiseDados = null;
let _indiceAtual = 0;
let _pdfBlobUrl = null;

function mostrarTela(nome) {
  document.getElementById('dta-lista-analises').style.display = nome === 'lista' ? 'block' : 'none';
  ['1', '2', '3'].forEach(n => document.getElementById(`dta-fase-${n}`).classList.toggle('active', nome === `fase${n}`));
  document.getElementById('dta-lista-btn-wrap').style.display = nome === 'lista' ? 'none' : 'block';
}

/* ── Lista de análises ───────────────────────────────────────────────────── */

async function carregarListaAnalises() {
  mostrarTela('lista');
  try {
    const res = await fetch('/api/detin/analises');
    const lista = res.ok ? await res.json() : [];
    document.getElementById('dta-analises-tbody').innerHTML = lista.map(a => `
      <tr>
        <td>${a.titulo}</td>
        <td>${a.total_contratos}</td>
        <td>${a.finalizado ? '<span class="badge badge-aberto">Finalizada</span>' : '<span class="badge badge-analise">Rascunho</span>'}</td>
        <td>${fmtBr(a.criado_em)}</td>
        <td style="text-align:right;">
          ${a.finalizado
            ? `<button class="btn btn-secondary btn-sm" onclick="window.open('/api/detin/analises/${a.id}/pdf','_blank')">Ver PDF</button>`
            : `<button class="btn btn-primary btn-sm" onclick="continuarAnalise(${a.id})">Continuar</button>`}
        </td>
      </tr>
    `).join('') || `<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhuma análise criada ainda.</td></tr>`;
  } catch {
    toast('Erro ao carregar análises', 'error');
  }
}
function voltarParaLista() { carregarListaAnalises(); }

/* ── Fase 1: seleção de contratos ────────────────────────────────────────── */

async function iniciarNovaAnalise() {
  document.getElementById('dta-titulo').value = '';
  _selecionados = new Set();
  mostrarTela('fase1');
  try {
    const res = await fetch('/api/detin/contratos?status=ativo');
    _contratosAtivos = res.ok ? await res.json() : [];
  } catch { _contratosAtivos = []; }
  renderListaSelecao();
}

function renderListaSelecao() {
  document.getElementById('dta-lista-selecao').innerHTML = _contratosAtivos.map(c => `
    <label class="dta-linha-selecao">
      <input type="checkbox" value="${c.id}" ${_selecionados.has(c.id) ? 'checked' : ''} onchange="toggleSelecao(${c.id}, this.checked)" />
      <span class="dta-linha-fornecedor">${c.fornecedor}</span>
      <span class="dta-linha-objeto" title="${(c.objeto || '').replace(/"/g, '&quot;')}">${c.objeto || '—'}</span>
      <span class="dta-linha-venc">${c.data_vencimento ? fmtBr(c.data_vencimento) : 'Sem vigência'} · ${fmtMoeda(c.valor_mensal_efetivo != null ? c.valor_mensal_efetivo : c.valor_mensal)}/mês</span>
    </label>
  `).join('') || '<div style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum contrato ativo.</div>';
}

function toggleSelecao(id, marcado) {
  if (marcado) _selecionados.add(id); else _selecionados.delete(id);
  document.getElementById('dta-btn-avancar-perguntas').disabled = _selecionados.size === 0;
}

async function avancarParaPerguntas() {
  const titulo = document.getElementById('dta-titulo').value.trim();
  if (!titulo) { toast('Informe um título para a análise.', 'error'); return; }
  if (!_selecionados.size) { toast('Selecione ao menos 1 contrato.', 'error'); return; }
  try {
    const res = await fetch('/api/detin/analises', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titulo, contrato_ids: [..._selecionados] }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Erro ao criar análise'); }
    const { id } = await res.json();
    await carregarAnalise(id);
    _indiceAtual = 0;
    mostrarTela('fase2');
    renderContratoAtual();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}
function voltarParaSelecao() { iniciarNovaAnalise(); }

/* ── Fase 2: perguntas por contrato ──────────────────────────────────────── */

async function carregarAnalise(id) {
  const res = await fetch(`/api/detin/analises/${id}`);
  if (!res.ok) throw new Error('Análise não encontrada');
  _analiseDados = await res.json();
  _analiseId = id;
}

async function continuarAnalise(id) {
  try {
    await carregarAnalise(id);
    _indiceAtual = 0;
    mostrarTela('fase2');
    renderContratoAtual();
  } catch {
    toast('Erro ao carregar a análise', 'error');
  }
}

function respondidoCompleto(c) {
  return !!(c.resp_reducao_linear && c.resp_alteracao_objeto && c.resp_renovacao && c.resp_sugestao_reducao);
}

function renderContratoAtual() {
  const contratos = _analiseDados.contratos;
  const c = contratos[_indiceAtual];
  const total = contratos.length;

  document.getElementById('dta-fase2-titulo').textContent = _analiseDados.titulo;
  document.getElementById('dta-progress-fill').style.width = `${((_indiceAtual + 1) / total) * 100}%`;
  document.getElementById('dta-progress-label').textContent = `Contrato ${_indiceAtual + 1} de ${total}`;

  const valorMensal = c.valor_mensal_efetivo != null ? c.valor_mensal_efetivo : c.valor_mensal;
  document.getElementById('dta-contrato-header').innerHTML = `
    <strong>${c.numero_contrato || 'Sem número'} — ${c.fornecedor}</strong><br/>
    Vigência: ${c.data_vencimento ? `até ${fmtBr(c.data_vencimento)}` : 'não estipulada'} · Valor mensal: ${fmtMoeda(valorMensal)}<br/>
    <span class="text-muted">${c.objeto || ''}</span>
  `;

  document.getElementById('dta-p1').value = c.resp_reducao_linear || '';
  document.getElementById('dta-p2').value = c.resp_alteracao_objeto || '';
  document.querySelectorAll('input[name="dta-p3"]').forEach(r => { r.checked = r.value === c.resp_renovacao; });
  document.getElementById('dta-p4').value = c.resp_sugestao_reducao || '';
  const temSimilar = !!c.resp_contrato_similar;
  document.querySelectorAll('input[name="dta-p5-toggle"]').forEach(r => { r.checked = (r.value === 'sim') === temSimilar; });
  document.getElementById('dta-p5-texto').style.display = temSimilar ? '' : 'none';
  document.getElementById('dta-p5-texto').value = c.resp_contrato_similar || '';
  document.getElementById('dta-obs').value = c.observacoes || '';
  document.getElementById('dta-save-status').textContent = '';

  document.getElementById('dta-btn-anterior').disabled = _indiceAtual === 0;
  document.getElementById('dta-btn-proximo').disabled = _indiceAtual === total - 1;

  atualizarBotaoGerar();
}

function alternarContratoSimilar(mostrar) {
  document.getElementById('dta-p5-texto').style.display = mostrar ? '' : 'none';
  if (!mostrar) document.getElementById('dta-p5-texto').value = '';
  salvarRespostaAtual();
}

function atualizarBotaoGerar() {
  const todos = _analiseDados.contratos.every(respondidoCompleto);
  document.getElementById('dta-btn-gerar').style.display = todos ? '' : 'none';
}

let _salvandoTimer = null;
async function salvarRespostaAtual() {
  const c = _analiseDados.contratos[_indiceAtual];
  const p5toggle = document.querySelector('input[name="dta-p5-toggle"]:checked');
  const similar = p5toggle && p5toggle.value === 'sim' ? (document.getElementById('dta-p5-texto').value.trim() || '') : null;
  const body = {
    contrato_id: c.contrato_id,
    resp_reducao_linear: document.getElementById('dta-p1').value.trim() || null,
    resp_alteracao_objeto: document.getElementById('dta-p2').value.trim() || null,
    resp_renovacao: (document.querySelector('input[name="dta-p3"]:checked') || {}).value || null,
    resp_sugestao_reducao: document.getElementById('dta-p4').value.trim() || null,
    resp_contrato_similar: similar,
    observacoes: document.getElementById('dta-obs').value.trim() || null,
  };
  // Atualiza o cache local na hora, pra atualizarBotaoGerar() já refletir sem esperar a rede.
  Object.assign(c, body);
  atualizarBotaoGerar();
  try {
    const res = await fetch(`/api/detin/analises/${_analiseId}/respostas`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error();
    document.getElementById('dta-save-status').textContent = `Salvo às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    document.getElementById('dta-save-status').textContent = 'Erro ao salvar — tente novamente.';
  }
}

function navegarContrato(delta) {
  const novo = _indiceAtual + delta;
  if (novo < 0 || novo >= _analiseDados.contratos.length) return;
  _indiceAtual = novo;
  renderContratoAtual();
}

/* ── Prévia do PDF (Fase 2, a qualquer momento) ─────────────────────────────
   Mesmo padrão popup-safe do resto do módulo: fetch guarda o blob, um clique
   SEPARADO (o botão que aparece) é que abre — nunca window.open automático
   logo depois de um await. Não finaliza a análise nem grava nada. */
async function preverPdfAnalise() {
  const span = document.getElementById('dta-preview-resultado');
  span.innerHTML = ' <span class="text-muted" style="font-size:12px;">Gerando prévia...</span>';
  try {
    const res = await fetch(`/api/detin/analises/${_analiseId}/preview-pdf`);
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Erro ao gerar prévia'); }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    span.innerHTML = ` <button type="button" class="btn btn-primary btn-sm" onclick="window.open('${blobUrl}','_blank')">📄 Abrir Prévia</button>`;
  } catch (e) {
    span.innerHTML = '';
    toast('Erro: ' + e.message, 'error');
  }
}

/* ── Fase 3: geração do PDF ──────────────────────────────────────────────── */

function irParaGeracao() {
  document.getElementById('dta-resumo-geracao').textContent =
    `A análise "${_analiseDados.titulo}" tem ${_analiseDados.contratos.length} contrato(s) prontos para o relatório.`;
  document.getElementById('dta-geracao-acoes').style.display = '';
  document.getElementById('dta-geracao-loading').style.display = 'none';
  document.getElementById('dta-geracao-pronto').style.display = 'none';
  _pdfBlobUrl = null;
  mostrarTela('fase3');
}
function voltarParaPerguntas() {
  mostrarTela('fase2');
  renderContratoAtual();
}

async function gerarPdfAnalise() {
  document.getElementById('dta-geracao-acoes').style.display = 'none';
  document.getElementById('dta-geracao-loading').style.display = '';
  try {
    const res = await fetch(`/api/detin/analises/${_analiseId}/gerar-pdf`, { method: 'POST' });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Erro ao gerar PDF'); }
    const blob = await res.blob();
    _pdfBlobUrl = URL.createObjectURL(blob);
    document.getElementById('dta-geracao-loading').style.display = 'none';
    document.getElementById('dta-geracao-pronto').style.display = '';
  } catch (e) {
    document.getElementById('dta-geracao-loading').style.display = 'none';
    document.getElementById('dta-geracao-acoes').style.display = '';
    toast('Erro: ' + e.message, 'error');
  }
}
function baixarPdfGerado() {
  if (!_pdfBlobUrl) return;
  const a = document.createElement('a');
  a.href = _pdfBlobUrl;
  a.download = `analise-${_analiseId}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

document.addEventListener('DOMContentLoaded', carregarListaAnalises);
