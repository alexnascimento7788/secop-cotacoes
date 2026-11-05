// PAC/DEPLA — Dados Concessionários: importação da planilha de tarifas do
// CORPORE (aba "Result 1") + relatórios resumido (pac-concessionarios.html)
// e detalhado (pac-concessionarios-detalhado.html), ambos cruzados com
// depop.db. Arquivo compartilhado pelas 2 páginas — cada função que só faz
// sentido numa delas checa se o elemento existe antes de mexer nele.
// Ver routes/pac-concessionarios.js pra lógica de casamento (match_confianca)
// e pros campos calculados (camposDepop/carregarDadosDepop).
// Por padrão os 2 relatórios só mostram concessionários CASADOS com um
// contrato de 20 anos no depop — o checkbox "Mostrar Demais" inclui o resto
// (fora do programa de renovação, só existem na planilha do CORPORE).

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
function fmtNum(v, casas) {
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas || 2, maximumFractionDigits: casas || 2 });
}
function fmtBrData(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

const DC_BADGE = {
  direto:    '<span class="dc-badge dc-badge-direto">Direto</span>',
  data:      '<span class="dc-badge dc-badge-data">Por data</span>',
  manual:    '<span class="dc-badge dc-badge-manual">Revisar</span>',
  sem_match: '<span class="dc-badge dc-badge-semmatch">Sem contrato</span>',
};

function dcBadgeRenovacao(renovacao) {
  return renovacao
    ? '<span class="dc-badge dc-badge-renovacao-sim">Sim</span>'
    : '<span class="dc-badge dc-badge-renovacao-nao">Não</span>';
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

// Dispara o relatório que existir nesta página (resumido OU detalhado —
// cada página só tem 1 dos 2 tbodies no DOM).
async function dcTrocarImportacao() {
  const tarefas = [];
  if (document.getElementById('dc-tbody')) tarefas.push(dcCarregarResumido());
  if (document.getElementById('dc-det-tbody')) tarefas.push(dcCarregarDetalhado());
  await Promise.all(tarefas);
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

let _dcLinhasResumido = [];

async function dcCarregarResumido() {
  const params = dcParamsAtuais();
  if (!params) { document.getElementById('dc-tbody').innerHTML = '<tr><td colspan="14">Nenhuma importação ainda.</td></tr>'; return; }
  try {
    const res = await fetch(`/api/pac/concessionarios/resumido?${params}`);
    const r = await res.json();
    _dcLinhasResumido = r.linhas || [];
    dcAtualizarNotaDemais(r.total_demais);
    dcAtualizarValidador(r.validador);
    const tbody = document.getElementById('dc-tbody');
    if (!_dcLinhasResumido.length) {
      tbody.innerHTML = '<tr><td colspan="14">Nenhum contrato nesta importação.</td></tr>';
      return;
    }
    tbody.innerHTML = _dcLinhasResumido.map(l => `
      <tr>
        <td>${l.codigo ?? '—'}</td>
        <td>${l.empresa || '—'}</td>
        <td>${l.cnpj || '—'}</td>
        <td>${dcBadgeRenovacao(l.renovacao)}</td>
        <td>${l.prazo_final_adesao || '—'}</td>
        <td>${l.contrato_numero || '—'}</td>
        <td>${fmtBrData(l.contrato_data_inicio)}</td>
        <td>${fmtBrData(l.contrato_vencido_em)}</td>
        <td class="dc-num">${l.area_m2 != null ? fmtNum(l.area_m2, 2) : '—'}</td>
        <td class="dc-num">${fmtMoeda(l.valor_m2)}</td>
        <td class="dc-num">${fmtMoeda(l.tarifa_uso)}</td>
        <td class="dc-num">${fmtMoeda(l.valor_ponto)}</td>
        <td class="dc-num">${fmtMoeda(l.outorga)}</td>
        <td>${DC_BADGE[l.match_confianca] || l.match_confianca}</td>
      </tr>
    `).join('');
  } catch (e) {
    toast('Erro ao carregar relatório resumido: ' + e.message, 'error');
  }
}

// Pedido do Alex, 2026-11-05: o detalhado é "uma cópia da planilha que
// importou agregando os dados que eu já tinha passado antes" — 1 coluna por
// tipo de tarifa (igual ao CORPORE), não uma árvore de expandir/colapsar.
let _dcLinhasDetalhado = [];
let _dcColunasTarifa = [];

async function dcCarregarDetalhado() {
  const params = dcParamsAtuais();
  if (!params) { document.getElementById('dc-det-tbody').innerHTML = '<tr><td colspan="14">Nenhuma importação ainda.</td></tr>'; return; }
  try {
    const res = await fetch(`/api/pac/concessionarios/detalhado?${params}`);
    const r = await res.json();
    _dcLinhasDetalhado = r.linhas || [];
    _dcColunasTarifa = r.colunas_tarifa || [];
    dcAtualizarNotaDemais(r.total_demais);
    dcAtualizarValidador(r.validador);

    const thead = document.getElementById('dc-det-thead-row');
    thead.innerHTML = `
      <th>Código</th><th>Nome</th><th>CNPJ</th><th>Renovação</th><th>Prazo Final Adesão</th>
      <th>Nº Contrato</th><th>Data de Início</th><th>Vencido em</th>
      <th class="dc-num">Área (m²)</th><th class="dc-num">Valor por m²</th><th class="dc-num">Tarifa de Uso</th>
      <th class="dc-num">Valor do Ponto</th><th class="dc-num">Outorga (30%)</th><th>Casamento</th>
      ${_dcColunasTarifa.map(c => `<th class="dc-num dc-col-tarifa">${c}</th>`).join('')}
    `;

    const tbody = document.getElementById('dc-det-tbody');
    if (!_dcLinhasDetalhado.length) {
      tbody.innerHTML = `<tr><td colspan="${14 + _dcColunasTarifa.length}">Nenhum contrato nesta importação.</td></tr>`;
      return;
    }
    tbody.innerHTML = _dcLinhasDetalhado.map(l => `
      <tr>
        <td>${l.codigo ?? '—'}</td>
        <td>${l.empresa || '—'}</td>
        <td>${l.cnpj || '—'}</td>
        <td>${dcBadgeRenovacao(l.renovacao)}</td>
        <td>${l.prazo_final_adesao || '—'}</td>
        <td>${l.contrato_numero || '—'}</td>
        <td>${fmtBrData(l.contrato_data_inicio)}</td>
        <td>${fmtBrData(l.contrato_vencido_em)}</td>
        <td class="dc-num">${l.area_m2 != null ? fmtNum(l.area_m2, 2) : '—'}</td>
        <td class="dc-num">${fmtMoeda(l.valor_m2)}</td>
        <td class="dc-num">${fmtMoeda(l.tarifa_uso)}</td>
        <td class="dc-num">${fmtMoeda(l.valor_ponto)}</td>
        <td class="dc-num">${fmtMoeda(l.outorga)}</td>
        <td>${DC_BADGE[l.match_confianca] || l.match_confianca}</td>
        ${_dcColunasTarifa.map(c => `<td class="dc-num dc-col-tarifa">${l.itens[c] != null ? fmtMoeda(l.itens[c]) : '—'}</td>`).join('')}
      </tr>
    `).join('');
  } catch (e) {
    toast('Erro ao carregar relatório detalhado: ' + e.message, 'error');
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
      'Área (m²)':          l.area_m2 != null ? Number(l.area_m2.toFixed(2)) : '',
      'Valor por m²':       l.valor_m2 != null ? Number(l.valor_m2.toFixed(2)) : '',
      'Tarifa de Uso':      l.tarifa_uso != null ? Number(l.tarifa_uso.toFixed(2)) : '',
      'Valor do Ponto':     l.valor_ponto != null ? Number(l.valor_ponto.toFixed(2)) : '',
      'Outorga (30%)':      l.outorga != null ? Number(l.outorga.toFixed(2)) : '',
    }));
    const ws = XLSX.utils.json_to_sheet(dados);
    aplicarFormatoMoeda(ws, [9, 10, 11, 12], dados.length); // Valor por m², Tarifa de Uso, Valor do Ponto, Outorga
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Resumido');
    XLSX.writeFile(wb, `concessionarios-resumido-${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) {
    toast('Erro ao exportar: ' + e.message, 'error');
  }
}

// Mesmo formato largo da tela — 1 coluna por tipo de tarifa, igual à
// planilha original do CORPORE, com as colunas calculadas do depop juntas.
async function dcExportarExcelDetalhado() {
  if (!_dcLinhasDetalhado.length) { toast('Nada para exportar', 'error'); return; }
  try {
    const XLSX = await carregarXLSX();
    const COLS_FIXAS = 13;
    const dados = _dcLinhasDetalhado.map(l => {
      const linha = {
        'Código':             l.codigo ?? '',
        'Nome':               l.empresa || '',
        'CNPJ':               l.cnpj || '',
        'Renovação':          l.renovacao ? 'Sim' : 'Não',
        'Prazo Final Adesão': l.prazo_final_adesao || '',
        'Nº Contrato':        l.contrato_numero || '',
        'Data de Início':     fmtBrData(l.contrato_data_inicio),
        'Vencido em':         fmtBrData(l.contrato_vencido_em),
        'Área (m²)':          l.area_m2 != null ? Number(l.area_m2.toFixed(2)) : '',
        'Valor por m²':       l.valor_m2 != null ? Number(l.valor_m2.toFixed(2)) : '',
        'Tarifa de Uso':      l.tarifa_uso != null ? Number(l.tarifa_uso.toFixed(2)) : '',
        'Valor do Ponto':     l.valor_ponto != null ? Number(l.valor_ponto.toFixed(2)) : '',
        'Outorga (30%)':      l.outorga != null ? Number(l.outorga.toFixed(2)) : '',
      };
      _dcColunasTarifa.forEach(c => { linha[c] = l.itens[c] != null ? Number(l.itens[c].toFixed(2)) : ''; });
      return linha;
    });
    const ws = XLSX.utils.json_to_sheet(dados);
    const colunasMoeda = [9, 10, 11, 12].concat(_dcColunasTarifa.map((_, i) => COLS_FIXAS + i));
    aplicarFormatoMoeda(ws, colunasMoeda, dados.length);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Detalhado');
    XLSX.writeFile(wb, `concessionarios-detalhado-${new Date().toISOString().slice(0, 10)}.xlsx`);
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
