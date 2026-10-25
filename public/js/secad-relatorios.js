// ── SECAD/Relatórios: adesão à renovação (front) ─────────────────────────────
// Importação (admin-only) + indicadores por prazo × cidade. Parse do Excel
// acontece aqui, no navegador, via SheetJS — mesmo padrão de
// public/js/pac-importacao.js — o servidor só recebe linhas já em JSON.

let _relArquivo = null;
let _relIniciado = false;
let _relDados = null; // último payload de /adesao — alimenta as 4 abas sem refazer fetch

async function _relCarregarXLSX() {
  if (window.XLSX) return window.XLSX;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('Falha ao carregar a biblioteca de planilhas'));
    document.head.appendChild(s);
  });
}

function _relNormalizarHeader(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

// Mapeia cabeçalho da planilha → campo do sistema, de forma tolerante (não
// exige o texto exato) — pra aguentar pequenas variações entre exportações
// que o Alex gerar da query dele ao longo do tempo.
function _relMapearColuna(headerBruto) {
  const h = _relNormalizarHeader(headerBruto);
  if (h.includes('codigo')) return 'codigo';
  if (h.includes('cnpj')) return 'cnpj';
  if (h.includes('contrato') || h.includes('ccu')) return 'numero_ccu';
  if (h.includes('aceite') || h.includes('data')) return 'data_aceite';
  return null;
}

function relArquivoSelecionado(file) {
  if (!file) return;
  _relArquivo = file;
  document.getElementById('rel-dropzone-texto').textContent = `${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
  document.getElementById('rel-btn-simular').disabled = false;
  document.getElementById('rel-btn-confirmar').style.display = 'none';
  document.getElementById('rel-import-preview').style.display = 'none';
}

async function _relLerLinhas() {
  const XLSX = await _relCarregarXLSX();
  const data = await _relArquivo.arrayBuffer();
  const wb = XLSX.read(data, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (!rows.length) throw new Error('Arquivo vazio.');
  const cabecalho = rows[0].map(_relMapearColuna);
  const faltando = ['codigo', 'numero_ccu'].filter(campo => !cabecalho.includes(campo));
  if (faltando.length) throw new Error(`Não encontrei a(s) coluna(s): ${faltando.join(', ')}. Confira os cabeçalhos da planilha.`);
  return rows.slice(1).filter(r => r.some(v => String(v).trim() !== '')).map(r => {
    const linha = {};
    cabecalho.forEach((campo, i) => { if (campo) linha[campo] = r[i]; });
    return linha;
  });
}

async function relImportar(dryRun) {
  const msg = document.getElementById('rel-import-msg');
  msg.style.color = ''; msg.textContent = '';
  if (!_relArquivo) { msg.style.color = 'var(--vermelho)'; msg.textContent = 'Selecione um arquivo.'; return; }
  try {
    const linhas = await _relLerLinhas();
    const res = await fetch('/api/secad/relatorios/importar-aceites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: !!dryRun, nome_arquivo: _relArquivo.name, linhas }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Erro ao importar.');
    if (dryRun) {
      _relMostrarSimulacao(r);
      document.getElementById('rel-btn-confirmar').style.display = '';
    } else {
      msg.style.color = 'var(--verde)';
      msg.textContent = `Importado! Lote #${r.importacao_id} — ${r.total_linhas} linha(s), ${r.nao_casados} sem contrato correspondente.`;
      document.getElementById('rel-btn-confirmar').style.display = 'none';
      document.getElementById('rel-btn-simular').disabled = true;
      document.getElementById('rel-import-preview').style.display = 'none';
      _relArquivo = null;
      document.getElementById('rel-file-input').value = '';
      document.getElementById('rel-dropzone-texto').textContent = 'Clique ou arraste o arquivo aqui (.xlsx)';
      await _relCarregarImportacoes(r.importacao_id);
      await carregarRelatorioAdesao();
    }
  } catch (e) {
    msg.style.color = 'var(--vermelho)';
    msg.textContent = e.message;
  }
}

function _relMostrarSimulacao(r) {
  const el = document.getElementById('rel-import-preview');
  el.style.display = '';
  const linhasNaoCasadas = r.nao_casados_amostra.map(n => `<div class="imp-log-linha imp-log-alerta">Código ${n.codigo} / CCU ${n.numero_ccu} — nenhum contrato correspondente em Avaliação</div>`).join('');
  const linhasInvalidas = r.invalidas_amostra.map(n => `<div class="imp-log-linha imp-log-erro">Linha ${n.linha}: ${n.motivo}</div>`).join('');
  el.innerHTML = `
    <div class="imp-contadores">
      <div class="imp-contador" style="color:var(--text);">${r.total_linhas} linha(s) na planilha</div>
      <div class="imp-contador" style="color:var(--verde);">${r.casados} casam com um contrato</div>
      <div class="imp-contador" style="color:var(--amarelo);">${r.nao_casados} sem contrato correspondente</div>
      ${r.invalidas ? `<div class="imp-contador" style="color:var(--vermelho);">${r.invalidas} inválida(s)</div>` : ''}
    </div>
    ${linhasInvalidas}
    ${linhasNaoCasadas}
    ${r.nao_casados > r.nao_casados_amostra.length ? `<div class="text-muted" style="font-size:12px;margin-top:6px;">… e mais ${r.nao_casados - r.nao_casados_amostra.length} sem contrato correspondente.</div>` : ''}
    <p class="text-muted" style="font-size:12px;margin-top:10px;">
      Todas as ${r.validas} linha(s) válida(s) serão importadas (mesmo as sem contrato correspondente — elas só não entram nos indicadores por prazo/cidade).
    </p>
  `;
}

// ── Sub-navegação do submódulo (Relatórios × Histórico × Verificar × Importar) ──

const REL_SUBVIEWS = ['painel', 'historico', 'verificar', 'importar'];

function relTrocarSubview(nome) {
  REL_SUBVIEWS.forEach(v => { document.getElementById(`rel-sub-${v}`).style.display = v === nome ? '' : 'none'; });
  document.querySelectorAll('#rel-tabs .page-tab').forEach(t => t.classList.toggle('active', t.dataset.reltab === nome));
}

// ── Relatório ────────────────────────────────────────────────────────────────

async function initRelatorios() {
  if (_relIniciado) { carregarRelatorioAdesao(); return; }
  _relIniciado = true;
  document.getElementById('rel-filtro-importacao').addEventListener('change', carregarRelatorioAdesao);
  // Filtro de data da tabela unificada é só local (não refaz fetch) — filtra
  // em memória a partir de _relDados, que já tem TODOS os grupos.
  document.getElementById('rel-filtro-data-tabela').addEventListener('change', () => {
    if (_relDados) document.getElementById('rel-tabela-unificada').innerHTML = _relRenderTabelaUnificada(_relDados);
  });
  await _relCarregarImportacoes();
  await carregarRelatorioAdesao();
}

async function _relCarregarImportacoes(selecionarId) {
  const sel = document.getElementById('rel-filtro-importacao');
  try {
    const res = await fetch('/api/secad/relatorios/importacoes');
    const lotes = res.ok ? await res.json() : [];
    sel.innerHTML = lotes.map((l, i) => `<option value="${l.id}">${i === 0 ? '🟢 Atual' : 'Lote anterior'} — ${l.id} · ${_relFmtDataHora(l.criado_em)} · ${l.total_linhas} linha(s)${l.nao_casados ? ` · ${l.nao_casados} sem contrato` : ''}</option>`).join('');
    if (selecionarId) sel.value = String(selecionarId);
  } catch {
    sel.innerHTML = '';
  }
}

// Sem prazo/cidade — a tela não filtra mais no servidor, busca TUDO de uma
// vez (grupos operacionais + "Fora do prazo previsto") e cada aba renderiza
// a partir do mesmo payload (ver _relDados).
function _relParamsAtuais() {
  const p = new URLSearchParams();
  const imp = document.getElementById('rel-filtro-importacao').value;
  if (imp) p.set('importacao_id', imp);
  return p;
}

function _relFmtDataHora(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return String(iso);
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function carregarRelatorioAdesao() {
  const info = document.getElementById('rel-base-info');
  const destaques = document.getElementById('rel-destaques');
  const foraPrazo = document.getElementById('rel-fora-prazo');
  const tabela = document.getElementById('rel-tabela-unificada');
  const dashCard = document.getElementById('rel-dash-card');
  const vazio = msg => `<div class="card"><div style="padding:40px;text-align:center;color:var(--text-muted);">${msg}</div></div>`;
  _relDados = null;
  try {
    const res = await fetch(`/api/secad/relatorios/adesao?${_relParamsAtuais().toString()}`);
    if (res.status === 404) {
      info.textContent = '';
      destaques.innerHTML = '';
      foraPrazo.innerHTML = '';
      dashCard.style.display = 'none';
      tabela.innerHTML = vazio('Nenhuma importação feita ainda.');
      return;
    }
    const dados = await res.json();
    _relDados = dados;
    info.innerHTML = _relRenderReconciliacao(dados);
    destaques.innerHTML = _relRenderDestaques(dados);
    const grupoForaPrazo = dados.grupos.find(g => g.prazo === 'Fora do prazo previsto');
    foraPrazo.innerHTML = grupoForaPrazo ? _relRenderGrupo(grupoForaPrazo) : '';
    if (!_relGruposOp(dados).length) {
      dashCard.style.display = 'none';
      tabela.innerHTML = vazio('Nenhum contrato no intervalo de prazo previsto (2027–2032) com os filtros atuais.');
      return;
    }
    dashCard.style.display = '';
    _relRenderDashboard(dados);
    tabela.innerHTML = _relRenderTabelaUnificada(dados);
  } catch {
    info.textContent = '';
    destaques.innerHTML = '';
    foraPrazo.innerHTML = '';
    dashCard.style.display = 'none';
    tabela.innerHTML = `<div class="card"><div style="padding:40px;text-align:center;color:var(--vermelho);">Erro ao carregar o relatório.</div></div>`;
  }
}

// Grupos "operacionais" (30/10 e 18/12) — exclui "Fora do prazo previsto",
// que só aparece na aba de Verificação, nunca nos indicadores normais
// (Panorama/tabela unificada).
function _relGruposOp(dados) {
  return dados.grupos.filter(g => g.prazo !== 'Fora do prazo previsto');
}

// Lista à parte de removidos/teste (destaques) — aparece mesmo se o
// contrato já "aceitou" (não ficaria visível na lista de pendentes).
function _relRenderDestaques(dados) {
  const lista = dados.destaques || [];
  if (!lista.length) return '';
  const linhas = lista.map(d => {
    const badge = d.situacao === 'removido'
      ? `<span class="rel-badge rel-badge-removido" title="${d.motivo || ''}">REMOVIDO</span>`
      : `<span class="rel-badge rel-badge-teste">TESTE</span>`;
    const status = d.aceitou
      ? `<span style="color:var(--verde);font-weight:600;">Aceito</span>`
      : `<span style="color:var(--vermelho);font-weight:600;">Pendente</span>`;
    return `<tr><td>${badge}</td><td>${d.codigo}</td><td>${d.concessionario}</td><td>${d.cidade}</td><td>${d.prazo}</td><td>${status}</td></tr>`;
  }).join('');
  return `
    <div class="card">
      <div class="card-header"><span class="card-title">⚠️ Registros destacados (${lista.length})</span></div>
      <div class="table-wrap" style="padding:14px 16px;">
        <table class="rel-grupo-cidades">
          <thead><tr><th></th><th>Código</th><th>Concessionário</th><th>Cidade</th><th>Prazo</th><th>Status</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Painel interativo: velocímetro + pizza + timeline ───────────────────────
// SVG na mão, sem lib — mesma convenção de detin-painel.js (donut) e
// pac-lancamento.js (svgVelocimetro/svgPizzaMulti), duplicado aqui de
// propósito (cada arquivo tem o seu, convenção já estabelecida no projeto).

const PALETA_REL_CIDADE = ['#1A3F6B', '#C0392B', '#2E7D32', '#B46A00', '#6C5CE7', '#00897B', '#8D6E63', '#546E7A'];

// Meio-círculo com 3 zonas fixas (vermelho/âmbar/verde) + ponteiro — cópia
// adaptada de svgVelocimetro em public/js/pac-lancamento.js.
function _relSvgVelocimetro(pct) {
  const p = Math.max(0, Math.min(100, pct));
  const raio = 44, cx = 50, cy = 50, L = Math.PI * raio;
  const zonas = [
    { ini: 0, fim: 50, cor: 'var(--vermelho)' },
    { ini: 50, fim: 80, cor: 'var(--amarelo)' },
    { ini: 80, fim: 100, cor: 'var(--verde)' },
  ];
  const arcoZona = z => {
    const comp = (z.fim - z.ini) / 100 * L, offset = -(z.ini / 100 * L);
    return `<path d="M 6 50 A ${raio} ${raio} 0 0 1 94 50" fill="none" stroke="${z.cor}" stroke-width="10"
      stroke-dasharray="${comp.toFixed(1)} ${L.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></path>`;
  };
  const theta = (180 - (p / 100) * 180) * Math.PI / 180;
  // Ponteiro mais curto que o raio do arco (24, não 34) — sobra uma faixa
  // livre entre a ponta dele e o número grande abaixo, nunca cruzam.
  const x2 = cx + 24 * Math.cos(theta), y2 = cy - 24 * Math.sin(theta);
  return `<svg viewBox="0 0 100 86" width="220" height="189" style="flex-shrink:0;">
    ${zonas.map(arcoZona).join('')}
    <line x1="${cx}" y1="${cy}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--text)" stroke-width="2.5" stroke-linecap="round"></line>
    <circle cx="${cx}" cy="${cy}" r="4" fill="var(--text)"></circle>
    <text x="4" y="62" font-size="7" fill="var(--text-muted)">0%</text>
    <text x="96" y="62" font-size="7" fill="var(--text-muted)" text-anchor="end">100%</text>
    <text x="${cx}" y="81" font-size="22" font-weight="800" text-anchor="middle" fill="var(--text)">${p.toFixed(1)}%</text>
  </svg>`;
}

// Pizza cheia (sem furo) por arco SVG — mesma matemática de svgArcoPizza em
// detin-pdf.js/secad-relatorios-pdf.js, só que gerando o path pro browser.
function _relSvgPizza(itens, valorFn, corFn, raio) {
  const total = itens.reduce((s, it) => s + valorFn(it), 0) || 1;
  const cx = raio, cy = raio;
  let acumulado = 0;
  const fatias = itens.map((it, i) => {
    const frac = valorFn(it) / total;
    const cor = corFn(it, i);
    if (frac <= 0) return '';
    if (frac >= 0.999) { return `<circle cx="${cx}" cy="${cy}" r="${raio}" fill="${cor}"></circle>`; }
    const ang0 = (-90 + 360 * acumulado) * Math.PI / 180;
    const ang1 = (-90 + 360 * (acumulado + frac)) * Math.PI / 180;
    const x0 = cx + raio * Math.cos(ang0), y0 = cy + raio * Math.sin(ang0);
    const x1 = cx + raio * Math.cos(ang1), y1 = cy + raio * Math.sin(ang1);
    const largeArc = frac > 0.5 ? 1 : 0;
    acumulado += frac;
    return `<path d="M ${cx},${cy} L ${x0.toFixed(2)},${y0.toFixed(2)} A ${raio},${raio} 0 ${largeArc} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" fill="${cor}"></path>`;
  }).join('');
  return `<svg viewBox="0 0 ${raio * 2} ${raio * 2}" width="${raio * 2}" height="${raio * 2}" style="flex-shrink:0;">${fatias}</svg>`;
}

// Verde institucional do CeasaMinas, fixo (não a variável --verde) — dentro
// do módulo SECAD, --verde é redefinido pra AZUL (#1565C0, ver style.css),
// que é a cor de destaque do módulo, não a cor real da marca. O pedido do
// Alex foi explícito: "na cor do ceasa minas e não azul" — usa o hex real
// (mesmo das logos/favicon/login/manifest), não dá pra resolver isso com
// uma variável de módulo.
const REL_VERDE_CEASA = '#1A6B35';

// Linha (sem lib) do % acumulado de aceites sobre o total elegível, dia a
// dia, com rótulo da QUANTIDADE do dia em cada ponto (não só o acumulado) —
// mostra se o ritmo de adesão está acelerando ou parado.
function _relSvgTimeline(pontos, totalElegivel) {
  if (!pontos.length || !totalElegivel) {
    return `<div class="text-muted" style="font-size:12px;padding:30px 10px;text-align:center;">Ainda sem datas de aceite suficientes pra desenhar a evolução.</div>`;
  }
  const w = 640, h = 170, padL = 8, padR = 8, padT = 34, padB = 24;
  let acumulado = 0;
  const serie = pontos.map(p => { acumulado += p.quantidade; return { data: p.data, quantidade: p.quantidade, pct: (acumulado / totalElegivel) * 100 }; });
  const n = serie.length;
  // Eixo Y ajustado à faixa real dos dados (não fixo 0–100%) — senão, com
  // adesão ainda baixa, a linha fica espremida lá embaixo e o gráfico parece
  // vazio. Sempre inclui 0% como piso (é de onde a curva parte).
  const maxPct = Math.max(...serie.map(s => s.pct), 1);
  const tetoEixo = Math.min(100, Math.ceil((maxPct * 1.15) / 5) * 5);
  const x = i => padL + (n > 1 ? (i / (n - 1)) * (w - padL - padR) : (w - padL - padR) / 2);
  const y = pct => h - padB - (Math.max(0, Math.min(tetoEixo, pct)) / tetoEixo) * (h - padT - padB);
  const pts = serie.map((s, i) => `${x(i).toFixed(1)},${y(s.pct).toFixed(1)}`).join(' ');
  const areaPath = `M ${x(0).toFixed(1)},${h - padB} L ${pts} L ${x(n - 1).toFixed(1)},${h - padB} Z`;
  const fmtData = iso => { const [, m, d] = String(iso).split('-'); return `${d}/${m}`; };
  // Com muitos pontos, rótulo em TODOS eles vira uma sopa de números — mostra
  // no máximo ~15, espaçados (sempre incluindo o último, o mais recente).
  const passo = Math.max(1, Math.ceil(n / 15));
  const rotulos = serie.map((s, i) => (i % passo === 0 || i === n - 1) ? `
    <circle cx="${x(i).toFixed(1)}" cy="${y(s.pct).toFixed(1)}" r="2.5" fill="${REL_VERDE_CEASA}"></circle>
    <text x="${x(i).toFixed(1)}" y="${(y(s.pct) - 7).toFixed(1)}" font-size="8" text-anchor="middle" fill="var(--text-muted)">${s.quantidade}</text>` : '').join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="xMidYMid meet">
    <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="var(--cinza-b)" stroke-width="1"></line>
    <path d="${areaPath}" fill="${REL_VERDE_CEASA}" opacity="0.12"></path>
    <polyline points="${pts}" fill="none" stroke="${REL_VERDE_CEASA}" stroke-width="2.5"></polyline>
    ${rotulos}
    <text x="${padL}" y="${h - 6}" font-size="9" fill="var(--text-muted)">${fmtData(serie[0].data)}</text>
    <text x="${w - padR}" y="${h - 6}" font-size="9" fill="var(--text-muted)" text-anchor="end">${fmtData(serie[n - 1].data)}</text>
    <text x="${padL}" y="18" font-size="13" font-weight="700" fill="var(--text)">${serie[n - 1].pct.toFixed(1)}% acumulado</text>
    <text x="${padL}" y="30" font-size="9" fill="var(--text-muted)">número(s) pequeno(s) acima de cada ponto = quantidade de aceites naquele dia</text>
  </svg>`;
}

// "Pilha/bateria carregando" — barra horizontal com terminal, preenchimento
// proporcional, faixas de cor PRÓPRIAS desta rodada (diferentes das zonas
// do velocímetro): <75% vermelho, 75–95% âmbar, >95% verde.
function _relFaixaPct(pct) {
  if (pct < 75) return { classe: 'rel-faixa-baixa', cor: 'var(--vermelho)', seta: '▼' };
  if (pct < 95) return { classe: 'rel-faixa-media', cor: 'var(--amarelo)', seta: '▶' };
  return { classe: 'rel-faixa-alta', cor: 'var(--verde)', seta: '▲' };
}

function _relSvgBateria(pct) {
  const p = Math.max(0, Math.min(100, pct));
  const faixa = _relFaixaPct(p);
  const w = 300, h = 34, corpoW = 236, corpoH = 24, x0 = 2, y0 = (h - corpoH) / 2;
  const fillW = Math.max(0, (corpoW - 6) * (p / 100));
  // width="100%" (em vez de fixo em px) — agora divide linha com a Evolução
  // dos aceites num container mais estreito, precisa encolher com ele.
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" style="max-width:${w}px;" preserveAspectRatio="xMidYMid meet">
    <rect x="${x0}" y="${y0}" width="${corpoW}" height="${corpoH}" rx="3" fill="none" stroke="var(--cinza-b)" stroke-width="2"></rect>
    <rect x="${x0 + corpoW + 2}" y="${y0 + corpoH / 2 - 6}" width="6" height="12" rx="2" fill="var(--cinza-b)"></rect>
    <rect x="${x0 + 3}" y="${y0 + 3}" width="${fillW.toFixed(1)}" height="${corpoH - 6}" rx="2" fill="${faixa.cor}"></rect>
    <text x="${x0 + corpoW + 16}" y="${y0 + corpoH / 2 + 4}" font-size="13" font-weight="700" fill="${faixa.cor}">${p.toFixed(1)}%</text>
  </svg>`;
}

// Responde "os números fecham?" de forma auditável — planilha → casados →
// contratos ativos. O Total do painel SEMPRE bate com total_contratos_ativos
// (nada fica de fora da conta — precisa bater com a plataforma de contrato);
// quem não tem prazo previsto vira grupo próprio "Fora do prazo previsto"
// mais abaixo, em vez de sumir. Calculado no backend (reconciliacao), sempre
// sobre o universo total, independente do filtro de prazo/cidade ativo.
function _relRenderReconciliacao(dados) {
  const r = dados.reconciliacao;
  const imp = dados.importacao;
  const base = `Base: importação #${imp.id} — "${imp.nome_arquivo || '—'}", ${_relFmtDataHora(imp.criado_em)}.`;
  const linha1 = `${r.total_linhas_planilha} linha(s) na planilha → ${r.casados_planilha} casaram com um contrato` +
    (r.nao_casados_planilha ? ` (${r.nao_casados_planilha} sem correspondência)` : '') + '.';
  const partesDestaque = [];
  if (r.contratos_removidos) partesDestaque.push(`${r.contratos_removidos} de concessionário(s) removido(s) do sistema`);
  if (r.contratos_teste) partesDestaque.push(`${r.contratos_teste} registro(s) de teste`);
  const linha2 = `Total de contratos: ${r.total_contratos_ativos} — é esse número que deve bater com a plataforma de contrato` +
    (partesDestaque.length ? ` (inclui ${partesDestaque.join(' e ')}, destacados abaixo)` : '') + '.';
  const detalheFora = r.contratos_sem_prazo_previsto ? `
    <details style="margin-top:4px;">
      <summary style="cursor:pointer;">${r.contratos_sem_prazo_previsto} contrato(s) sem prazo previsto definido (vencimento fora de 2027–2032) — ver quais</summary>
      <table class="rel-grupo-cidades" style="margin-top:6px;">
        <thead><tr><th>Código</th><th>Concessionário</th><th>CCU</th><th>Vencimento</th></tr></thead>
        <tbody>${r.contratos_sem_prazo_previsto_detalhe.map(c => `<tr><td>${c.codigo}</td><td>${c.concessionario}</td><td>${c.numero_ccu}</td><td>${c.data_vencimento}</td></tr>`).join('')}</tbody>
      </table>
    </details>` : '';
  return `<div class="text-muted" style="font-size:12px;line-height:1.6;">${base}<br>${linha1}<br>${linha2}${detalheFora}</div>`;
}

function _relSomaGrupo(g) { return { total: g.total.total, aceitaram: g.total.aceitaram }; }

function _relPorCidadePizza(elId, grupos, valorFn, vazioMsg) {
  const mapa = new Map();
  grupos.forEach(g => g.cidades.forEach(c => {
    const v = valorFn(c);
    if (!v) return;
    mapa.set(c.cidade, (mapa.get(c.cidade) || 0) + v);
  }));
  const itens = [...mapa.entries()].sort((a, b) => b[1] - a[1]).map(([cidade, qtd]) => ({ cidade, qtd }));
  const el = document.getElementById(elId);
  if (!itens.length) {
    el.innerHTML = `<div class="text-muted" style="font-size:12px;padding:30px 10px;text-align:center;">${vazioMsg}</div>`;
    return;
  }
  const svg = _relSvgPizza(itens, it => it.qtd, (it, i) => PALETA_REL_CIDADE[i % PALETA_REL_CIDADE.length], 50);
  const legenda = itens.map((it, i) => `
    <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:4px;">
      <span style="width:10px;height:10px;border-radius:2px;background:${PALETA_REL_CIDADE[i % PALETA_REL_CIDADE.length]};display:inline-block;"></span>
      ${it.cidade} — ${it.qtd}
    </div>`).join('');
  el.innerHTML = `<div style="display:flex;gap:16px;align-items:center;justify-content:center;flex-wrap:wrap;">${svg}<div>${legenda}</div></div>`;
}

function _relRenderDashboard(dados) {
  const gruposOp = _relGruposOp(dados);
  const totalGeral = gruposOp.reduce((acc, g) => {
    const s = _relSomaGrupo(g);
    return { total: acc.total + s.total, aceitaram: acc.aceitaram + s.aceitaram };
  }, { total: 0, aceitaram: 0 });
  const pctGeral = totalGeral.total ? (totalGeral.aceitaram / totalGeral.total) * 100 : 0;
  document.getElementById('rel-gauge-geral').innerHTML = _relSvgVelocimetro(pctGeral);

  const g1 = gruposOp.find(g => g.prazo === '30/10/2026');
  const g2 = gruposOp.find(g => g.prazo === '18/12/2026');
  document.getElementById('rel-gauge-1').innerHTML = _relSvgVelocimetro(g1 ? g1.total.pct : 0);
  document.getElementById('rel-gauge-2').innerHTML = _relSvgVelocimetro(g2 ? g2.total.pct : 0);

  _relPorCidadePizza('rel-pizza-efetivado', gruposOp, c => c.aceitaram, 'Ainda sem nenhum aceite.');
  _relPorCidadePizza('rel-pizza-pendente', gruposOp, c => c.pendentes, 'Nenhum pendente — 100% de adesão.');

  document.getElementById('rel-timeline').innerHTML = _relSvgTimeline(dados.evolucao || [], totalGeral.total);
  // Título "% Adesão geral (carga)" já vem do HTML (secad.html) — os 2
  // indicadores ficam na mesma linha, por isso não duplica o título aqui.
  document.getElementById('rel-bateria').innerHTML = _relSvgBateria(pctGeral);
}

// Tabela unificada por cidade (substitui a repetição de _relRenderGrupo por
// prazo): filtro LOCAL (não refaz fetch) — "Total" soma os 2 prazos
// operacionais por cidade, ou mostra só o prazo escolhido. "Fora do prazo
// previsto" nunca entra aqui (fica só na aba de Verificação).
function _relRenderTabelaUnificada(dados) {
  const filtro = document.getElementById('rel-filtro-data-tabela').value;
  const gruposOp = _relGruposOp(dados);
  const gruposAlvo = filtro ? gruposOp.filter(g => g.prazo === filtro) : gruposOp;

  const porCidade = new Map();
  gruposAlvo.forEach(g => g.cidades.forEach(c => {
    const atual = porCidade.get(c.cidade) || { cidade: c.cidade, total: 0, aceitaram: 0, pendentes: 0 };
    atual.total += c.total; atual.aceitaram += c.aceitaram; atual.pendentes += c.pendentes;
    porCidade.set(c.cidade, atual);
  }));
  const cidades = [...porCidade.values()]
    .map(c => ({ ...c, pct: c.total ? (c.aceitaram / c.total) * 100 : 0 }))
    .sort((a, b) => a.cidade.localeCompare(b.cidade, 'pt-BR'));
  const totalGeral = cidades.reduce((acc, c) => ({ total: acc.total + c.total, aceitaram: acc.aceitaram + c.aceitaram }), { total: 0, aceitaram: 0 });
  const total = { total: totalGeral.total, aceitaram: totalGeral.aceitaram, pendentes: totalGeral.total - totalGeral.aceitaram,
                  pct: totalGeral.total ? (totalGeral.aceitaram / totalGeral.total) * 100 : 0 };

  const listaPendentes = gruposAlvo.flatMap(g => g.lista_pendentes)
    .sort((a, b) => a.cidade.localeCompare(b.cidade, 'pt-BR') || String(a.concessionario).localeCompare(String(b.concessionario), 'pt-BR'));

  const badgeSituacao = p => p.situacao === 'removido'
    ? ` <span class="rel-badge rel-badge-removido" title="${p.motivo || ''}">REMOVIDO</span>`
    : (p.situacao === 'teste' ? ` <span class="rel-badge rel-badge-teste">TESTE</span>` : '');
  const linhasCidade = cidades.map(c => {
    const faixa = _relFaixaPct(c.pct);
    return `
    <tr>
      <td>${c.cidade}</td><td>${c.total}</td><td>${c.aceitaram}</td><td>${c.pendentes}</td>
      <td><div class="rel-tabela-cel-barra"><div class="rel-bar-track"><div class="rel-bar-fill ${faixa.classe}" style="width:${c.pct.toFixed(1)}%;"></div></div></div></td>
      <td class="${faixa.classe}"><span class="rel-seta">${faixa.seta}</span>${c.pct.toFixed(1)}%</td>
    </tr>`;
  }).join('');
  const linhasPendentes = _relAgruparPorCidade(listaPendentes).map(bloco => `
    <tr class="rel-subcab"><td colspan="4">${bloco.cidade} (${bloco.itens.length})</td></tr>
    ${bloco.itens.map(p => `<tr><td>${p.codigo}</td><td>${p.concessionario}${badgeSituacao(p)}</td><td>${p.cnpj}</td><td>${p.numero_ccu}</td></tr>`).join('')}
  `).join('');

  return `
    <div class="cards-grid" style="padding:14px 16px 0;">
      <div class="card" style="box-shadow:none;border:1px solid var(--cinza-b);"><div style="padding:14px;"><div class="text-muted" style="font-size:11px;text-transform:uppercase;">Total</div><div style="font-size:22px;font-weight:700;">${total.total}</div></div></div>
      <div class="card" style="box-shadow:none;border:1px solid var(--cinza-b);"><div style="padding:14px;"><div class="text-muted" style="font-size:11px;text-transform:uppercase;">Aceitaram</div><div style="font-size:22px;font-weight:700;color:var(--verde);">${total.aceitaram}</div></div></div>
      <div class="card" style="box-shadow:none;border:1px solid var(--cinza-b);"><div style="padding:14px;"><div class="text-muted" style="font-size:11px;text-transform:uppercase;">Pendentes</div><div style="font-size:22px;font-weight:700;color:var(--vermelho);">${total.pendentes}</div></div></div>
      <div class="card" style="box-shadow:none;border:1px solid var(--cinza-b);"><div style="padding:14px;"><div class="text-muted" style="font-size:11px;text-transform:uppercase;">% Adesão</div><div style="font-size:22px;font-weight:700;" class="${_relFaixaPct(total.pct).classe}">${total.pct.toFixed(1)}%</div></div></div>
    </div>
    <div class="table-wrap" style="padding:14px 16px;">
      <table class="rel-grupo-cidades">
        <thead><tr><th>Cidade</th><th>Total</th><th>Aceitaram</th><th>Pendentes</th><th>Progresso</th><th>% Adesão</th></tr></thead>
        <tbody>${linhasCidade}</tbody>
      </table>
    </div>
    ${listaPendentes.length ? `
    <details style="padding:0 16px 16px;">
      <summary style="cursor:pointer;font-size:13px;color:var(--text-muted);">Ver ${listaPendentes.length} concessionário(s) pendente(s)</summary>
      <div class="table-wrap" style="margin-top:10px;">
        <table class="rel-grupo-cidades">
          <thead><tr><th>Código</th><th>Concessionário</th><th>CNPJ</th><th>CCU</th></tr></thead>
          <tbody>${linhasPendentes}</tbody>
        </table>
      </div>
    </details>` : ''}
  `;
}

// lista_pendentes já vem ordenada cidade→concessionário (montarRelatorioAdesao)
// — só falta agrupar em blocos consecutivos pro sub-cabeçalho visual.
function _relAgruparPorCidade(lista) {
  const blocos = [];
  lista.forEach(p => {
    const cidade = p.cidade || 'Sem cidade definida';
    let bloco = blocos[blocos.length - 1];
    if (!bloco || bloco.cidade !== cidade) { bloco = { cidade, itens: [] }; blocos.push(bloco); }
    bloco.itens.push(p);
  });
  return blocos;
}

function _relRenderGrupo(g) {
  const classePct = pct => pct >= 80 ? 'rel-pct-ok' : (pct < 50 ? 'rel-pct-baixo' : '');
  const linhasCidade = g.cidades.map(c => `
    <tr>
      <td>${c.cidade}</td><td>${c.total}</td><td>${c.aceitaram}</td><td>${c.pendentes}</td>
      <td class="${classePct(c.pct)}">${c.pct.toFixed(1)}%</td>
    </tr>`).join('');
  const badgeSituacao = p => p.situacao === 'removido'
    ? ` <span class="rel-badge rel-badge-removido" title="${p.motivo || ''}">REMOVIDO</span>`
    : (p.situacao === 'teste' ? ` <span class="rel-badge rel-badge-teste">TESTE</span>` : '');
  const linhasPendentes = _relAgruparPorCidade(g.lista_pendentes).map(bloco => `
    <tr class="rel-subcab"><td colspan="4">${bloco.cidade} (${bloco.itens.length})</td></tr>
    ${bloco.itens.map(p => `<tr><td>${p.codigo}</td><td>${p.concessionario}${badgeSituacao(p)}</td><td>${p.cnpj}</td><td>${p.numero_ccu}</td></tr>`).join('')}
  `).join('');
  return `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header"><span class="card-title">${g.prazo === 'Fora do prazo previsto' ? g.prazo : `Prazo final: ${g.prazo}`}</span></div>
      <div class="cards-grid" style="padding:14px 16px 0;">
        <div class="card" style="box-shadow:none;border:1px solid var(--cinza-b);"><div style="padding:14px;"><div class="text-muted" style="font-size:11px;text-transform:uppercase;">Total</div><div style="font-size:22px;font-weight:700;">${g.total.total}</div></div></div>
        <div class="card" style="box-shadow:none;border:1px solid var(--cinza-b);"><div style="padding:14px;"><div class="text-muted" style="font-size:11px;text-transform:uppercase;">Aceitaram</div><div style="font-size:22px;font-weight:700;color:var(--verde);">${g.total.aceitaram}</div></div></div>
        <div class="card" style="box-shadow:none;border:1px solid var(--cinza-b);"><div style="padding:14px;"><div class="text-muted" style="font-size:11px;text-transform:uppercase;">Pendentes</div><div style="font-size:22px;font-weight:700;color:var(--vermelho);">${g.total.pendentes}</div></div></div>
        <div class="card" style="box-shadow:none;border:1px solid var(--cinza-b);"><div style="padding:14px;"><div class="text-muted" style="font-size:11px;text-transform:uppercase;">% Adesão</div><div style="font-size:22px;font-weight:700;" class="${classePct(g.total.pct)}">${g.total.pct.toFixed(1)}%</div></div></div>
      </div>
      <div class="table-wrap" style="padding:14px 16px;">
        <table class="rel-grupo-cidades">
          <thead><tr><th>Cidade</th><th>Total</th><th>Aceitaram</th><th>Pendentes</th><th>% Adesão</th></tr></thead>
          <tbody>${linhasCidade}</tbody>
        </table>
      </div>
      ${g.lista_pendentes.length ? `
      <details style="padding:0 16px 16px;">
        <summary style="cursor:pointer;font-size:13px;color:var(--text-muted);">Ver ${g.lista_pendentes.length} concessionário(s) pendente(s)</summary>
        <div class="table-wrap" style="margin-top:10px;">
          <table class="rel-grupo-cidades">
            <thead><tr><th>Código</th><th>Concessionário</th><th>CNPJ</th><th>CCU</th></tr></thead>
            <tbody>${linhasPendentes}</tbody>
          </table>
        </div>
      </details>` : ''}
    </div>
  `;
}

// Gerar PDF ganhou recorte opcional por cidade (pedido do Alex, "uma ou
// umas") — abre um modal de checkbox (mesmo padrão de seletor multi do
// Concessionários Cadastro) antes de abrir o PDF de fato. Sem nenhuma
// marcada = sem filtro, igual já era o comportamento.
let _relCidadesDisponiveis = [];

async function abrirModalPdfCidades() {
  const lista = document.getElementById('rel-pdf-cidades-lista');
  if (!_relCidadesDisponiveis.length) {
    lista.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Carregando...</div>';
    document.getElementById('rel-modal-pdf-cidades').classList.add('open');
    try {
      const res = await fetch('/api/secad/relatorios/cidades');
      _relCidadesDisponiveis = res.ok ? await res.json() : [];
    } catch { /* mantém vazio, cai no fallback abaixo */ }
  }
  lista.innerHTML = _relCidadesDisponiveis.map(c => `
    <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:400;">
      <input type="checkbox" value="${c.id}" /> ${c.descricao}
    </label>`).join('') || '<div style="color:var(--text-muted);font-size:13px;">Nenhuma cidade disponível.</div>';
  document.getElementById('rel-modal-pdf-cidades').classList.add('open');
}

function confirmarGerarPdfAdesao() {
  const marcados = Array.from(document.querySelectorAll('#rel-pdf-cidades-lista input[type=checkbox]:checked')).map(cb => cb.value);
  const params = _relParamsAtuais();
  if (marcados.length) params.set('cidade_id', marcados.join(','));
  window.open(`/api/secad/relatorios/adesao/pdf?${params.toString()}`, '_blank');
  fecharModal('rel-modal-pdf-cidades');
}
