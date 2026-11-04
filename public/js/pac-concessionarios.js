// PAC/DEPLA — Dados Concessionários: importação da planilha de tarifas do
// CORPORE (aba "Result 1") + relatório resumido cruzado com depop.db.
// Ver routes/pac-concessionarios.js pra lógica de casamento (match_confianca).

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
      await dcCarregarResumido();
    }
  } catch (e) {
    toast('Erro ao carregar importações: ' + e.message, 'error');
  }
}

let _dcLinhasResumido = [];

async function dcCarregarResumido() {
  const sel = document.getElementById('dc-select-importacao');
  if (!sel.value) { document.getElementById('dc-tbody').innerHTML = '<tr><td colspan="13">Nenhuma importação ainda.</td></tr>'; return; }
  try {
    const res = await fetch(`/api/pac/concessionarios/resumido?importacao_id=${sel.value}`);
    const r = await res.json();
    _dcLinhasResumido = r.linhas || [];
    const tbody = document.getElementById('dc-tbody');
    if (!_dcLinhasResumido.length) {
      tbody.innerHTML = '<tr><td colspan="13">Nenhum contrato nesta importação.</td></tr>';
      return;
    }
    tbody.innerHTML = _dcLinhasResumido.map(l => `
      <tr>
        <td>${l.codigo ?? '—'}</td>
        <td>${l.empresa || '—'}</td>
        <td>${l.cnpj || '—'}</td>
        <td>${l.contrato_numero || '—'}</td>
        <td>${fmtBrData(l.contrato_data_inicio)}</td>
        <td>${fmtBrData(l.contrato_vencido_em)}</td>
        <td>${l.prazo_final_adesao || '—'}</td>
        <td class="dc-num">${l.area_m2 != null ? fmtNum(l.area_m2, 2) : '—'}</td>
        <td class="dc-num">${fmtMoeda(l.valor_m2)}</td>
        <td class="dc-num">${fmtMoeda(l.tarifa_uso)}</td>
        <td class="dc-num">${fmtMoeda(l.valor_ponto)}</td>
        <td class="dc-num">${fmtMoeda(l.outorga)}</td>
        <td>${DC_BADGE[l.match_confianca] || l.match_confianca}</td>
      </tr>
    `).join('');
  } catch (e) {
    toast('Erro ao carregar relatório: ' + e.message, 'error');
  }
}

async function dcExportarExcel() {
  if (!_dcLinhasResumido.length) { toast('Nada para exportar', 'error'); return; }
  try {
    const XLSX = await carregarXLSX();
    const dados = _dcLinhasResumido.map(l => ({
      'Código':            l.codigo ?? '',
      'Nome':              l.empresa || '',
      'CNPJ':              l.cnpj || '',
      'Nº Contrato':       l.contrato_numero || '',
      'Data de Início':    fmtBrData(l.contrato_data_inicio),
      'Vencido em':         fmtBrData(l.contrato_vencido_em),
      'Prazo Final Adesão': l.prazo_final_adesao || '',
      'Área (m²)':         l.area_m2 != null ? Number(l.area_m2.toFixed(2)) : '',
      'Valor por m²':      l.valor_m2 != null ? Number(l.valor_m2.toFixed(2)) : '',
      'Tarifa de Uso':     l.tarifa_uso != null ? Number(l.tarifa_uso.toFixed(2)) : '',
      'Valor do Ponto':    l.valor_ponto != null ? Number(l.valor_ponto.toFixed(2)) : '',
      'Outorga (30%)':     l.outorga != null ? Number(l.outorga.toFixed(2)) : '',
    }));
    const ws = XLSX.utils.json_to_sheet(dados);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Resumido');
    XLSX.writeFile(wb, `concessionarios-resumido-${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) {
    toast('Erro ao exportar: ' + e.message, 'error');
  }
}

async function dcAplicarAcessoImportacao() {
  try {
    const user = await window.getCurrentUser();
    if (user && (user.username === 'master' || user.role === 'admin_sistema')) {
      document.getElementById('dc-card-importar').style.display = '';
    }
  } catch {}
}

(async function initDc() {
  await dcAplicarAcessoImportacao();
  await dcCarregarImportacoes();
})();
