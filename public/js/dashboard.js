function fmtData(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('T')[0].split('-');
  return `${d}/${m}/${y}`;
}

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  setTimeout(() => { el.className = ''; }, 3000);
}

function badgeStatus(s) {
  const label = s || 'Em cotação';
  const map = {
    'Em cotação':   'badge-cotacao',
    'Ag. aprovação':'badge-aprovacao',
    'Concluído':    'badge-concluido',
    'Parado':       'badge-parado'
  };
  return `<span class="badge ${map[label] || 'badge-cotacao'}">${label}</span>`;
}

function diasBadgeHtml(dias) {
  if (dias > 30) return `<span class="badge-dias badge-dias-vermelho">${dias} dias</span>`;
  if (dias > 15) return `<span class="badge-dias badge-dias-laranja">${dias} dias</span>`;
  return `<span class="badge-dias badge-dias-verde">${dias} dias</span>`;
}

// ── Alertas ───────────────────────────────────────────────────────────────────

function renderAlertas(alertas) {
  const tbody = document.getElementById('alertas-tbody');
  if (!alertas || alertas.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5">
      <div class="empty-state" style="padding:32px 24px;">
        <div style="font-size:32px;margin-bottom:8px;">✅</div>
        <strong style="font-size:14px;color:#2E7D32;">Todos os processos estão em dia.</strong>
        <p style="margin-top:4px;">Nenhum alerta no momento.</p>
      </div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = alertas.map(p => {
    const dias   = p.dias_em_aberto ?? 0;
    const rowBg  = dias > 30 ? 'background:#FFEBEE' : (dias > 15 ? 'background:#FFF3E0' : '');
    return `
      <tr${rowBg ? ` style="${rowBg}"` : ''}>
        <td><strong>${p.numero_processo}</strong></td>
        <td>${p.objeto}</td>
        <td>${p.setor_solicitante || '—'}</td>
        <td>${diasBadgeHtml(dias)}</td>
        <td><a href="cotacao.html?id=${p.id}" class="btn btn-primary btn-sm">Abrir</a></td>
      </tr>`;
  }).join('');
}

// ── Últimos processos ─────────────────────────────────────────────────────────

function renderUltimos(processos) {
  const el = document.getElementById('ultimos-list');
  if (!processos || !processos.length) {
    el.innerHTML = `<div class="empty-state" style="padding:20px;font-size:13px;">Nenhum processo cadastrado ainda.</div>`;
    return;
  }
  el.innerHTML = processos.map(p => `
    <a href="cotacao.html?id=${p.id}" class="process-list-item">
      <div class="pli-top">
        <span class="pli-num">${p.numero_processo}</span>
        <span class="pli-objeto">${p.objeto}</span>
      </div>
      <div class="pli-bot">
        ${badgeStatus(p.status)}
        <span class="pli-setor">${p.setor_solicitante || '—'}</span>
        <span class="pli-dias">${p.dias_em_aberto ?? 0} dias</span>
      </div>
    </a>
  `).join('');
}

// ── Distribuição por setor ────────────────────────────────────────────────────

function renderSetor(dados) {
  const el = document.getElementById('setor-list');
  if (!dados || !dados.length) {
    el.innerHTML = `<div class="empty-state" style="padding:20px;font-size:13px;">Nenhum processo cadastrado ainda.</div>`;
    return;
  }
  const maxTotal = dados[0].total;
  el.innerHTML = dados.map(d => `
    <div class="setor-bar-row">
      <span class="setor-label" title="${d.setor}">${d.setor}</span>
      <div class="setor-bar-track">
        <div class="setor-bar-fill" style="width:${Math.round((d.total / maxTotal) * 100)}%"></div>
      </div>
      <span class="setor-count">${d.total}</span>
    </div>
  `).join('');
}

// ── Carregamento principal ────────────────────────────────────────────────────

async function carregarDashboard() {
  try {
    const res  = await fetch('/api/dashboard/resumo');
    const data = await res.json();

    document.getElementById('val-cotacao').textContent    = data.em_cotacao;
    document.getElementById('val-aprovacao').textContent  = data.ag_aprovacao;
    document.getElementById('val-concluidos').textContent = data.concluidos_mes;
    document.getElementById('val-parados').textContent    = data.parados;

    renderAlertas(data.alertas);
    renderUltimos(data.ultimos_processos);
    renderSetor(data.por_setor);

  } catch (e) {
    toast('Erro ao carregar dashboard', 'error');
    console.error(e);
  }
}

carregarDashboard();
