// ── SECAD/Relatórios: adesão à renovação (front) ─────────────────────────────
// Importação (admin-only) + indicadores por prazo × cidade. Parse do Excel
// acontece aqui, no navegador, via SheetJS — mesmo padrão de
// public/js/pac-importacao.js — o servidor só recebe linhas já em JSON.

let _relArquivo = null;
let _relIniciado = false;

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

// ── Sub-navegação do submódulo (Relatórios × Importar planilha) ─────────────

function relTrocarSubview(nome) {
  const ehImportar = nome === 'importar';
  document.getElementById('rel-sub-painel').style.display = ehImportar ? 'none' : '';
  document.getElementById('rel-sub-importar').style.display = ehImportar ? '' : 'none';
  document.querySelectorAll('#rel-tabs .page-tab').forEach(t => t.classList.toggle('active', t.dataset.reltab === nome));
}

// ── Relatório ────────────────────────────────────────────────────────────────

async function initRelatorios() {
  if (_relIniciado) { carregarRelatorioAdesao(); return; }
  _relIniciado = true;
  document.getElementById('rel-filtro-importacao').addEventListener('change', carregarRelatorioAdesao);
  document.getElementById('rel-filtro-prazo').addEventListener('change', carregarRelatorioAdesao);
  document.getElementById('rel-filtro-cidade').addEventListener('change', carregarRelatorioAdesao);
  await Promise.all([_relCarregarImportacoes(), _relCarregarCidades()]);
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

async function _relCarregarCidades() {
  const sel = document.getElementById('rel-filtro-cidade');
  try {
    const res = await fetch('/api/secad/relatorios/cidades');
    const cidades = res.ok ? await res.json() : [];
    sel.innerHTML = '<option value="">Todas as cidades</option>' + cidades.map(c => `<option value="${c.id}">${c.descricao}</option>`).join('');
  } catch { /* mantém só "Todas as cidades" */ }
}

function _relParamsAtuais() {
  const p = new URLSearchParams();
  const imp = document.getElementById('rel-filtro-importacao').value;
  const prazo = document.getElementById('rel-filtro-prazo').value;
  const cidade = document.getElementById('rel-filtro-cidade').value;
  if (imp) p.set('importacao_id', imp);
  if (prazo) p.set('prazo', prazo);
  if (cidade) p.set('cidade_id', cidade);
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
  const cont = document.getElementById('rel-conteudo');
  const dashCard = document.getElementById('rel-dash-card');
  try {
    const res = await fetch(`/api/secad/relatorios/adesao?${_relParamsAtuais().toString()}`);
    if (res.status === 404) {
      info.textContent = '';
      dashCard.style.display = 'none';
      cont.innerHTML = `<div class="card"><div style="padding:40px;text-align:center;color:var(--text-muted);">Nenhuma importação feita ainda.</div></div>`;
      return;
    }
    const dados = await res.json();
    info.textContent = `Base: importação #${dados.importacao.id} — "${dados.importacao.nome_arquivo || '—'}", ${_relFmtDataHora(dados.importacao.criado_em)}, ${dados.importacao.total_linhas} linha(s)${dados.importacao.nao_casados ? ` (${dados.importacao.nao_casados} sem contrato correspondente)` : ''}.`;
    if (!dados.grupos.length) {
      dashCard.style.display = 'none';
      cont.innerHTML = `<div class="card"><div style="padding:40px;text-align:center;color:var(--text-muted);">Nenhum contrato no intervalo de prazo previsto (2027–2032) com os filtros atuais.</div></div>`;
      return;
    }
    dashCard.style.display = '';
    _relRenderDashboard(dados);
    cont.innerHTML = dados.grupos.map(_relRenderGrupo).join('');
  } catch {
    info.textContent = '';
    dashCard.style.display = 'none';
    cont.innerHTML = `<div class="card"><div style="padding:40px;text-align:center;color:var(--vermelho);">Erro ao carregar o relatório.</div></div>`;
  }
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
  const x2 = cx + 34 * Math.cos(theta), y2 = cy - 34 * Math.sin(theta);
  return `<svg viewBox="0 0 100 68" width="200" height="136" style="flex-shrink:0;">
    ${zonas.map(arcoZona).join('')}
    <line x1="${cx}" y1="${cy}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--text)" stroke-width="2.5" stroke-linecap="round"></line>
    <circle cx="${cx}" cy="${cy}" r="4" fill="var(--text)"></circle>
    <text x="4" y="63" font-size="7" fill="var(--text-muted)">0%</text>
    <text x="96" y="63" font-size="7" fill="var(--text-muted)" text-anchor="end">100%</text>
    <text x="${cx}" y="42" font-size="16" font-weight="800" text-anchor="middle" fill="var(--text)">${p.toFixed(1)}%</text>
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

// Linha simples (sem lib) do % acumulado de aceites sobre o total elegível,
// dia a dia — mostra se o ritmo de adesão está acelerando ou parado.
function _relSvgTimeline(pontos, totalElegivel) {
  if (!pontos.length || !totalElegivel) {
    return `<div class="text-muted" style="font-size:12px;padding:30px 10px;text-align:center;">Ainda sem datas de aceite suficientes pra desenhar a evolução.</div>`;
  }
  const w = 640, h = 140, padL = 8, padR = 8, padT = 16, padB = 22;
  let acumulado = 0;
  const serie = pontos.map(p => { acumulado += p.quantidade; return { data: p.data, pct: (acumulado / totalElegivel) * 100 }; });
  const n = serie.length;
  const x = i => padL + (n > 1 ? (i / (n - 1)) * (w - padL - padR) : (w - padL - padR) / 2);
  const y = pct => h - padB - (Math.min(100, pct) / 100) * (h - padT - padB);
  const pts = serie.map((s, i) => `${x(i).toFixed(1)},${y(s.pct).toFixed(1)}`).join(' ');
  const areaPath = `M ${x(0).toFixed(1)},${h - padB} L ${pts} L ${x(n - 1).toFixed(1)},${h - padB} Z`;
  const fmtData = iso => { const [, m, d] = String(iso).split('-'); return `${d}/${m}`; };
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="var(--cinza-b)" stroke-width="1"></line>
    <path d="${areaPath}" fill="var(--verde)" opacity="0.1"></path>
    <polyline points="${pts}" fill="none" stroke="var(--verde)" stroke-width="2.5"></polyline>
    <text x="${padL}" y="${h - 6}" font-size="9" fill="var(--text-muted)">${fmtData(serie[0].data)}</text>
    <text x="${w - padR}" y="${h - 6}" font-size="9" fill="var(--text-muted)" text-anchor="end">${fmtData(serie[n - 1].data)}</text>
    <text x="${padL}" y="${padT}" font-size="12" font-weight="700" fill="var(--text)">${serie[n - 1].pct.toFixed(1)}% acumulado</text>
  </svg>`;
}

function _relRenderDashboard(dados) {
  const totalGeral = dados.grupos.reduce((acc, g) => ({
    total: acc.total + g.total.total, aceitaram: acc.aceitaram + g.total.aceitaram,
  }), { total: 0, aceitaram: 0 });
  const pctGeral = totalGeral.total ? (totalGeral.aceitaram / totalGeral.total) * 100 : 0;
  document.getElementById('rel-gauge').innerHTML = _relSvgVelocimetro(pctGeral);

  const pendentesPorCidade = new Map();
  dados.grupos.forEach(g => g.cidades.forEach(c => {
    if (!c.pendentes) return;
    pendentesPorCidade.set(c.cidade, (pendentesPorCidade.get(c.cidade) || 0) + c.pendentes);
  }));
  const itensPizza = [...pendentesPorCidade.entries()].sort((a, b) => b[1] - a[1]).map(([cidade, qtd]) => ({ cidade, qtd }));
  const elPizza = document.getElementById('rel-pizza');
  if (!itensPizza.length) {
    elPizza.innerHTML = `<div class="text-muted" style="font-size:12px;padding:30px 10px;text-align:center;">Nenhum pendente — 100% de adesão.</div>`;
  } else {
    const svg = _relSvgPizza(itensPizza, it => it.qtd, (it, i) => PALETA_REL_CIDADE[i % PALETA_REL_CIDADE.length], 56);
    const legenda = itensPizza.map((it, i) => `
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:4px;">
        <span style="width:10px;height:10px;border-radius:2px;background:${PALETA_REL_CIDADE[i % PALETA_REL_CIDADE.length]};display:inline-block;"></span>
        ${it.cidade} — ${it.qtd}
      </div>`).join('');
    elPizza.innerHTML = `<div style="display:flex;gap:16px;align-items:center;justify-content:center;flex-wrap:wrap;">${svg}<div>${legenda}</div></div>`;
  }

  document.getElementById('rel-timeline').innerHTML = _relSvgTimeline(dados.evolucao || [], totalGeral.total);
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
  const linhasPendentes = _relAgruparPorCidade(g.lista_pendentes).map(bloco => `
    <tr class="rel-subcab"><td colspan="4">${bloco.cidade} (${bloco.itens.length})</td></tr>
    ${bloco.itens.map(p => `<tr><td>${p.codigo}</td><td>${p.concessionario}</td><td>${p.cnpj}</td><td>${p.numero_ccu}</td></tr>`).join('')}
  `).join('');
  return `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header"><span class="card-title">Prazo final: ${g.prazo}</span></div>
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

function baixarPdfAdesao() {
  window.open(`/api/secad/relatorios/adesao/pdf?${_relParamsAtuais().toString()}`, '_blank');
}
