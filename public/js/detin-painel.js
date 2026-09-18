// DETIN — Painel executivo (donuts animados + linha do tempo + KPIs + fila de ação).

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

// Farol de urgência por dias restantes — usado na fila de ação e no
// contador "crítico" das métricas (5 níveis, granularidade fina pra ação).
function farolInfo(dias) {
  if (dias == null) return { cor: '#9ca3af', label: 'Normal' };
  if (dias <= 10) return { cor: '#c0392b', label: 'Crítico' };
  if (dias <= 15) return { cor: '#d97706', label: 'Urgente' };
  if (dias <= 30) return { cor: '#eab308', label: 'Atenção' };
  if (dias <= 60) return { cor: '#16a34a', label: 'Monitorar' };
  return { cor: '#9ca3af', label: 'Normal' };
}

// Farol da linha do tempo — 3 níveis só (pedido do Alex): vencido = vermelho,
// até 90 dias = amarelo, resto = verde. Mês sem nenhum vencimento usa azul
// (não cinza) pra marcar visualmente "sem pendência" em vez de "sem dado".
function farolTimeline(dias) {
  if (dias == null) return { cor: '#2563eb', label: 'Sem vencimento' };
  if (dias < 0) return { cor: '#c0392b', label: 'Vencido' };
  if (dias <= 90) return { cor: '#eab308', label: 'Atenção' };
  return { cor: '#16a34a', label: 'Normal' };
}

// Paleta cíclica pra segmentar donuts/gráficos por fornecedor — sem
// biblioteca, cores fixas o bastante pra distinguir visualmente até ~10
// fornecedores (mais que isso, repete, mas não é o caso real do DETIN hoje).
const PALETA_FORNECEDOR = ['#1A3F6B', '#2A5A94', '#5B8FC7', '#8FB3DA', '#C97A00', '#E08E00', '#1A6B35', '#2E8B47', '#9333ea', '#c0392b'];

const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/* ── Animação: contador (count-up) e utilitário de donut ────────────────── */

// Anima um número de 0 até `valorFinal`, chamando `formatar(valorAtual)` a
// cada frame — usado nos KPIs grandes (valor mensal/anual, ativos, críticos)
// pra dar o "gráfico animado" pedido sem precisar de biblioteca de charts.
function animarNumero(el, valorFinal, formatar, duracao = 850) {
  if (!el) return;
  const inicio = performance.now();
  function passo(agora) {
    const decorrido = agora - inicio;
    let p = Math.min(decorrido / duracao, 1);
    p = 1 - Math.pow(1 - p, 3); // ease-out cúbico
    el.textContent = formatar(valorFinal * p);
    if (p < 1) requestAnimationFrame(passo);
  }
  requestAnimationFrame(passo);
}

// Monta os <circle> de um donut multi-segmento (SVG stroke-dasharray),
// devolvendo o HTML dos segmentos e a soma total. Cada <circle> nasce com
// dasharray "0 circunferência" e só ganha o valor final 1 frame depois
// (raf duplo) — é a transição CSS de stroke-dasharray que faz o "desenho"
// animar ao abrir a página, sem depender de lib de gráfico.
function montarDonut(itens, valorFn, corFn, raio, strokeW, centro) {
  const circunferencia = 2 * Math.PI * raio;
  const total = itens.reduce((s, it) => s + valorFn(it), 0) || 1;
  let acumulado = 0;
  const segmentos = itens.map((it, i) => {
    const valor = valorFn(it);
    const frac = valor / total;
    const dash = frac * circunferencia;
    const offset = -acumulado;
    acumulado += dash;
    return { cor: corFn(it, i), dash, offset };
  });
  const html = segmentos.map(s => `
    <circle cx="${centro}" cy="${centro}" r="${raio}" fill="none" stroke="${s.cor}" stroke-width="${strokeW}"
      stroke-dasharray="0 ${circunferencia.toFixed(1)}" stroke-dashoffset="${s.offset.toFixed(1)}"
      data-dash-final="${s.dash.toFixed(1)} ${(circunferencia - s.dash).toFixed(1)}"></circle>
  `).join('');
  return { html, total };
}

// Dispara as transições CSS: define o dasharray/width final 2 frames depois
// de inserir o HTML (precisa que o navegador pinte o estado "0" primeiro,
// senão a transição não roda).
function dispararAnimacoes(container) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    container.querySelectorAll('circle[data-dash-final]').forEach(c => {
      c.setAttribute('stroke-dasharray', c.dataset.dashFinal);
    });
    container.querySelectorAll('[data-width-final]').forEach(b => {
      b.style.width = b.dataset.widthFinal;
    });
    container.classList.add('in');
  }));
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
  const card = document.getElementById('dt-termometro-card');

  const raio = 70, strokeW = 20;
  const { html } = montarDonut(fornecedores, f => f.valor_mensal, (f, i) => PALETA_FORNECEDOR[i % PALETA_FORNECEDOR.length], raio, strokeW, 88);
  document.getElementById('dt-donut-fornecedor').innerHTML = html;

  animarNumero(document.getElementById('dt-valor-mensal'), data.valor_mensal_total, v => `R$ ${fmtMoeda(v)}`);
  animarNumero(document.getElementById('dt-valor-anual'), data.valor_anual_projetado, v => `Projeção anual: R$ ${fmtMoeda(v)}`);

  const maxFornecedor = Math.max(...fornecedores.map(f => f.valor_mensal), 1);
  document.getElementById('dt-legenda-fornecedor').innerHTML = fornecedores.map((f, i) => {
    const cor = PALETA_FORNECEDOR[i % PALETA_FORNECEDOR.length];
    const pct = Math.max((f.valor_mensal / maxFornecedor) * 100, 2);
    return `<div class="dt-legenda-linha">
      <span class="dt-legenda-dot" style="background:${cor};"></span>
      <span class="dt-legenda-nome" title="${f.fornecedor}">${f.fornecedor}</span>
      <span class="dt-legenda-track"><span class="dt-legenda-fill" style="background:${cor};" data-width-final="${pct}%"></span></span>
      <span class="dt-legenda-valor dt-tabular">R$ ${fmtMoeda(f.valor_mensal)}</span>
    </div>`;
  }).join('') || '<div class="text-muted" style="font-size:12px;">Sem contratos com valor mensal cadastrado.</div>';

  const badge = document.getElementById('dt-badge-pendencia');
  if (data.pendencias && data.pendencias.length) {
    badge.style.display = '';
    badge.textContent = `⚠️ ${data.pendencias.length} contrato(s) com cadastro incompleto`;
  } else {
    badge.style.display = 'none';
  }

  dispararAnimacoes(card);
}

function renderTimeline(timeline) {
  const hoje = new Date();
  document.getElementById('dt-timeline').innerHTML = (timeline || []).map((m, i) => {
    const atual = i === 0 ? ' atual' : '';
    const pilulas = (m.contratos || []).map(c => {
      const f = farolTimeline(c.dias_restantes);
      return `<span class="dt-pilula" style="border-color:${f.cor};color:${f.cor};" title="${f.label} — ${c.dias_restantes} dia(s)" onclick="location.href='detin-contratos.html?id=${c.id}'">
        <span style="width:7px;height:7px;border-radius:50%;background:${f.cor};display:inline-block;"></span>
        ${c.numero_contrato || 'S/N'} — ${c.fornecedor}
      </span>`;
    }).join('');
    const vazio = !pilulas;
    return `<div class="dt-tl-mes${atual}${vazio ? ' vazio' : ''}">
      <div class="dt-tl-mes-label${vazio ? ' vazio' : ''}">${MESES_PT[m.mes - 1]}/${m.ano}</div>
      <div class="dt-tl-pilulas">${pilulas || '<span class="dt-tl-vazio">Nenhum vencimento</span>'}</div>
    </div>`;
  }).join('');
}

function renderMetricas(data) {
  const criticos = (data.alertas || []).filter(a => a.dias_restantes <= 10).length;
  document.getElementById('dt-metricas').innerHTML = `
    <div class="dt-metrica-item">
      <div class="dt-metrica-num dt-tabular" id="dt-metrica-ativos">0</div>
      <div class="dt-metrica-label">contrato(s) ativo(s)</div>
    </div>
    <div class="dt-metrica-item">
      <div class="dt-metrica-num dt-tabular" id="dt-metrica-comprometido">R$ 0,00</div>
      <div class="dt-metrica-label">comprometido por mês</div>
    </div>
    <div class="dt-metrica-item">
      <div class="dt-metrica-num dt-tabular${criticos > 0 ? ' critico' : ''}" id="dt-metrica-criticos">0</div>
      <div class="dt-metrica-label">crítico(s) (≤ 10 dias)</div>
    </div>
  `;
  animarNumero(document.getElementById('dt-metrica-ativos'), data.total_ativos, v => String(Math.round(v)));
  animarNumero(document.getElementById('dt-metrica-comprometido'), data.valor_mensal_total, v => `R$ ${fmtMoeda(v)}`);
  animarNumero(document.getElementById('dt-metrica-criticos'), criticos, v => String(Math.round(v)));

  const coresTipo = { servico_continuado: '#1A3F6B', licenca: '#C97A00', locacao: '#1A6B35', pagamento_unico: '#9333ea' };
  const labelTipo = { servico_continuado: 'Serviço contínuo', licenca: 'Licença', locacao: 'Locação', pagamento_unico: 'Pagamento único' };
  const porTipo = data.contratos_por_tipo || [];

  const card = document.getElementById('dt-donut-tipo-card');
  const { html } = montarDonut(porTipo, t => t.total, t => coresTipo[t.tipo] || '#888', 52, 17, 64);
  document.getElementById('dt-donut-tipo').innerHTML = html;
  const totalContratos = porTipo.reduce((s, t) => s + t.total, 0);
  animarNumero(document.getElementById('dt-donut-tipo-total'), totalContratos, v => String(Math.round(v)));
  document.getElementById('dt-legenda-tipo').innerHTML = porTipo.map(t => `
    <div class="dt-legenda-tipo-linha">
      <span class="dt-legenda-tipo-sq" style="background:${coresTipo[t.tipo] || '#888'};"></span>
      <span class="dt-legenda-tipo-nome">${labelTipo[t.tipo] || t.tipo}</span>
      <span class="dt-legenda-tipo-qtd dt-tabular">${t.total}</span>
    </div>
  `).join('') || '<div class="text-muted" style="font-size:12px;">Sem dados.</div>';
  dispararAnimacoes(card);

  const top5 = [...(data.contratos_por_fornecedor || [])].sort((a, b) => b.valor_mensal - a.valor_mensal).slice(0, 5);
  const maxTop = Math.max(...top5.map(f => f.valor_mensal), 1);
  const contBarras = document.getElementById('dt-bar-fornecedor');
  contBarras.innerHTML = top5.map((f, i) => {
    const cor = PALETA_FORNECEDOR[i % PALETA_FORNECEDOR.length];
    const pct = Math.max((f.valor_mensal / maxTop) * 100, 2);
    return `<div class="dt-mini-bar-row">
      <span class="dt-mini-bar-label" title="${f.fornecedor}">${f.fornecedor}</span>
      <span class="dt-mini-bar-track"><span class="dt-mini-bar-fill" style="background:${cor};" data-width-final="${pct}%"></span></span>
      <span class="dt-mini-bar-valor dt-tabular">R$ ${fmtMoeda(f.valor_mensal)}</span>
    </div>`;
  }).join('') || '<div class="text-muted" style="font-size:12px;">Sem dados.</div>';
  dispararAnimacoes(contBarras);
}

function renderFilaAcao(alertas) {
  const el = document.getElementById('dt-fila-acao');
  if (!alertas || !alertas.length) {
    el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;color:var(--verde,#1A6B35);font-size:13px;">✅ Nenhum contrato crítico nos próximos 60 dias.</div>`;
    return;
  }
  const raio = 16, strokeW = 5, circunferencia = 2 * Math.PI * raio;
  el.innerHTML = alertas.map(c => {
    const f = farolInfo(c.dias_restantes);
    const txtDias = c.dias_restantes === 0 ? 'Vence hoje' : c.dias_restantes < 0 ? `Venceu há ${-c.dias_restantes}d` : `${c.dias_restantes} dia(s)`;
    const filled = Math.max(Math.min(c.dias_restantes / 60, 1), 0);
    const dash = filled * circunferencia;
    return `<div class="dt-acao-card" style="border-left-color:${f.cor};">
      <div class="dt-acao-ring-wrap">
        <svg width="38" height="38" viewBox="0 0 38 38">
          <circle cx="19" cy="19" r="${raio}" fill="none" stroke="var(--surface-2)" stroke-width="${strokeW}"/>
          <circle cx="19" cy="19" r="${raio}" fill="none" stroke="${f.cor}" stroke-width="${strokeW}" stroke-linecap="round"
            transform="rotate(-90 19 19)" stroke-dasharray="0 ${circunferencia.toFixed(1)}"
            data-dash-final="${dash.toFixed(1)} ${(circunferencia - dash).toFixed(1)}"></circle>
        </svg>
        <span class="dt-acao-ring-dias" style="color:${f.cor};">${c.dias_restantes ?? '—'}</span>
      </div>
      <span class="dt-acao-fornecedor" title="${c.fornecedor}">${c.fornecedor}</span>
      <span class="dt-acao-objeto" title="${c.objeto || ''}">${c.objeto || '—'}</span>
      <span class="dt-acao-dias" style="color:${f.cor};">${txtDias}</span>
      <button class="btn btn-secondary btn-sm" onclick="location.href='detin-contratos.html?id=${c.id}'">Ver contrato</button>
    </div>`;
  }).join('');
  dispararAnimacoes(el);
}

document.addEventListener('DOMContentLoaded', carregarPainel);
