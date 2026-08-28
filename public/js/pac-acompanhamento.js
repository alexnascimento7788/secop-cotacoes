// PAC — Acompanhamento (gestor): mesma ideia da aba Acompanhamento do DEPLA em
// pac-gestao.js, só que sempre filtrada pelo(s) setor(es) do usuário — o
// servidor já filtra (GET /acompanhamento/meu-setor), aqui só falta o seletor
// de setor pra quem pertence a mais de um (filtro client-side sobre o mesmo
// payload, sem refazer a requisição).

function toast(msg, tipo) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (tipo ? ' ' + tipo : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
}

function fmtMoeda(v) {
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return 'R$ 0,00';
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtBrData(iso) {
  if (!iso) return '—';
  const d = String(iso).split(/[T ]/)[0].split('-');
  if (d.length < 3) return iso;
  return `${d[2]}/${d[1]}/${d[0]}`;
}
function badgeStatusExec(status) {
  const cor = {
    'Não Iniciado': 'fechado', 'Processado DEPLA': 'aberto', 'Fracionamento Aberto': 'analise',
    'Processo Finalizado': 'aberto', 'Cancelado': 'fechado',
  }[status] || 'fechado';
  return `<span class="badge badge-${cor}">${status || '—'}</span>`;
}

let _acompDados = null;

document.addEventListener('DOMContentLoaded', async () => {
  const user = await window.getCurrentUser();
  if (!user) return;
  document.getElementById('acomp-subtitulo').textContent = `${user.nome_completo || user.username}`;

  try {
    const [dfdsRes, setoresRes] = await Promise.all([
      fetch('/api/pac/dfds'),
      fetch('/api/pac/meus-setores'),
    ]);
    const dfds = dfdsRes.ok ? await dfdsRes.json() : [];
    document.getElementById('acomp-dfd-select').innerHTML = dfds.map(d => `<option value="${d.id}">${d.titulo} (${d.ano_base})</option>`).join('')
      || '<option value="">Nenhum DFD disponível</option>';

    const setores = setoresRes.ok ? await setoresRes.json() : [];
    if (setores.length > 1) {
      document.getElementById('acomp-setor-wrap').style.display = '';
      document.getElementById('acomp-setor-select').innerHTML =
        `<option value="">Todos os meus setores</option>` + setores.map(s => `<option value="${s.id}">${s.nome}</option>`).join('');
      document.getElementById('acomp-subtitulo').textContent += ` — ${setores.map(s => s.nome).join(', ')}`;
    } else if (setores.length === 1) {
      document.getElementById('acomp-subtitulo').textContent += ` — Você está vendo os itens do setor ${setores[0].nome}`;
    } else {
      document.getElementById('acomp-subtitulo').textContent += ' — Você não está vinculado a nenhum setor.';
    }

    if (dfds.length) carregarAcompanhamento();
  } catch {
    toast('Erro ao carregar', 'error');
  }
});

async function carregarAcompanhamento() {
  const dfdId = document.getElementById('acomp-dfd-select').value;
  if (!dfdId) return;
  document.getElementById('acomp-tbody').innerHTML = `<tr><td colspan="12" style="padding:20px;text-align:center;color:var(--text-subtle);">Carregando...</td></tr>`;
  try {
    const res = await fetch(`/api/pac/dfds/${dfdId}/acompanhamento/meu-setor`);
    if (!res.ok) throw new Error();
    _acompDados = await res.json();
    renderTabelaAcompanhamento();
  } catch {
    toast('Erro ao carregar acompanhamento', 'error');
  }
}

function renderTabelaAcompanhamento() {
  if (!_acompDados) return;
  const filtroSetor = document.getElementById('acomp-setor-select')?.value || '';
  const filtroStatus = document.getElementById('acomp-filtro-status').value;

  const itens = _acompDados.itens.filter(i =>
    (!filtroSetor || String(i.setor_id) === filtroSetor) &&
    (!filtroStatus || i.status_execucao === filtroStatus)
  );

  const linhaSaldo = v => v < 0 ? `<span class="pac-saldo-neg">${fmtMoeda(v)}</span>` : fmtMoeda(v);

  document.getElementById('acomp-tbody').innerHTML = itens.map(item => `
    <tr>
      <td class="acomp-toggle" onclick="toggleAcompLinha(${item.item_id})">${item.solicitacoes.length ? '▸' : ''}</td>
      <td><strong>${item.numero_pac || '—'}</strong></td>
      <td>${item.descricao_objeto || '—'}</td>
      <td>${item.tipo || '—'}</td>
      <td>${fmtMoeda(item.estimado_tu_mlp)}</td>
      <td>${fmtMoeda(item.estimado_rdc)}</td>
      <td>${badgeStatusExec(item.status_execucao)}</td>
      <td>${item.solicitacoes.length}</td>
      <td>${fmtMoeda(item.realizado_tu_mlp)}</td>
      <td>${fmtMoeda(item.realizado_rdc)}</td>
      <td>${linhaSaldo(item.saldo_tu_mlp)}</td>
      <td>${linhaSaldo(item.saldo_rdc)}</td>
    </tr>
    <tr class="acomp-sub-row hidden" id="acomp-sub-${item.item_id}">
      <td colspan="12">
        ${item.solicitacoes.length ? `
          <table style="width:100%;">
            <thead><tr><th>Movimento</th><th>Data</th><th>TU+MLP</th><th>RDC</th><th>Observação</th></tr></thead>
            <tbody>
              ${item.solicitacoes.map(s => `
                <tr>
                  <td>${s.numero_movimento || '—'}</td>
                  <td>${fmtBrData(s.data_requisicao)}</td>
                  <td>${fmtMoeda(s.valor_tu_mlp)}</td>
                  <td>${fmtMoeda(s.valor_rdc)}</td>
                  <td>${s.observacao || '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : '<span class="text-muted">Nenhuma solicitação vinculada.</span>'}
      </td>
    </tr>
  `).join('') || `<tr><td colspan="12" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item consolidado ainda para este DFD.</td></tr>`;

  const t = itens.reduce((acc, i) => ({
    estimado_tu_mlp: acc.estimado_tu_mlp + i.estimado_tu_mlp, estimado_rdc: acc.estimado_rdc + i.estimado_rdc,
    realizado_tu_mlp: acc.realizado_tu_mlp + i.realizado_tu_mlp, realizado_rdc: acc.realizado_rdc + i.realizado_rdc,
    saldo_tu_mlp: acc.saldo_tu_mlp + i.saldo_tu_mlp, saldo_rdc: acc.saldo_rdc + i.saldo_rdc,
  }), { estimado_tu_mlp: 0, estimado_rdc: 0, realizado_tu_mlp: 0, realizado_rdc: 0, saldo_tu_mlp: 0, saldo_rdc: 0 });
  document.getElementById('acomp-tfoot').innerHTML = itens.length ? `
    <tr>
      <td colspan="4">Totais (${itens.length} itens)</td>
      <td>${fmtMoeda(t.estimado_tu_mlp)}</td><td>${fmtMoeda(t.estimado_rdc)}</td>
      <td colspan="2"></td>
      <td>${fmtMoeda(t.realizado_tu_mlp)}</td><td>${fmtMoeda(t.realizado_rdc)}</td>
      <td>${linhaSaldo(t.saldo_tu_mlp)}</td><td>${linhaSaldo(t.saldo_rdc)}</td>
    </tr>
  ` : '';
}

function toggleAcompLinha(itemId) {
  document.getElementById(`acomp-sub-${itemId}`)?.classList.toggle('hidden');
}
