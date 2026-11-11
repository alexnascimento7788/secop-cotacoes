// PAC/DEPLA — Dados Concessionários: importação da planilha de tarifas do
// CORPORE (aba "Result 1") + relatório resumido (pac-concessionarios.html),
// cruzado com depop.db. Ver routes/pac-concessionarios.js pra lógica de
// casamento (match_confianca) e pros campos calculados
// (camposDepop/carregarDadosDepop).
// Por padrão o relatório só mostra concessionários CASADOS com um contrato
// de 20 anos no depop — o checkbox "Mostrar Demais" inclui o resto (fora do
// programa de renovação, só existem na planilha do CORPORE).

function toast(msg, tipo) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (tipo ? ' ' + tipo : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
}

function fmtMoeda(v) {
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtBrData(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

function dcBadgeRenovacao(renovacao) {
  return renovacao
    ? '<span class="dc-badge dc-badge-renovacao-sim">Sim</span>'
    : '<span class="dc-badge dc-badge-renovacao-nao">Não</span>';
}

// Pedido do Alex, 2026-11-11: no lugar da coluna "Casamento", um ponto
// pequeno perto do nome — verde/vermelho, com o detalhe só no mouseover
// (title nativo do browser). Só aparece pra quem tem renovação — "Demais"
// já mostra "Renovação: Não", não tem casamento pra avaliar.
function dcIconeCasamento(renovacao, matchConfianca) {
  if (!renovacao) return '';
  const ok = matchConfianca === 'direto' || matchConfianca === 'data';
  const cor = ok ? '#16a34a' : '#dc2626';
  const titulo = ok ? 'Casamento OK' : 'Casamento manual — confira';
  return ` <span class="dc-casamento-dot" style="background:${cor}" title="${titulo}"></span>`;
}

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

// Aplica o formato de moeda (R$) nas células numéricas de 1+ colunas de uma
// planilha SheetJS já montada — json_to_sheet não formata número nenhum
// sozinho, só grava o valor cru.
function aplicarFormatoMoeda(ws, colunasIdx, numLinhas) {
  for (let linha = 1; linha <= numLinhas; linha++) {
    colunasIdx.forEach(col => {
      const ref = XLSX.utils.encode_cell({ r: linha, c: col });
      if (ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = '"R$" #,##0.00';
    });
  }
}

let _dcLinhasPlanilha = null;
let _dcNomeArquivo = '';

async function dcArquivoEscolhido(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  _dcNomeArquivo = file.name;
  document.getElementById('dc-nome-arquivo').textContent = `Processando "${file.name}"...`;

  try {
    const XLSX = await carregarXLSX();
    const data = await file.arrayBuffer();
    const wb   = XLSX.read(data, { type: 'array' });
    const nomeAba = wb.SheetNames.includes('Result 1') ? 'Result 1' : wb.SheetNames[0];
    const ws   = wb.Sheets[nomeAba];
    _dcLinhasPlanilha = XLSX.utils.sheet_to_json(ws, { defval: '' });
    document.getElementById('dc-nome-arquivo').textContent =
      `"${file.name}" — aba "${nomeAba}", ${_dcLinhasPlanilha.length} linha(s). Simulando...`;
    await dcSimular();
  } catch (e) {
    document.getElementById('dc-nome-arquivo').textContent = 'Erro ao ler o arquivo: ' + e.message;
  }
}

async function dcSimular() {
  if (!_dcLinhasPlanilha) return;
  try {
    const res = await fetch('/api/pac/concessionarios/importar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: true, nome_arquivo: _dcNomeArquivo, linhas: _dcLinhasPlanilha }),
    });
    const r = await res.json();
    if (!res.ok) { toast(r.error || 'Erro ao simular importação', 'error'); return; }

    document.getElementById('dc-nome-arquivo').textContent = `"${_dcNomeArquivo}" — ${r.total_linhas} linha(s) na planilha.`;
    document.getElementById('dc-dryrun-resultado').style.display = '';
    document.getElementById('dc-dr-linhas').textContent   = r.total_linhas;
    document.getElementById('dc-dr-termos').textContent   = r.total_termos;
    document.getElementById('dc-dr-direto').textContent   = r.casados_direto;
    document.getElementById('dc-dr-data').textContent     = r.casados_por_data;
    document.getElementById('dc-dr-manual').textContent   = r.casados_manual;
    document.getElementById('dc-dr-semmatch').textContent = r.sem_match;

    const aviso = document.getElementById('dc-dryrun-aviso');
    if (r.linhas_sem_codigo > 0 || r.casados_manual > 0) {
      aviso.style.display = '';
      aviso.textContent = `Atenção: ${r.linhas_sem_codigo} linha(s) sem código de concessionário foram ignoradas` +
        (r.casados_manual > 0 ? `; ${r.casados_manual} contrato(s) ficaram marcados "Revisar" (casamento por data ambíguo com o depop.db).` : '.');
    } else {
      aviso.style.display = 'none';
    }
  } catch (e) {
    toast('Erro ao simular: ' + e.message, 'error');
  }
}

async function dcConfirmarImportacao() {
  if (!_dcLinhasPlanilha) return;
  const btn = document.getElementById('dc-btn-confirmar');
  btn.disabled = true;
  document.getElementById('dc-import-msg').textContent = 'Importando...';
  try {
    const res = await fetch('/api/pac/concessionarios/importar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: false, nome_arquivo: _dcNomeArquivo, linhas: _dcLinhasPlanilha }),
    });
    const r = await res.json();
    if (!res.ok) { document.getElementById('dc-import-msg').textContent = r.error || 'Erro ao importar'; return; }
    document.getElementById('dc-import-msg').textContent = `Importação #${r.importacao_id} concluída — ${r.total_termos} contrato(s).`;
    toast('Importação concluída', 'success');
    _dcLinhasPlanilha = null;
    document.getElementById('dc-dryrun-resultado').style.display = 'none';
    await dcCarregarImportacoes(r.importacao_id);
  } catch (e) {
    document.getElementById('dc-import-msg').textContent = 'Erro: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function dcCarregarImportacoes(selecionarId) {
  try {
    const res = await fetch('/api/pac/concessionarios/importacoes');
    const lista = await res.json();
    const sel = document.getElementById('dc-select-importacao');
    sel.innerHTML = lista.map(i =>
      `<option value="${i.id}">#${i.id} — ${fmtBrData(i.criado_em)} (${i.total_termos} contratos, por ${i.importado_por_username || '—'})</option>`
    ).join('');
    if (lista.length) {
      sel.value = selecionarId || lista[0].id;
      await dcTrocarImportacao();
    }
  } catch (e) {
    toast('Erro ao carregar importações: ' + e.message, 'error');
  }
}

async function dcTrocarImportacao() {
  await dcCarregarResumido();
}

function dcParamsAtuais() {
  const sel = document.getElementById('dc-select-importacao');
  const incluirDemais = document.getElementById('dc-check-demais').checked;
  if (!sel.value) return null;
  return `importacao_id=${sel.value}${incluirDemais ? '&incluir_demais=1' : ''}`;
}

function dcAtualizarNotaDemais(totalDemais) {
  const nota = document.getElementById('dc-demais-nota');
  const incluirDemais = document.getElementById('dc-check-demais').checked;
  if (!totalDemais) { nota.textContent = ''; return; }
  nota.textContent = incluirDemais
    ? `Mostrando os ${totalDemais} concessionário(s) sem contrato de renovação de 20 anos junto com os demais.`
    : `${totalDemais} concessionário(s) da planilha não têm contrato de renovação de 20 anos no Depop — ficam fora dos relatórios (ative "Mostrar Demais" pra ver).`;
}

// "Preciso do validador informando que a quantidade de concessionários no
// Depop bate com o que apresentamos aqui" (Alex, 2026-11-05).
function dcAtualizarValidador(v) {
  const el = document.getElementById('dc-validador');
  if (!el || !v) return;
  el.style.display = '';
  el.className = 'dc-banner ' + (v.bate ? 'dc-banner-ok' : 'dc-banner-erro');
  if (v.bate) {
    el.innerHTML = `✓ Validado: os ${v.contratos_depop} contratos de renovação de 20 anos do Depop batem com os ${v.contratos_apresentados} apresentados aqui (${v.empresas_apresentadas} empresas).`;
    return;
  }
  el.innerHTML = `
    ⚠ Atenção: o Depop tem ${v.contratos_depop} contrato(s) de renovação de 20 anos (${v.empresas_depop} empresas), mas só ${v.contratos_apresentados} estão apresentados aqui (${v.empresas_apresentadas} empresas) — ${v.contratos_depop - v.contratos_apresentados} contrato(s) do Depop não têm nenhuma linha correspondente na planilha importada:
    <ul class="dc-validador-detalhe">
      ${v.contratos_faltando.map(c => `<li>Código ${c.codigo} — ${c.concessionario || '—'} (CCU ${c.numero_ccu || '—'})</li>`).join('')}
    </ul>
  `;
}

// Pedido do Alex, 2026-11-11: qts de concessionários, qtd renovação e valor
// de tarifa resumido por entreposto (cidade) — sempre o retrato completo,
// independente do checkbox "Mostrar Demais" (que só filtra a tabela).
function dcRenderCards(cards) {
  const el = document.getElementById('dc-cards');
  if (!el || !cards) return;
  const linhasEntreposto = cards.tarifa_por_entreposto.map(e =>
    `<div class="dc-entreposto-linha"><span>${e.cidade}</span><span>${fmtMoeda(e.total)}</span></div>`
  ).join('') || '<div class="dc-entreposto-linha"><span>—</span></div>';
  el.innerHTML = `
    <div class="dc-card-metric"><div class="dc-card-metric-label">Concessionários</div><div class="dc-card-metric-valor">${cards.total_concessionarios}</div></div>
    <div class="dc-card-metric"><div class="dc-card-metric-label">Com Renovação</div><div class="dc-card-metric-valor">${cards.total_renovacao}</div></div>
    <div class="dc-card-metric"><div class="dc-card-metric-label">Demais (sem renovação)</div><div class="dc-card-metric-valor">${cards.total_demais}</div></div>
    <div class="dc-card-metric dc-card-entreposto"><div class="dc-card-metric-label">Tarifa de Uso por Entreposto</div>${linhasEntreposto}</div>
  `;
}

let _dcLinhasResumido = [];

async function dcCarregarResumido() {
  const params = dcParamsAtuais();
  if (!params) { document.getElementById('dc-tbody').innerHTML = '<tr><td colspan="11">Nenhuma importação ainda.</td></tr>'; return; }
  try {
    const res = await fetch(`/api/pac/concessionarios/resumido?${params}`);
    const r = await res.json();
    _dcLinhasResumido = r.linhas || [];
    dcAtualizarNotaDemais(r.total_demais);
    dcAtualizarValidador(r.validador);
    dcRenderCards(r.cards);
    const tbody = document.getElementById('dc-tbody');
    if (!_dcLinhasResumido.length) {
      tbody.innerHTML = '<tr><td colspan="11">Nenhum contrato nesta importação.</td></tr>';
      return;
    }
    tbody.innerHTML = _dcLinhasResumido.map(l => `
      <tr>
        <td>${l.codigo ?? '—'}</td>
        <td>${l.empresa || '—'}${dcIconeCasamento(l.renovacao, l.match_confianca)}</td>
        <td>${l.cnpj || '—'}</td>
        <td>${dcBadgeRenovacao(l.renovacao)}</td>
        <td>${l.prazo_final_adesao || '—'}</td>
        <td>${l.contrato_numero || '—'}</td>
        <td>${fmtBrData(l.contrato_data_inicio)}</td>
        <td>${fmtBrData(l.contrato_vencido_em)}</td>
        <td class="dc-num">${fmtMoeda(l.tarifa_uso)}</td>
        <td class="dc-num">${fmtMoeda(l.valor_ponto)}</td>
        <td class="dc-num">${fmtMoeda(l.outorga)}</td>
      </tr>
    `).join('');
  } catch (e) {
    toast('Erro ao carregar relatório resumido: ' + e.message, 'error');
  }
}

async function dcExportarExcelResumido() {
  if (!_dcLinhasResumido.length) { toast('Nada para exportar', 'error'); return; }
  try {
    const XLSX = await carregarXLSX();
    const dados = _dcLinhasResumido.map(l => ({
      'Código':             l.codigo ?? '',
      'Nome':               l.empresa || '',
      'CNPJ':               l.cnpj || '',
      'Renovação':          l.renovacao ? 'Sim' : 'Não',
      'Prazo Final Adesão': l.prazo_final_adesao || '',
      'Nº Contrato':        l.contrato_numero || '',
      'Data de Início':     fmtBrData(l.contrato_data_inicio),
      'Vencido em':         fmtBrData(l.contrato_vencido_em),
      'Tarifa de Uso':      l.tarifa_uso != null ? Number(l.tarifa_uso.toFixed(2)) : '',
      'Valor do Ponto':     l.valor_ponto != null ? Number(l.valor_ponto.toFixed(2)) : '',
      'Outorga (30%)':      l.outorga != null ? Number(l.outorga.toFixed(2)) : '',
    }));
    const ws = XLSX.utils.json_to_sheet(dados);
    aplicarFormatoMoeda(ws, [8, 9, 10], dados.length); // Tarifa de Uso, Valor do Ponto, Outorga
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Resumido');
    XLSX.writeFile(wb, `concessionarios-resumido-${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) {
    toast('Erro ao exportar: ' + e.message, 'error');
  }
}

async function dcAplicarAcessoImportacao() {
  const card = document.getElementById('dc-card-importar');
  if (!card) return;
  try {
    const user = await window.getCurrentUser();
    if (user && (user.username === 'master' || user.role === 'admin_sistema')) card.style.display = '';
  } catch {}
}

(async function initDc() {
  await dcAplicarAcessoImportacao();
  await dcCarregarImportacoes();
})();
