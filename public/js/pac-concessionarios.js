// PAC/DEPLA — Dados Concessionários: importação do export de tarifas do
// CORPORE (CSV, ver routes/pac-concessionarios.js pro detalhe do formato) +
// relatório resumido (pac-concessionarios.html), cruzado com depop.db. Ver
// routes/pac-concessionarios.js pra lógica de casamento (match_confianca) e
// pros campos calculados (camposDepop/carregarDadosDepop).
// Por padrão o relatório só mostra concessionários CASADOS com um contrato
// de 20 anos no depop — o checkbox "Mostrar Demais" inclui o resto (fora do
// programa de renovação, só existem no export do CORPORE).

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

// Ordem real das 17 colunas do CSV do CORPORE (sem cabeçalho) — achado
// analisando o arquivo real em `data/Depla_2.csv`, cross-validado com
// códigos conhecidos do depop.db (2026-11-11). Ver cabeçalho de
// routes/pac-concessionarios.js pro detalhe completo. Os campos com nome
// começando em "_" são bookkeeping contábil que o relatório não usa.
const DC_CAMPOS_CSV = [
  'Codigo_Cfo', 'Empresa', 'CNPJ', 'Cidade', '_Id_Cidade', 'Contrato_Numero', 'Ccu_Licenca',
  'Data_Inicio', 'Data_Vencimento', 'Tarifa_Uso', '_Codigo2', '_InternoId', '_Seq', '_Descricao',
  '_Conta', '_Ordem', '_Localizacao',
];

// Parser de linha CSV respeitando aspas RFC4180 (campo com vírgula, ex: nome
// de empresa, vem entre aspas — "", dentro de aspas, é aspas literal). Não
// trata quebra de linha dentro de campo (não ocorre neste export real).
function dcParseLinhaCsv(linha) {
  const campos = [];
  let atual = '';
  let dentroAspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (dentroAspas) {
      if (c === '"') {
        if (linha[i + 1] === '"') { atual += '"'; i++; } else { dentroAspas = false; }
      } else {
        atual += c;
      }
    } else if (c === '"') {
      dentroAspas = true;
    } else if (c === ',') {
      campos.push(atual); atual = '';
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos;
}

async function dcArquivoEscolhido(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  _dcNomeArquivo = file.name;
  document.getElementById('dc-nome-arquivo').textContent = `Processando "${file.name}"...`;

  try {
    // file.text() decodifica como UTF-8 por padrão — o export real do
    // CORPORE é UTF-8 sem BOM (confirmado), por isso não passa pelo XLSX
    // (que não dá pra garantir a codificação certa num ArrayBuffer sem BOM).
    const texto = await file.text();
    const linhasBrutas = texto.split(/\r?\n/).filter(l => l.trim() !== '');
    _dcLinhasPlanilha = linhasBrutas.map(linha => {
      const campos = dcParseLinhaCsv(linha);
      const obj = {};
      DC_CAMPOS_CSV.forEach((nome, i) => { obj[nome] = campos[i] !== undefined ? campos[i].trim() : ''; });
      return obj;
    });
    document.getElementById('dc-nome-arquivo').textContent =
      `"${file.name}" — ${_dcLinhasPlanilha.length} linha(s). Simulando...`;
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
// Depop bate com o que apresentamos aqui" (Alex, 2026-11-05). Desde
// 2026-11-11 o servidor sintetiza (contratosFaltandoSintetizados) qualquer
// contrato de renovação que a planilha não trouxe, então "não bate" nunca
// mais deveria acontecer de verdade — pedido do Alex: tirar a mensagem de
// alerta (só mantém a confirmação positiva, quando aparece).
function dcAtualizarValidador(v) {
  const el = document.getElementById('dc-validador');
  if (!el || !v) return;
  if (!v.bate) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.className = 'dc-banner dc-banner-ok';
  el.innerHTML = `✓ Validado: os ${v.contratos_depop} contratos de renovação de 20 anos do Depop batem com os ${v.contratos_apresentados} apresentados aqui (${v.empresas_apresentadas} empresas).`;
}

// Ícones de linha (24x24, mesmo estilo dos ícones da sidebar — stroke,
// sem preenchimento) usados nos cards de resumo.
const DC_ICONE = {
  predio:   '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="2" width="16" height="20" rx="1"/><path d="M9 22v-4h6v4M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1"/></svg>',
  selo:     '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 5-5"/></svg>',
  etiqueta: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41 11 3.8A2 2 0 0 0 9.59 3.2L3.2 3.2a1 1 0 0 0-1 1l.02 6.4a2 2 0 0 0 .59 1.4l9.6 9.6a2 2 0 0 0 2.82 0l5.37-5.37a2 2 0 0 0 0-2.82z"/><circle cx="7.5" cy="7.5" r="1.3" fill="currentColor" stroke="none"/></svg>',
  mapa:     '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s7-6.3 7-11.5A7 7 0 0 0 5 9.5C5 14.7 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.3"/></svg>',
};

// Pedido do Alex, 2026-11-11: qts de concessionários, qtd renovação e valor
// de tarifa resumido por entreposto (cidade) — sempre o retrato completo,
// independente do checkbox "Mostrar Demais" (que só filtra a tabela). Cada
// card tem uma cor própria (acento à esquerda + ícone) em vez de um bloco
// neutro igual pros 4 — a cor segue o mesmo significado já usado nos badges
// da tela (verde = renovação, âmbar = categoria "Demais").
//
// Entreposto: cada cidade é uma sanfona (<details>, mesmo padrão já usado
// no menu lateral) — fechada mostra a tarifa no valor normal (o mais comum
// na cidade, sem somatório nenhum — "eu não quero este somatório de
// tarifa, quero a tarifa no valor normal", Alex 2026-11-11) + a barra;
// aberta mostra a quebra por valor de Tarifa de Uso distinto (quando várias
// empresas têm o MESMO valor, ele aparece 1 vez representando o grupo, com
// a contagem).
function dcRenderCards(cards) {
  const el = document.getElementById('dc-cards');
  if (!el || !cards) return;
  const maxEntreposto = Math.max(1, ...cards.tarifa_por_entreposto.map(e => e.valor_principal));
  const linhasEntreposto = cards.tarifa_por_entreposto.map(e => `
    <details class="dc-entreposto-cidade">
      <summary class="dc-entreposto-linha">
        <svg class="dc-entreposto-seta" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        <span>${e.cidade}</span>
        <div class="dc-entreposto-barra-trilha"><div class="dc-entreposto-barra" style="width:${Math.max(4, e.valor_principal / maxEntreposto * 100)}%"></div></div>
        <span>${fmtMoeda(e.valor_principal)}${e.valores.length > 1 ? ` <span class="dc-entreposto-mais">+${e.valores.length - 1}</span>` : ''}</span>
      </summary>
      <div class="dc-entreposto-valores">
        ${e.valores.map(v => `<div class="dc-entreposto-valor-linha"><span>${fmtMoeda(v.valor)}</span><span>${v.qtd} concessionário${v.qtd > 1 ? 's' : ''}</span></div>`).join('')}
      </div>
    </details>
  `).join('') || '<div class="dc-entreposto-linha"><span>—</span></div>';

  const card = (cor, icone, label, valor) => `
    <div class="dc-card-metric" style="--dc-cor:${cor}">
      <div class="dc-card-metric-icone">${icone}</div>
      <div><div class="dc-card-metric-label">${label}</div><div class="dc-card-metric-valor">${valor}</div></div>
    </div>
  `;
  el.innerHTML =
    card('#1565C0', DC_ICONE.predio, 'Concessionários', cards.total_concessionarios) +
    card('#16a34a', DC_ICONE.selo, 'Com Renovação', cards.total_renovacao) +
    card('#d97706', DC_ICONE.etiqueta, 'Demais (sem renovação)', cards.total_demais) +
    `<div class="dc-card-metric dc-card-entreposto" style="--dc-cor:#F9A800">
      <div class="dc-card-metric-icone">${DC_ICONE.mapa}</div>
      <div class="dc-entreposto-lista"><div class="dc-card-metric-label">Tarifa de Uso por Entreposto</div>${linhasEntreposto}</div>
    </div>`;
}

let _dcLinhasResumido = [];

async function dcCarregarResumido() {
  const params = dcParamsAtuais();
  if (!params) { document.getElementById('dc-tbody').innerHTML = '<tr><td colspan="12">Nenhuma importação ainda.</td></tr>'; return; }
  try {
    const res = await fetch(`/api/pac/concessionarios/resumido?${params}`);
    const r = await res.json();
    _dcLinhasResumido = r.linhas || [];
    dcAtualizarNotaDemais(r.total_demais);
    dcAtualizarValidador(r.validador);
    dcRenderCards(r.cards);
    const tbody = document.getElementById('dc-tbody');
    if (!_dcLinhasResumido.length) {
      tbody.innerHTML = '<tr><td colspan="12">Nenhum contrato nesta importação.</td></tr>';
      return;
    }
    tbody.innerHTML = _dcLinhasResumido.map(l => `
      <tr>
        <td>${l.codigo ?? '—'}</td>
        <td>${l.empresa || '—'}${dcIconeCasamento(l.renovacao, l.match_confianca)}</td>
        <td>${l.cnpj || '—'}</td>
        <td>${l.cidade || '—'}</td>
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
      'Entreposto':         l.cidade || '',
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
    aplicarFormatoMoeda(ws, [9, 10, 11], dados.length); // Tarifa de Uso, Valor do Ponto, Outorga
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
