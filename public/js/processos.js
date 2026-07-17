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
  const map = {
    'Em cotação': 'badge-cotacao',
    'Ag. aprovação': 'badge-aprovacao',
    'Concluído': 'badge-concluido',
    'Parado': 'badge-parado',
    'Cancelado': 'badge-cancelado'
  };
  return `<span class="badge ${map[s] || ''}">${s}</span>`;
}

let processos = [];
let deleteId  = null;
let statusList = [];
let currentUser = null;
let abaAtual   = 'andamento';
let cfgAlertas = { laranja: 5, vermelho: 10 };

// Em qual aba o processo aparece, conforme o status
function abaDoProcesso(p) {
  if (p.status === 'Concluído') return 'concluido';
  if (p.status === 'Cancelado') return 'cancelado';
  return 'andamento'; // Em cotação (ou legado sem status), Ag. aprovação, Parado
}

function mudarAbaProc(aba) {
  abaAtual = aba;
  document.querySelectorAll('.page-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === aba));
  renderTable(processos);
}

async function carregarConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const cfg = await res.json();
    cfgAlertas.laranja  = parseInt(cfg.alerta_dias_laranja)  || cfgAlertas.laranja;
    cfgAlertas.vermelho = parseInt(cfg.alerta_dias_vermelho) || cfgAlertas.vermelho;
  } catch {}
}

function podeEditar(p) {
  return currentUser && (currentUser.role === 'admin' || p.criado_por_id === currentUser.id);
}

async function carregarStatus() {
  try {
    const res = await fetch('/api/status');
    statusList = res.ok ? await res.json() : [];
    const filtro = document.getElementById('filtro-status');
    statusList.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.nome; opt.textContent = s.nome;
      filtro.appendChild(opt);
    });
  } catch {}
}

async function carregarSetores() {
  try {
    const res = await fetch('/api/setores');
    const setores = await res.json();
    const sel = document.getElementById('filtro-setor');
    setores.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      sel.appendChild(opt);
    });
  } catch {}
}

async function carregarProcessos() {
  const busca  = document.getElementById('busca').value.trim();
  const status = document.getElementById('filtro-status').value;
  const setor  = document.getElementById('filtro-setor').value;

  const params = new URLSearchParams();
  if (busca)  params.set('busca', busca);
  if (status) params.set('status', status);
  if (setor)  params.set('setor', setor);

  const tbody = document.getElementById('processos-tbody');
  tbody.innerHTML = `<tr><td colspan="8" class="loader">Carregando...</td></tr>`;

  try {
    if (!currentUser) currentUser = await getCurrentUser();
    const res = await fetch(`/api/processos?${params}`);
    processos = await res.json();
    renderTable(processos);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="loader">Erro ao carregar processos.</td></tr>`;
  }
}

function renderTable(list) {
  const tbody = document.getElementById('processos-tbody');

  // Contadores das abas (sobre a lista filtrada pelos filtros atuais)
  const counts = { andamento: 0, concluido: 0, cancelado: 0 };
  list.forEach(p => { counts[abaDoProcesso(p)]++; });
  ['andamento', 'concluido', 'cancelado'].forEach(a => {
    document.getElementById(`count-${a}`).textContent = counts[a];
  });

  const visiveis = list.filter(p => abaDoProcesso(p) === abaAtual);

  if (!visiveis.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">
      <strong>Nenhum processo encontrado</strong>
      <p>Tente ajustar os filtros ou crie um novo processo.</p>
    </div></td></tr>`;
    return;
  }

  tbody.innerHTML = visiveis.map(p => {
    const dias = p.dias_em_aberto ?? 0;
    const diasClass = dias > 15 ? 'text-red' : '';
    const editavel = podeEditar(p);
    // Alerta visual: só na aba Em andamento, para processos em cotação
    let rowClass = '';
    if (abaAtual === 'andamento' && (!p.status || p.status === 'Em cotação')) {
      if (dias > cfgAlertas.vermelho)     rowClass = 'row-alerta-vermelho';
      else if (dias > cfgAlertas.laranja) rowClass = 'row-alerta-laranja';
    }
    return `
      <tr class="${rowClass}">
        <td><strong>${p.numero_processo}</strong></td>
        <td>${p.objeto}${p.criado_por_username ? `<div style="font-size:11px;color:var(--text-subtle);margin-top:2px;">Criado por ${p.criado_por_username}</div>` : ''}</td>
        <td>${p.setor_solicitante || '—'}</td>
        <td>${p.tipo_contratacao || '—'}</td>
        <td>${p.responsavel || '—'}</td>
        <td>
          <select class="status-select status-inline" data-id="${p.id}" style="font-size:12px;padding:3px 6px;" ${editavel ? '' : 'disabled'}>
            ${statusList.map(s => `<option value="${s.nome}"${s.nome === p.status ? ' selected' : ''}>${s.nome}</option>`).join('')}
          </select>
        </td>
        <td class="${diasClass}">${dias} dias</td>
        <td>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <a href="cotacao.html?id=${p.id}" class="btn btn-primary btn-sm">Abrir quadro</a>
            <a href="fornecedor.html?processo_id=${p.id}" class="btn btn-outline btn-sm">Fornecedores</a>
            ${editavel ? `
              <a href="novo-processo.html?id=${p.id}" class="btn btn-secondary btn-sm">Editar</a>
              <button class="btn btn-danger btn-sm" onclick="confirmarDelete(${p.id})">Excluir</button>
            ` : ''}
          </div>
        </td>
      </tr>`;
  }).join('');
}

function confirmarDelete(id) {
  deleteId = id;
  const modal = document.getElementById('modal-delete');
  modal.style.display = 'flex';
}

async function excluirProcesso() {
  if (!deleteId) return;
  try {
    const res = await fetch(`/api/processos/${deleteId}`, { method: 'DELETE' });
    if (res.ok) {
      toast('Processo excluído com sucesso', 'success');
      fecharModal();
      carregarProcessos();
    } else {
      toast('Erro ao excluir processo', 'error');
    }
  } catch {
    toast('Erro ao excluir processo', 'error');
  }
}

function fecharModal() {
  deleteId = null;
  document.getElementById('modal-delete').style.display = 'none';
}

let debounceTimer;
function debounce(fn, delay) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(fn, delay);
}

document.getElementById('busca').addEventListener('input', () => debounce(carregarProcessos, 300));
document.getElementById('filtro-status').addEventListener('change', carregarProcessos);
document.getElementById('filtro-setor').addEventListener('change', carregarProcessos);

document.getElementById('btn-limpar').addEventListener('click', () => {
  document.getElementById('busca').value = '';
  document.getElementById('filtro-status').value = '';
  document.getElementById('filtro-setor').value = '';
  carregarProcessos();
});

document.getElementById('btn-confirm-delete').addEventListener('click', excluirProcesso);
document.getElementById('btn-cancel-delete').addEventListener('click', fecharModal);

document.getElementById('modal-delete').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-delete')) fecharModal();
});

document.getElementById('processos-tbody').addEventListener('change', async e => {
  const sel = e.target.closest('.status-inline');
  if (!sel) return;
  try {
    await fetch(`/api/processos/${sel.dataset.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: sel.value })
    });
    toast('Status atualizado!', 'success');
    // Reflete na lista local e re-renderiza — processo muda de aba na hora, se for o caso
    const p = processos.find(x => x.id === parseInt(sel.dataset.id));
    if (p) { p.status = sel.value; renderTable(processos); }
  } catch { toast('Erro ao atualizar status.', 'error'); }
});

carregarStatus();
carregarSetores();
carregarConfig().then(carregarProcessos);
