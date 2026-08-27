// PAC — Gestão (DEPLA): setores, parâmetros, DFDs e pedidos de edição.

function toast(msg, tipo) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (tipo ? ' ' + tipo : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
}

function badgeStatusDfd(status) {
  const map = { aberto: 'Aberto', analise: 'Em análise', fechado: 'Fechado' };
  return `<span class="badge badge-${status}">${map[status] || status}</span>`;
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('#pac-tabs .page-tab').forEach(t => t.addEventListener('click', () => mudarAbaPac(t.dataset.tab)));
  carregarDfds();
  carregarSetores();
  popularSelectListas();
  carregarPedidos();
});

function mudarAbaPac(aba) {
  document.querySelectorAll('#pac-tabs .page-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === aba));
  document.querySelectorAll('.pac-pane').forEach(p => p.classList.toggle('active', p.id === `pane-${aba}`));
  if (aba === 'setores') carregarSetores();
  if (aba === 'parametros') carregarParametros();
  if (aba === 'pedidos') carregarPedidos();
}

/* ── DFDs ─────────────────────────────────────────────────────────────────── */

let _dfds = [];

async function carregarDfds() {
  try {
    const res = await fetch('/api/pac/dfds');
    _dfds = res.ok ? await res.json() : [];
    document.getElementById('dfds-tbody').innerHTML = _dfds.map(d => `
      <tr>
        <td><strong>${d.titulo}</strong></td>
        <td>${d.ano_base}</td>
        <td>${badgeStatusDfd(d.status)}</td>
        <td style="text-align:right;"><button class="btn btn-secondary btn-sm" onclick="abrirDetalheDfd(${d.id})">Abrir</button></td>
      </tr>
    `).join('') || `<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum DFD criado ainda.</td></tr>`;
  } catch {
    toast('Erro ao carregar DFDs', 'error');
  }
}

async function criarDfd() {
  const titulo = document.getElementById('new-dfd-titulo').value.trim();
  const ano_base = parseInt(document.getElementById('new-dfd-ano').value, 10);
  const descricao = document.getElementById('new-dfd-descricao').value.trim();
  const msg = document.getElementById('dfd-msg');
  msg.style.color = '';
  if (!titulo || !ano_base) { msg.style.color = '#c00'; msg.textContent = 'Informe título e ano base.'; return; }
  try {
    const res = await fetch('/api/pac/dfds', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titulo, ano_base, descricao }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    msg.style.color = '#2E7D32';
    msg.textContent = `DFD "${titulo}" criado.`;
    document.getElementById('new-dfd-titulo').value = '';
    document.getElementById('new-dfd-ano').value = '';
    document.getElementById('new-dfd-descricao').value = '';
    carregarDfds();
  } catch (e) {
    msg.style.color = '#c00'; msg.textContent = 'Erro: ' + e.message;
  }
}

let _dfdAtualId = null;

async function abrirDetalheDfd(id) {
  _dfdAtualId = id;
  document.getElementById('pac-dfd-lista').style.display = 'none';
  document.getElementById('pac-dfd-detalhe').style.display = 'block';
  await carregarDetalheDfd();
}

function fecharDetalheDfd() {
  _dfdAtualId = null;
  document.getElementById('pac-dfd-detalhe').style.display = 'none';
  document.getElementById('pac-dfd-lista').style.display = 'block';
  carregarDfds();
}

async function carregarDetalheDfd() {
  const res = await fetch(`/api/pac/dfds/${_dfdAtualId}`);
  if (!res.ok) { toast('Erro ao carregar DFD', 'error'); return; }
  const dfd = await res.json();
  document.getElementById('dfd-det-titulo').textContent = `${dfd.titulo} (${dfd.ano_base})`;
  const badge = document.getElementById('dfd-det-badge');
  const map = { aberto: 'Aberto', analise: 'Em análise', fechado: 'Fechado' };
  badge.className = `badge badge-${dfd.status}`;
  badge.textContent = map[dfd.status] || dfd.status;

  const acoes = document.getElementById('dfd-det-acoes');
  const opcoes = { aberto: ['analise', 'fechado'], analise: ['aberto', 'fechado'], fechado: ['aberto', 'analise'] };
  const rotulos = { aberto: 'Reabrir', analise: 'Enviar p/ análise', fechado: 'Fechar' };
  acoes.innerHTML = (opcoes[dfd.status] || []).map(s =>
    `<button class="btn btn-secondary btn-sm" onclick="mudarStatusDfd('${s}')">${rotulos[s]}</button>`
  ).join(' ');

  await renderGridSetoresDfd();
  await renderGridColunasDfd();
  await renderItensDfd(dfd.colunas);
}

async function mudarStatusDfd(status) {
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error();
    carregarDetalheDfd();
  } catch {
    toast('Erro ao mudar status do DFD', 'error');
  }
}

async function renderGridSetoresDfd() {
  const wrap = document.getElementById('dfd-det-setores');
  const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/setores`);
  const setores = res.ok ? await res.json() : [];
  wrap.innerHTML = `
    <table>
      <tbody>
        ${setores.map(s => `
          <tr>
            <td style="width:32px;"><input type="checkbox" ${s.ativo ? 'checked' : ''} onchange="toggleSetorDoDfd(${s.id}, this.checked)"></td>
            <td>${s.nome}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function toggleSetorDoDfd(setorId, ativo) {
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/setores`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setor_id: setorId, ativo }),
    });
    if (!res.ok) throw new Error();
  } catch {
    toast('Erro ao atualizar setor do DFD', 'error');
    renderGridSetoresDfd();
  }
}

async function renderGridColunasDfd() {
  const wrap = document.getElementById('dfd-det-colunas');
  const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/colunas`);
  const colunas = res.ok ? await res.json() : [];
  wrap.innerHTML = `
    <table>
      <tbody>
        ${colunas.map(c => `
          <tr>
            <td style="width:32px;"><input type="checkbox" ${c.ativa ? 'checked' : ''} ${c.slug === 'numero_item' ? 'disabled' : ''} onchange="toggleColunaDoDfd(${c.id}, this.checked)"></td>
            <td>${c.label} <span class="text-muted" style="font-size:11px;">(${c.grupo})</span></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function toggleColunaDoDfd(colunaId, ativa) {
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/colunas`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coluna_id: colunaId, ativa }),
    });
    if (!res.ok) throw new Error();
    renderItensDfd();
  } catch {
    toast('Erro ao atualizar coluna do DFD', 'error');
    renderGridColunasDfd();
  }
}

// Leitura simples (o perfil "Analista DEPLA" só tem "ver" em pac-lancamento —
// quem edita item é o gestor do setor, na tela de Lançamento). Grupo B/C
// (Possui Contrato? + dados do contrato) vira 1 coluna só, ícone com tooltip
// listando os dados — mesma simplificação do Lançamento, aqui só leitura.
async function renderItensDfd(colunasParam) {
  const todasColunas = colunasParam || (await (await fetch(`/api/pac/dfds/${_dfdAtualId}`)).json()).colunas;
  const colunas = todasColunas.filter(c => c.grupo === 'A');
  const colunasContrato = todasColunas.filter(c => c.grupo === 'C');
  const temColContrato = colunasContrato.length > 0;

  const [itensRes, setoresRes] = await Promise.all([
    fetch(`/api/pac/dfds/${_dfdAtualId}/itens`),
    fetch('/api/pac/setores'),
  ]);
  const itens = itensRes.ok ? await itensRes.json() : [];
  const setores = setoresRes.ok ? await setoresRes.json() : [];
  const nomeSetor = id => (setores.find(s => s.id === id) || {}).nome || `#${id}`;

  document.getElementById('dfd-det-itens-thead').innerHTML =
    `<tr><th>Setor</th>${colunas.map(c => `<th>${c.label}</th>`).join('')}${temColContrato ? '<th>Contrato</th>' : ''}</tr>`;

  document.getElementById('dfd-det-itens-tbody').innerHTML = itens.map(item => `
    <tr>
      <td>${nomeSetor(item.setor_id)}</td>
      ${colunas.map(c => `<td>${formatarValorColuna(c, c.slug === 'numero_item' ? item.numero_item : item.valores[c.id])}</td>`).join('')}
      ${temColContrato ? celulaContratoLeitura(item, colunasContrato) : ''}
    </tr>
  `).join('') || `<tr><td colspan="${colunas.length + (temColContrato ? 2 : 1)}" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item lançado ainda.</td></tr>`;
}

/* ── Formatação por tipo de coluna (mesma ideia de fmtBr/fmtMoeda do resto do
   sistema, despachada pelo tipo_input da coluna) ───────────────────────────── */
function fmtBr(iso) {
  if (!iso) return '—';
  const d = String(iso).split(/[T ]/)[0].split('-');
  if (d.length < 3) return iso;
  return `${d[2]}/${d[1]}/${d[0]}`;
}
function fmtMoeda(v) {
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '';
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function formatarValorColuna(coluna, valor) {
  if (valor === null || valor === undefined || valor === '') return '—';
  if (coluna.tipo_input === 'data') return fmtBr(valor);
  if (coluna.tipo_input === 'moeda') return fmtMoeda(valor);
  return valor;
}

const ICONE_CONTRATO_SIM = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--verde)" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15l2 2 4-4"/></svg>`;
const ICONE_CONTRATO_NAO = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;

// Só leitura aqui (quem edita é o gestor em Lançamento) — badge com texto
// (Com/Sem contrato) já visível, sem depender de hover; o tooltip complementa
// listando os dados quando preenchido.
function celulaContratoLeitura(item, colunasContrato) {
  const preenchidos = colunasContrato.filter(c => {
    const v = item.valores[c.id];
    return v !== null && v !== undefined && v !== '';
  });
  const tem = !!preenchidos.length;
  const titulo = tem
    ? preenchidos.map(c => `${c.label}: ${formatarValorColuna(c, item.valores[c.id])}`).join(' · ')
    : 'Este item não tem contrato';
  return `<td style="text-align:center;"><span class="badge-contrato ${tem ? 'tem' : 'nao'}" title="${titulo}">${tem ? ICONE_CONTRATO_SIM : ICONE_CONTRATO_NAO} ${tem ? 'Com contrato' : 'Sem contrato'}</span></td>`;
}

/* ── Setores (cadastro) ──────────────────────────────────────────────────── */

async function carregarSetores() {
  try {
    const res = await fetch('/api/pac/setores');
    const setores = res.ok ? await res.json() : [];
    document.getElementById('setores-tbody').innerHTML = setores.map(s => `
      <tr>
        <td><strong>${s.nome}</strong></td>
        <td>${s.sigla || '—'}</td>
        <td>${s.ordem}</td>
        <td><input type="checkbox" ${s.ativo ? 'checked' : ''} onchange="toggleSetorAtivo(${s.id}, this.checked)"></td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="editarSetor(${s.id},'${(s.nome || '').replace(/'/g, "\\'")}','${(s.sigla || '').replace(/'/g, "\\'")}',${s.ordem})">Editar</button>
          <button class="btn btn-secondary btn-sm" onclick="abrirModalSetorUsuarios(${s.id},'${(s.nome || '').replace(/'/g, "\\'")}')">Usuários</button>
        </td>
      </tr>
    `).join('');
  } catch {
    toast('Erro ao carregar setores', 'error');
  }
}

async function adicionarSetor() {
  const nome = document.getElementById('new-setor-nome').value.trim();
  const sigla = document.getElementById('new-setor-sigla').value.trim();
  const msg = document.getElementById('setor-msg');
  msg.style.color = '';
  if (!nome) { msg.style.color = '#c00'; msg.textContent = 'Informe o nome do setor.'; return; }
  try {
    const res = await fetch('/api/pac/setores', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome, sigla }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    msg.style.color = '#2E7D32'; msg.textContent = `Setor "${nome}" criado.`;
    document.getElementById('new-setor-nome').value = '';
    document.getElementById('new-setor-sigla').value = '';
    carregarSetores();
  } catch (e) {
    msg.style.color = '#c00'; msg.textContent = 'Erro: ' + e.message;
  }
}

async function editarSetor(id, nomeAtual, siglaAtual, ordemAtual) {
  const nome = prompt('Nome do setor:', nomeAtual);
  if (nome === null || !nome.trim()) return;
  const sigla = prompt('Sigla:', siglaAtual);
  if (sigla === null) return;
  const ordemStr = prompt('Ordem:', ordemAtual);
  if (ordemStr === null) return;
  try {
    const res = await fetch(`/api/pac/setores/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: nome.trim(), sigla: sigla.trim(), ordem: parseInt(ordemStr, 10) || 0 }),
    });
    if (!res.ok) throw new Error();
    carregarSetores();
  } catch {
    toast('Erro ao editar setor', 'error');
  }
}

async function toggleSetorAtivo(id, ativo) {
  try {
    const res = await fetch(`/api/pac/setores/${id}/ativo`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ativo }),
    });
    if (!res.ok) throw new Error();
  } catch {
    toast('Erro ao atualizar setor', 'error');
    carregarSetores();
  }
}

let _setorUsuariosId = null;

async function abrirModalSetorUsuarios(setorId, nomeSetor) {
  _setorUsuariosId = setorId;
  document.getElementById('modal-setor-usuarios-titulo').textContent = `Usuários — ${nomeSetor}`;
  await renderSetorUsuarios();
  document.getElementById('modal-setor-usuarios').classList.add('open');
}

function fecharModalSetorUsuarios() {
  document.getElementById('modal-setor-usuarios').classList.remove('open');
  _setorUsuariosId = null;
}

async function renderSetorUsuarios() {
  const tbody = document.getElementById('setor-usuarios-tbody');
  tbody.innerHTML = '<tr><td colspan="2" style="padding:12px;text-align:center;color:var(--text-subtle);">Carregando...</td></tr>';
  const res = await fetch(`/api/pac/setores/${_setorUsuariosId}/usuarios`);
  const usuarios = res.ok ? await res.json() : [];
  tbody.innerHTML = usuarios.map(u => `
    <tr>
      <td style="width:32px;"><input type="checkbox" ${u.vinculado ? 'checked' : ''} onchange="toggleSetorUsuario(${u.id}, this.checked)"></td>
      <td>${u.nome_completo || u.username}</td>
    </tr>
  `).join('') || `<tr><td colspan="2" style="padding:12px;text-align:center;color:var(--text-subtle);">Nenhum usuário.</td></tr>`;
}

async function toggleSetorUsuario(userId, vinculado) {
  try {
    const res = await fetch(`/api/pac/setores/${_setorUsuariosId}/usuarios`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, vinculado }),
    });
    if (!res.ok) throw new Error();
  } catch {
    toast('Erro ao vincular usuário', 'error');
    renderSetorUsuarios();
  }
}

/* ── Parâmetros (listas de dropdown) ────────────────────────────────────── */

const LISTAS_PARAMETRO = [
  ['tipo', 'Tipo'], ['subitem', 'Subitem'], ['prioridade', 'Prioridade'],
  ['fonte_pagadora', 'Fonte Pagadora'], ['unidade_medida', 'Unidade'], ['sim_nao', 'Sim/Não'],
];

function popularSelectListas() {
  const sel = document.getElementById('param-lista-select');
  sel.innerHTML = LISTAS_PARAMETRO.map(([slug, label]) => `<option value="${slug}">${label}</option>`).join('');
}

async function carregarParametros() {
  const lista = document.getElementById('param-lista-select').value;
  try {
    const res = await fetch(`/api/pac/parametros?lista=${encodeURIComponent(lista)}`);
    const params = res.ok ? await res.json() : [];
    document.getElementById('parametros-tbody').innerHTML = params.map(p => `
      <tr>
        <td><strong>${p.valor}</strong></td>
        <td>${p.ordem}</td>
        <td><input type="checkbox" ${p.ativo ? 'checked' : ''} onchange="toggleParametroAtivo(${p.id}, this.checked)"></td>
        <td style="text-align:right;">
          <button class="btn btn-secondary btn-sm" onclick="editarParametro(${p.id},'${(p.valor || '').replace(/'/g, "\\'")}',${p.ordem})">Editar</button>
          <button class="btn btn-danger btn-sm" onclick="excluirParametro(${p.id},'${(p.valor || '').replace(/'/g, "\\'")}')">Excluir</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum valor cadastrado.</td></tr>`;
  } catch {
    toast('Erro ao carregar parâmetros', 'error');
  }
}

async function adicionarParametro() {
  const lista = document.getElementById('param-lista-select').value;
  const valor = document.getElementById('new-param-valor').value.trim();
  const ordem = parseInt(document.getElementById('new-param-ordem').value, 10) || 0;
  const msg = document.getElementById('param-msg');
  msg.style.color = '';
  if (!valor) { msg.style.color = '#c00'; msg.textContent = 'Informe o valor.'; return; }
  try {
    const res = await fetch('/api/pac/parametros', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lista, valor, ordem }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    msg.style.color = '#2E7D32'; msg.textContent = `"${valor}" adicionado.`;
    document.getElementById('new-param-valor').value = '';
    document.getElementById('new-param-ordem').value = '';
    carregarParametros();
  } catch (e) {
    msg.style.color = '#c00'; msg.textContent = 'Erro: ' + e.message;
  }
}

async function editarParametro(id, valorAtual, ordemAtual) {
  const valor = prompt('Valor:', valorAtual);
  if (valor === null || !valor.trim()) return;
  const ordemStr = prompt('Ordem:', ordemAtual);
  if (ordemStr === null) return;
  try {
    const res = await fetch(`/api/pac/parametros/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valor: valor.trim(), ordem: parseInt(ordemStr, 10) || 0 }),
    });
    if (!res.ok) throw new Error();
    carregarParametros();
  } catch {
    toast('Erro ao editar parâmetro', 'error');
  }
}

async function toggleParametroAtivo(id, ativo) {
  try {
    const res = await fetch(`/api/pac/parametros/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ativo }),
    });
    if (!res.ok) throw new Error();
  } catch {
    toast('Erro ao atualizar parâmetro', 'error');
    carregarParametros();
  }
}

async function excluirParametro(id, valor) {
  if (!confirm(`Excluir "${valor}"?`)) return;
  try {
    const res = await fetch(`/api/pac/parametros/${id}`, { method: 'DELETE' });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    carregarParametros();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

/* ── Pedidos de edição ───────────────────────────────────────────────────── */

async function carregarPedidos() {
  try {
    const res = await fetch('/api/pac/pedidos');
    const pedidos = res.ok ? await res.json() : [];
    const pendentes = pedidos.filter(p => p.status === 'pendente');
    document.getElementById('pac-cnt-pedidos').textContent = pendentes.length;
    document.getElementById('pedidos-tbody').innerHTML = pedidos.map(p => `
      <tr>
        <td>#${p.dfd_id}</td>
        <td>#${p.setor_id}</td>
        <td>#${p.item_id ?? '—'}</td>
        <td>${p.tipo}</td>
        <td>${p.justificativa || '—'}</td>
        <td>${p.status}</td>
        <td style="text-align:right;white-space:nowrap;">
          ${p.status === 'pendente' ? `
            <button class="btn btn-primary btn-sm" onclick="responderPedido(${p.id},'aprovado')">Aprovar</button>
            <button class="btn btn-danger btn-sm" onclick="responderPedido(${p.id},'rejeitado')">Rejeitar</button>
          ` : (p.resposta || '—')}
        </td>
      </tr>
    `).join('') || `<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum pedido.</td></tr>`;
  } catch {
    toast('Erro ao carregar pedidos', 'error');
  }
}

async function responderPedido(id, status) {
  const resposta = prompt(status === 'aprovado' ? 'Resposta (opcional):' : 'Motivo da rejeição:');
  if (resposta === null) return;
  try {
    const res = await fetch(`/api/pac/pedidos/${id}/resposta`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, resposta }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    carregarPedidos();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}
