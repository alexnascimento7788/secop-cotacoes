// DETIN — Painel executivo (termômetro financeiro + linha do tempo + KPIs + fila de ação).

function toast(msg, tipo) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (tipo ? ' ' + tipo : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
}

function fmtMoeda(v) {
  return (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Farol de urgência por dias restantes — mesmos 5 níveis em todo o módulo
// (painel, timeline e fila de ação usam a mesma função).
function farolInfo(dias) {
  if (dias == null) return { cor: '#9ca3af', label: 'Normal' };
  if (dias <= 10) return { cor: '#c0392b', label: 'Crítico' };
  if (dias <= 15) return { cor: '#d97706', label: 'Urgente' };
  if (dias <= 30) return { cor: '#eab308', label: 'Atenção' };
  if (dias <= 60) return { cor: '#16a34a', label: 'Monitorar' };
  return { cor: '#9ca3af', label: 'Normal' };
}

// Paleta cíclica pra segmentar termômetro/gráficos por fornecedor — sem
// biblioteca, cores fixas o bastante pra distinguir visualmente até ~10
// fornecedores (mais que isso, repete, mas não é o caso real do DETIN hoje).
const PALETA_FORNECEDOR = ['#1A3F6B', '#2A5A94', '#5B8FC7', '#8FB3DA', '#C97A00', '#E08E00', '#1A6B35', '#2E8B47', '#9333ea', '#c0392b'];

const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function svgBarrasHorizontais(dados, formatarValor) {
  if (!dados.length) return '<div class="text-muted" style="font-size:12px;">Sem dados.</div>';
  const max = Math.max(...dados.map(d => d.valor), 1);
  return dados.map(d => `
    <div class="dt-mini-bar-row">
      <span class="dt-mini-bar-label" title="${d.label}">${d.label}</span>
      <span class="dt-mini-bar-track"><span class="dt-mini-bar-fill" style="width:${Math.max((d.valor / max) * 100, 2)}%;background:${d.cor};"></span></span>
      <span class="dt-mini-bar-valor">${formatarValor ? formatarValor(d.valor) : d.valor}</span>
    </div>
  `).join('');
}

async function carregarPainel() {
  try {
    const res = await fetch('/api/detin/painel');
    if (!res.ok) throw new Error();
    const data = await res.json();
    renderTermometro(data);
    renderTimeline(data.timeline);
    renderMetricas(data);
    renderFilaAcao(data.alertas);
  } catch {
    toast('Erro ao carregar o painel', 'error');
  }
}

function renderTermometro(data) {
  const fornecedores = data.contratos_por_fornecedor || [];
  const total = fornecedores.reduce((s, f) => s + f.valor_mensal, 0) || 1;
  document.getElementById('dt-termometro-barra').innerHTML = fornecedores.map((f, i) => {
    const pct = Math.max((f.valor_mensal / total) * 100, 0.5);
    const cor = PALETA_FORNECEDOR[i % PALETA_FORNECEDOR.length];
    return `<div class="dt-termometro-seg" style="width:${pct}%;background:${cor};" title="${f.fornecedor}: R$ ${fmtMoeda(f.valor_mensal)}/mês (${f.total} contrato(s))"></div>`;
  }).join('');

  document.getElementById('dt-valor-mensal').innerHTML = `R$ ${fmtMoeda(data.valor_mensal_total)}<small> /mês</small>`;
  document.getElementById('dt-valor-anual').textContent = `Projeção anual: R$ ${fmtMoeda(data.valor_anual_projetado)}`;

  const badge = document.getElementById('dt-badge-pendencia');
  if (data.pendencias && data.pendencias.length) {
    badge.style.display = '';
    badge.textContent = `⚠️ ${data.pendencias.length} contrato(s) com cadastro incompleto`;
  } else {
    badge.style.display = 'none';
  }
}

function renderTimeline(timeline) {
  const hoje = new Date();
  document.getElementById('dt-timeline').innerHTML = (timeline || []).map((m, i) => {
    const atual = i === 0 ? ' atual' : '';
    const pilulas = (m.contratos || []).map(c => {
      const f = farolInfo(c.dias_restantes);
      return `<span class="dt-pilula" style="border-color:${f.cor};color:${f.cor};" title="${f.label} — ${c.dias_restantes} dia(s)" onclick="location.href='detin-contratos.html?id=${c.id}'">
        <span style="width:7px;height:7px;border-radius:50%;background:${f.cor};display:inline-block;"></span>
        ${c.numero_contrato || 'S/N'} — ${c.fornecedor}
      </span>`;
    }).join('');
    return `<div class="dt-tl-mes${atual}">
      <div class="dt-tl-mes-label">${MESES_PT[m.mes - 1]}/${m.ano}</div>
      <div class="dt-tl-pilulas">${pilulas || '<span class="dt-tl-vazio">Nenhum vencimento</span>'}</div>
    </div>`;
  }).join('');
}

function renderMetricas(data) {
  const criticos = (data.alertas || []).filter(a => a.dias_restantes <= 10).length;
  document.getElementById('dt-metricas').innerHTML = `
    <div class="dt-metrica-num">${data.total_ativos}</div>
    <div class="dt-metrica-label">contrato(s) ativo(s)</div>
    <div class="dt-metrica-num">R$ ${fmtMoeda(data.valor_mensal_total)}</div>
    <div class="dt-metrica-label">comprometido por mês</div>
    <div class="dt-metrica-num${criticos > 0 ? ' critico' : ''}">${criticos}</div>
    <div class="dt-metrica-label">crítico(s) (≤ 10 dias)</div>
  `;

  const coresTipo = { servico_continuado: '#1A3F6B', licenca: '#C97A00', locacao: '#1A6B35', pagamento_unico: '#9333ea' };
  const labelTipo = { servico_continuado: 'Serviço contínuo', licenca: 'Licença', locacao: 'Locação', pagamento_unico: 'Pagamento único' };
  const dadosTipo = (data.contratos_por_tipo || []).map(t => ({ label: labelTipo[t.tipo] || t.tipo, valor: t.total, cor: coresTipo[t.tipo] || '#888' }));
  document.getElementById('dt-bar-tipo').innerHTML = svgBarrasHorizontais(dadosTipo, v => String(v));

  const top5 = [...(data.contratos_por_fornecedor || [])].sort((a, b) => b.valor_mensal - a.valor_mensal).slice(0, 5)
    .map((f, i) => ({ label: f.fornecedor, valor: f.valor_mensal, cor: PALETA_FORNECEDOR[i % PALETA_FORNECEDOR.length] }));
  document.getElementById('dt-bar-fornecedor').innerHTML = svgBarrasHorizontais(top5, v => 'R$ ' + fmtMoeda(v));
}

function renderFilaAcao(alertas) {
  const el = document.getElementById('dt-fila-acao');
  if (!alertas || !alertas.length) {
    el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;color:var(--verde,#1A6B35);font-size:13px;">✅ Nenhum contrato crítico nos próximos 60 dias.</div>`;
    return;
  }
  el.innerHTML = alertas.map(c => {
    const f = farolInfo(c.dias_restantes);
    const txtDias = c.dias_restantes === 0 ? 'Vence hoje' : c.dias_restantes < 0 ? `Venceu há ${-c.dias_restantes}d` : `${c.dias_restantes} dia(s)`;
    return `<div class="dt-acao-card">
      <span class="dt-acao-farol" style="background:${f.cor};"></span>
      <span class="dt-acao-fornecedor">${c.fornecedor}</span>
      <span class="dt-acao-objeto" title="${c.objeto || ''}">${c.objeto || '—'}</span>
      <span class="dt-acao-dias" style="color:${f.cor};">${txtDias}</span>
      <button class="btn btn-secondary btn-sm" onclick="location.href='detin-contratos.html?id=${c.id}'">Ver contrato</button>
    </div>`;
  }).join('');
}

document.addEventListener('DOMContentLoaded', carregarPainel);
