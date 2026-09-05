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
  aplicarPermissaoSolicitacoes();
  aplicarAcessoImportacao();
  popularSelectDfdsExecucao();
});

function mudarAbaPac(aba) {
  document.querySelectorAll('#pac-tabs .page-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === aba));
  document.querySelectorAll('.pac-pane').forEach(p => p.classList.toggle('active', p.id === `pane-${aba}`));
  if (aba === 'setores') carregarSetores();
  if (aba === 'parametros') carregarParametros();
  if (aba === 'pedidos') carregarPedidos();
  if (aba === 'consolidacao') carregarConsolidacaoLista();
  if (aba === 'solicitacoes') carregarSolicitacoes();
  if (aba === 'acompanhamento') carregarAcompanhamento();
}

// 'pac-solicitacoes' é rotina própria (independente de 'pac-gestao') — quem
// abre esta página (já tem "ver" em pac-gestao) pode não ter acesso à aba de
// Solicitações. O servidor já barra (403) qualquer chamada sem essa rotina;
// aqui só escondemos a aba pra não oferecer algo que vai falhar na certa.
async function aplicarPermissaoSolicitacoes() {
  try {
    const r = await fetch('/api/auth/rotinas');
    if (!r.ok) return;
    const { rotinas } = await r.json();
    const sol = (rotinas || []).find(x => x.slug === 'pac-solicitacoes');
    if (!sol || !sol.ver) document.querySelector('#pac-tabs [data-tab="solicitacoes"]')?.remove();
  } catch {}
}

// Link "Importação" da sidebar — acesso é só por role (master/admin_sistema),
// não Perfil/Rotina (ver routes/pac-importacao.js), então essa checagem é à
// parte de aplicarPermissaoSolicitacoes() acima.
async function aplicarAcessoImportacao() {
  try {
    const user = await window.getCurrentUser();
    if (user && (user.username === 'master' || user.role === 'admin_sistema')) {
      document.getElementById('nav-pac-importacao').style.display = '';
    }
  } catch {}
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

  await renderItensDfd(dfd.colunas);
}

// "Setores participantes"/"Colunas ativas" são configuração pontual do DFD,
// não algo que se consulta toda vez que se abre a tela — ficam isoladas num
// modal à parte (Alex: "esta aba está errada... configurações devem ficar
// isolados"), carregadas só quando o modal realmente abre.
function abrirConfigDfd() {
  document.getElementById('modal-dfd-config').classList.add('open');
  renderGridSetoresDfd();
  renderGridColunasDfd();
}

function fecharConfigDfd() {
  document.getElementById('modal-dfd-config').classList.remove('open');
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

  // "Nº" primeiro, "Setor" segundo — mesma ordem de sempre em Lançamento
  // (onde Nº é a 1ª coluna fixa; Setor nem existe lá, é escopo de um setor só).
  // Tinha ficado invertido aqui (Setor antes de Nº), único lugar do sistema
  // assim — Alex reportou como "setor e número estão invertidos".
  const colunaNumero = colunas.find(c => c.slug === 'numero_item');
  const colunasResto = colunas.filter(c => c.slug !== 'numero_item');

  document.getElementById('dfd-det-itens-thead').innerHTML =
    `<tr><th>${colunaNumero ? colunaNumero.label : 'Nº'}</th><th>Setor</th>${colunasResto.map(c => `<th>${c.label}</th>`).join('')}${temColContrato ? '<th>Contrato</th>' : ''}</tr>`;

  document.getElementById('dfd-det-itens-tbody').innerHTML = itens.map(item => `
    <tr>
      <td>${item.numero_item}</td>
      <td>${nomeSetor(item.setor_id)}</td>
      ${colunasResto.map(c => `<td>${formatarValorColuna(c, item.valores[c.id])}</td>`).join('')}
      ${temColContrato ? celulaContratoLeitura(item, colunasContrato, todasColunas) : ''}
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
const ICONE_CONTRATO_PENDENTE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a15c00" stroke-width="2"><path d="M12 9v4"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L14.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 17h.01"/></svg>`;
const ICONE_CONTRATO_NAO_INFORMADO = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" stroke-width="1.5" stroke-dasharray="3 2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;

// Só leitura aqui (quem edita é o gestor em Lançamento) — badge com texto
// já visível, sem depender de hover; o tooltip complementa listando os
// dados quando preenchido. "possui_contrato" (grupo B) é a fonte da verdade
// do estado — distingue "Não" deliberado de "ainda não respondido"
// (mesma lógica de estadoContrato() em pac-lancamento.js).
function celulaContratoLeitura(item, colunasContrato, todasColunas) {
  const possuiCol = todasColunas.find(c => c.slug === 'possui_contrato');
  const v = possuiCol ? item.valores[possuiCol.id] : null;
  const estado = v === 'Sim' ? 'sim' : v === 'Não' ? 'nao' : v === 'Não informado' ? 'nao_informado' : 'pendente';
  const preenchidos = colunasContrato.filter(c => {
    const val = item.valores[c.id];
    return val !== null && val !== undefined && val !== '';
  });
  const cfg = {
    sim: { icone: ICONE_CONTRATO_SIM, texto: 'Com contrato', titulo: preenchidos.map(c => `${c.label}: ${formatarValorColuna(c, item.valores[c.id])}`).join(' · ') || 'Com contrato' },
    nao: { icone: ICONE_CONTRATO_NAO, texto: 'Sem contrato', titulo: 'Este item não tem contrato' },
    nao_informado: { icone: ICONE_CONTRATO_NAO_INFORMADO, texto: 'Não informado', titulo: 'Dado histórico importado sem essa informação na planilha original' },
    pendente: { icone: ICONE_CONTRATO_PENDENTE, texto: 'Pendente', titulo: 'O setor ainda não informou se este item tem contrato' },
  }[estado];
  return `<td style="text-align:center;"><span class="badge-contrato ${estado}" title="${cfg.titulo}">${cfg.icone} ${cfg.texto}</span></td>`;
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
  ['natureza_orcamentaria', 'Natureza Orçamentária'],
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

/* ── Execução do PAC: helpers compartilhados (Consolidação/Solicitações/Acompanhamento) ── */

function parseMoeda(s) {
  if (s === null || s === undefined || s === '') return 0;
  const v = parseFloat(String(s).replace(/[R$\s.]/g, '').replace(',', '.'));
  return isNaN(v) ? 0 : v;
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

// Popula os 2 seletores de "DFD (exercício)" (Solicitações e Acompanhamento) —
// só faz sentido trabalhar execução em cima de um DFD já fechado (é quando a
// consolidação existe), mas a lista aceita qualquer DFD: solicitação pode ser
// registrada mesmo antes da consolidação (o vínculo é por item_id, não por
// numero_pac — sobrevive à consolidação/recálculo que vier depois).
async function popularSelectDfdsExecucao() {
  if (!_dfds.length) await carregarDfds();
  const opts = _dfds.map(d => `<option value="${d.id}">${d.titulo} (${d.ano_base})</option>`).join('');
  const solSel = document.getElementById('sol-dfd-select');
  const acompSel = document.getElementById('acomp-dfd-select');
  if (solSel) solSel.innerHTML = opts;
  if (acompSel) acompSel.innerHTML = opts;

  try {
    const [setoresRes, naturezaRes] = await Promise.all([
      fetch('/api/pac/setores'),
      fetch('/api/pac/parametros?lista=natureza_orcamentaria'),
    ]);
    const setores = setoresRes.ok ? await setoresRes.json() : [];
    const setorSel = document.getElementById('sol-setor-select');
    if (setorSel) setorSel.innerHTML = setores.filter(s => s.ativo).map(s => `<option value="${s.id}">${s.nome}</option>`).join('');
    const filtroSetor = document.getElementById('acomp-filtro-setor');
    if (filtroSetor) filtroSetor.innerHTML = `<option value="">Todos</option>` + setores.map(s => `<option value="${s.id}">${s.nome}</option>`).join('');

    const naturezas = naturezaRes.ok ? await naturezaRes.json() : [];
    const naturezaSel = document.getElementById('sol-natureza-select');
    if (naturezaSel) {
      naturezaSel.innerHTML = naturezas.filter(n => n.ativo).map(n => `<option value="${n.valor}">${n.valor}</option>`).join('')
        || `<option value="">Nenhuma cadastrada em Parâmetros</option>`;
    }
  } catch {}
}

/* ── Consolidação ─────────────────────────────────────────────────────────── */

async function carregarConsolidacaoLista() {
  document.getElementById('consol-lista').style.display = 'block';
  document.getElementById('consol-detalhe').style.display = 'none';
  if (!_dfds.length) await carregarDfds();
  const fechados = _dfds.filter(d => d.status === 'fechado');
  const tbody = document.getElementById('consol-tbody');
  if (!fechados.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum DFD fechado ainda.</td></tr>`;
    return;
  }
  tbody.innerHTML = `<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-subtle);">Carregando...</td></tr>`;
  const linhas = await Promise.all(fechados.map(async d => {
    const res = await fetch(`/api/pac/dfds/${d.id}/consolidado`);
    const info = res.ok ? await res.json() : { consolidado: false };
    return { dfd: d, info };
  }));
  tbody.innerHTML = linhas.map(({ dfd, info }) => `
    <tr>
      <td><strong>${dfd.titulo}</strong></td>
      <td>${dfd.ano_base}</td>
      <td>${dfd.itens_count}</td>
      <td>${info.consolidado
        ? `Consolidado em ${fmtBrData(info.consolidacao.consolidado_em)}`
        : `<span class="text-muted">Não consolidado</span>`}</td>
      <td style="text-align:right;white-space:nowrap;">
        ${info.consolidado
          ? `<button class="btn btn-secondary btn-sm" onclick="abrirConsolidadoDetalhe(${dfd.id},'${(dfd.titulo || '').replace(/'/g, "\\'")}',${dfd.ano_base})">Ver consolidado</button>`
          : `<button class="btn btn-primary btn-sm" onclick="consolidarDfd(${dfd.id},'${(dfd.titulo || '').replace(/'/g, "\\'")}',${dfd.ano_base},${dfd.itens_count})">Consolidar agora</button>`}
      </td>
    </tr>
  `).join('');
}

async function consolidarDfd(dfdId, titulo, anoBase, totalItens) {
  if (!confirm(`Isso atribuirá números PAC a todos os ${totalItens} itens do DFD "${titulo}". Deseja continuar?`)) return;
  try {
    const res = await fetch(`/api/pac/dfds/${dfdId}/consolidar`, { method: 'POST' });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    toast('DFD consolidado.');
    abrirConsolidadoDetalhe(dfdId, titulo, anoBase);
    carregarConsolidacaoLista();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

let _consolDfdId = null;

async function abrirConsolidadoDetalhe(dfdId, titulo, anoBase) {
  _consolDfdId = dfdId;
  document.getElementById('consol-lista').style.display = 'none';
  document.getElementById('consol-detalhe').style.display = 'block';
  document.getElementById('consol-det-titulo').textContent = `${titulo} (${anoBase}) — Consolidado`;
  await renderConsolidadoDetalhe();
}

function fecharConsolidadoDetalhe() {
  _consolDfdId = null;
  carregarConsolidacaoLista();
}

async function renderConsolidadoDetalhe() {
  const tbody = document.getElementById('consol-itens-tbody');
  tbody.innerHTML = `<tr><td colspan="8" style="padding:20px;text-align:center;color:var(--text-subtle);">Carregando...</td></tr>`;
  const res = await fetch(`/api/pac/dfds/${_consolDfdId}/consolidado`);
  const info = res.ok ? await res.json() : { itens: [] };
  const idDescricao = colunaId('descricao_objeto');
  const idTipo = colunaId('tipo');
  const idValorEstimado = colunaId('valor_estimado');
  const STATUS_OPCOES = ['Não Iniciado', 'Processado DEPLA', 'Fracionamento Aberto', 'Processo Finalizado', 'Cancelado'];
  tbody.innerHTML = info.itens.map(item => `
    <tr>
      <td><strong>${item.numero_pac || '—'}</strong></td>
      <td>${item.setor_nome}</td>
      <td>${item.numero_item}</td>
      <td>${item.valores[idDescricao] || '—'}</td>
      <td>${item.valores[idTipo] || '—'}</td>
      <td>${fmtMoeda(item.valores[idValorEstimado])}</td>
      <td>
        <select onchange="alterarStatusExecucao(${item.id}, this.value)">
          ${STATUS_OPCOES.map(s => `<option value="${s}" ${s === item.status_execucao ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </td>
      <td style="text-align:right;"><button class="btn btn-danger btn-sm" onclick="excluirItemConsolidado(${item.id})">Excluir</button></td>
    </tr>
  `).join('') || `<tr><td colspan="8" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item consolidado.</td></tr>`;
}

// idColunaCache: dfd_colunas_catalogo é fixo (mesmo catálogo pra todos os DFDs)
// — resolvido 1x no carregamento da página em vez de bater no back a cada render.
let _colunasCatalogo = null;
function colunaId(slug) {
  if (!_colunasCatalogo) return null; // ainda não carregado — chamadores tratam undefined normalmente
  const c = _colunasCatalogo.find(x => x.slug === slug);
  return c ? c.id : null;
}
(async () => {
  try {
    const res = await fetch('/api/pac/colunas');
    _colunasCatalogo = res.ok ? await res.json() : [];
  } catch { _colunasCatalogo = []; }
})();

async function alterarStatusExecucao(itemId, status) {
  try {
    const res = await fetch(`/api/pac/itens/${itemId}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status_execucao: status }),
    });
    if (!res.ok) throw new Error();
    toast('Status atualizado.');
  } catch {
    toast('Erro ao atualizar status', 'error');
    renderConsolidadoDetalhe();
  }
}

async function excluirItemConsolidado(itemId) {
  if (!confirm('O número PAC dos itens seguintes será recalculado automaticamente. Excluir este item?')) return;
  try {
    const res = await fetch(`/api/pac/itens/${itemId}/consolidado`, { method: 'DELETE' });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    toast('Item excluído e numeração recalculada.');
    renderConsolidadoDetalhe();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

/* ── Solicitações de contratação ─────────────────────────────────────────── */

let _solItensDoDfd = [];
let _solEditandoId = null;

async function carregarSolicitacoes() {
  const dfdId = document.getElementById('sol-dfd-select').value;
  if (!dfdId) return;
  cancelarEdicaoSolicitacao();

  try {
    const itensRes = await fetch(`/api/pac/dfds/${dfdId}/itens`);
    _solItensDoDfd = itensRes.ok ? await itensRes.json() : [];
    const idDescricao = colunaId('descricao_objeto');
    const itemSel = document.getElementById('sol-item-select');
    itemSel.innerHTML = '<option value="">— selecione o item —</option>' + _solItensDoDfd.map(i =>
      `<option value="${i.id}">${i.numero_pac || ('#' + i.numero_item)} — ${(i.valores[idDescricao] || 'sem descrição').substring(0, 60)}</option>`
    ).join('');
  } catch {}

  try {
    const res = await fetch(`/api/pac/dfds/${dfdId}/solicitacoes`);
    const solicitacoes = res.ok ? await res.json() : [];
    const contagemPorItem = {};
    solicitacoes.filter(s => !s.sem_pac).forEach(s => { contagemPorItem[s.item_id] = (contagemPorItem[s.item_id] || 0) + 1; });

    document.getElementById('sol-com-pac-tbody').innerHTML = solicitacoes.filter(s => !s.sem_pac).map(s => `
      <tr>
        <td><strong>${s.numero_pac || '—'}</strong>${contagemPorItem[s.item_id] > 1 ? `<span class="pac-cnt-solic">${contagemPorItem[s.item_id]}</span>` : ''}</td>
        <td>${s.numero_movimento || '—'}</td>
        <td>${s.numero_sei || '—'}</td>
        <td>${fmtBrData(s.data_requisicao)}</td>
        <td>${nomeSetorPac(s.setor_requisitante_id)}</td>
        <td>${fmtMoeda(s.valor_tu_mlp)}</td>
        <td>${fmtMoeda(s.valor_rdc)}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="editarSolicitacao(${s.id})">Editar</button>
          <button class="btn btn-danger btn-sm" onclick="excluirSolicitacao(${s.id})">Excluir</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="8" style="padding:16px;text-align:center;color:var(--text-subtle);">Nenhuma solicitação vinculada.</td></tr>`;

    document.getElementById('sol-sem-pac-tbody').innerHTML = solicitacoes.filter(s => s.sem_pac).map(s => `
      <tr>
        <td>${s.numero_movimento || '—'}</td>
        <td>${s.numero_sei || '—'}</td>
        <td>${fmtBrData(s.data_requisicao)}</td>
        <td>${nomeSetorPac(s.setor_requisitante_id)}</td>
        <td>${s.descricao_objeto || '—'}</td>
        <td>${fmtMoeda(s.valor_tu_mlp)}</td>
        <td>${fmtMoeda(s.valor_rdc)}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="editarSolicitacao(${s.id})">Editar</button>
          <button class="btn btn-danger btn-sm" onclick="excluirSolicitacao(${s.id})">Excluir</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="7" style="padding:16px;text-align:center;color:var(--text-subtle);">Nenhuma contratação não planejada.</td></tr>`;

    window._solicitacoesCache = solicitacoes;
  } catch {
    toast('Erro ao carregar solicitações', 'error');
  }
}

function nomeSetorPac(id) {
  const s = (_solSetoresCache || []).find(x => x.id === id);
  return s ? s.nome : (id ? `#${id}` : '—');
}
let _solSetoresCache = [];
(async () => {
  try { const r = await fetch('/api/pac/setores'); _solSetoresCache = r.ok ? await r.json() : []; } catch {}
})();

function solAtualizarVinculo() {
  const semPac = document.getElementById('sol-sem-pac').checked;
  document.getElementById('sol-vinculo-wrap').style.display = semPac ? 'none' : '';
  if (semPac) document.getElementById('sol-item-select').value = '';
}

function limparFormSolicitacao() {
  document.getElementById('sol-sem-pac').checked = false;
  solAtualizarVinculo();
  document.getElementById('sol-item-select').value = '';
  document.getElementById('sol-numero-movimento').value = '';
  document.getElementById('sol-numero-sei').value = '';
  document.getElementById('sol-data-requisicao').value = '';
  document.getElementById('sol-valor-tu-mlp').value = '';
  document.getElementById('sol-valor-rdc').value = '';
  document.getElementById('sol-descricao').value = '';
  document.getElementById('sol-observacao').value = '';
}

function cancelarEdicaoSolicitacao() {
  _solEditandoId = null;
  document.getElementById('sol-btn-salvar').textContent = '+ Registrar solicitação';
  document.getElementById('sol-btn-cancelar').style.display = 'none';
  limparFormSolicitacao();
  document.getElementById('sol-msg').textContent = '';
}

function editarSolicitacao(id) {
  const s = (window._solicitacoesCache || []).find(x => x.id === id);
  if (!s) return;
  _solEditandoId = id;
  document.getElementById('sol-sem-pac').checked = !s.item_id;
  solAtualizarVinculo();
  document.getElementById('sol-item-select').value = s.item_id || '';
  document.getElementById('sol-numero-movimento').value = s.numero_movimento || '';
  document.getElementById('sol-numero-sei').value = s.numero_sei || '';
  document.getElementById('sol-data-requisicao').value = s.data_requisicao || '';
  document.getElementById('sol-setor-select').value = s.setor_requisitante_id || '';
  document.getElementById('sol-natureza-select').value = s.natureza_orcamentaria || '';
  document.getElementById('sol-valor-tu-mlp').value = s.valor_tu_mlp ? fmtMoeda(s.valor_tu_mlp).replace('R$', '').trim() : '';
  document.getElementById('sol-valor-rdc').value = s.valor_rdc ? fmtMoeda(s.valor_rdc).replace('R$', '').trim() : '';
  document.getElementById('sol-descricao').value = s.descricao_objeto || '';
  document.getElementById('sol-observacao').value = s.observacao || '';
  document.getElementById('sol-btn-salvar').textContent = 'Salvar edição';
  document.getElementById('sol-btn-cancelar').style.display = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function salvarSolicitacao() {
  const dfdId = document.getElementById('sol-dfd-select').value;
  const msg = document.getElementById('sol-msg');
  msg.style.color = '';
  const semPac = document.getElementById('sol-sem-pac').checked;
  const item_id = semPac ? null : (Number(document.getElementById('sol-item-select').value) || null);
  if (!semPac && !item_id) { msg.style.color = '#c00'; msg.textContent = 'Selecione o item do PAC ou marque "Sem vínculo".'; return; }

  const payload = {
    item_id,
    numero_movimento: document.getElementById('sol-numero-movimento').value.trim(),
    numero_sei: document.getElementById('sol-numero-sei').value.trim(),
    data_requisicao: document.getElementById('sol-data-requisicao').value || null,
    setor_requisitante_id: Number(document.getElementById('sol-setor-select').value) || null,
    natureza_orcamentaria: document.getElementById('sol-natureza-select').value || null,
    descricao_objeto: document.getElementById('sol-descricao').value.trim(),
    valor_tu_mlp: parseMoeda(document.getElementById('sol-valor-tu-mlp').value),
    valor_rdc: parseMoeda(document.getElementById('sol-valor-rdc').value),
    observacao: document.getElementById('sol-observacao').value.trim(),
  };

  try {
    const res = _solEditandoId
      ? await fetch(`/api/pac/solicitacoes/${_solEditandoId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      : await fetch(`/api/pac/dfds/${dfdId}/solicitacoes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    msg.style.color = '#2E7D32';
    msg.textContent = _solEditandoId ? 'Solicitação atualizada.' : 'Solicitação registrada.';
    cancelarEdicaoSolicitacao();
    carregarSolicitacoes();
  } catch (e) {
    msg.style.color = '#c00'; msg.textContent = 'Erro: ' + e.message;
  }
}

async function excluirSolicitacao(id) {
  if (!confirm('Excluir esta solicitação?')) return;
  try {
    const res = await fetch(`/api/pac/solicitacoes/${id}`, { method: 'DELETE' });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    carregarSolicitacoes();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

/* ── Acompanhamento (DEPLA — visão completa) ─────────────────────────────── */

let _acompDados = null;

async function carregarAcompanhamento() {
  const dfdId = document.getElementById('acomp-dfd-select').value;
  if (!dfdId) return;
  document.getElementById('acomp-tbody').innerHTML = `<tr><td colspan="13" style="padding:20px;text-align:center;color:var(--text-subtle);">Carregando...</td></tr>`;
  try {
    const res = await fetch(`/api/pac/dfds/${dfdId}/acompanhamento`);
    if (!res.ok) throw new Error();
    _acompDados = await res.json();
    renderTabelaAcompanhamento();
  } catch {
    toast('Erro ao carregar acompanhamento', 'error');
  }
}

function renderTabelaAcompanhamento() {
  if (!_acompDados) return;
  const filtroSetor = document.getElementById('acomp-filtro-setor').value;
  const filtroStatus = document.getElementById('acomp-filtro-status').value;
  const filtroFonte = document.getElementById('acomp-filtro-fonte').value;

  const itens = _acompDados.itens.filter(i =>
    (!filtroSetor || String(i.setor_id) === filtroSetor) &&
    (!filtroStatus || i.status_execucao === filtroStatus) &&
    (!filtroFonte || i.fonte_pagadora === filtroFonte)
  );

  const linhaSaldo = v => v < 0 ? `<span class="pac-saldo-neg">${fmtMoeda(v)}</span>` : fmtMoeda(v);

  document.getElementById('acomp-tbody').innerHTML = itens.map(item => `
    <tr>
      <td class="acomp-toggle" onclick="toggleAcompLinha(${item.item_id})">${item.solicitacoes.length ? '▸' : ''}</td>
      <td><strong>${item.numero_pac || '—'}</strong></td>
      <td>${item.setor_nome}</td>
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
      <td colspan="13">
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
  `).join('') || `<tr><td colspan="13" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item consolidado ainda para este DFD.</td></tr>`;

  const t = itens.reduce((acc, i) => ({
    estimado_tu_mlp: acc.estimado_tu_mlp + i.estimado_tu_mlp, estimado_rdc: acc.estimado_rdc + i.estimado_rdc,
    realizado_tu_mlp: acc.realizado_tu_mlp + i.realizado_tu_mlp, realizado_rdc: acc.realizado_rdc + i.realizado_rdc,
    saldo_tu_mlp: acc.saldo_tu_mlp + i.saldo_tu_mlp, saldo_rdc: acc.saldo_rdc + i.saldo_rdc,
  }), { estimado_tu_mlp: 0, estimado_rdc: 0, realizado_tu_mlp: 0, realizado_rdc: 0, saldo_tu_mlp: 0, saldo_rdc: 0 });
  document.getElementById('acomp-tfoot').innerHTML = `
    <tr>
      <td colspan="5">Totais (${itens.length} itens)</td>
      <td>${fmtMoeda(t.estimado_tu_mlp)}</td><td>${fmtMoeda(t.estimado_rdc)}</td>
      <td colspan="2"></td>
      <td>${fmtMoeda(t.realizado_tu_mlp)}</td><td>${fmtMoeda(t.realizado_rdc)}</td>
      <td>${linhaSaldo(t.saldo_tu_mlp)}</td><td>${linhaSaldo(t.saldo_rdc)}</td>
    </tr>
  `;

  const semPacCard = document.getElementById('acomp-sem-pac-card');
  const semPac = _acompDados.sem_pac || [];
  semPacCard.style.display = semPac.length ? 'block' : 'none';
  document.getElementById('acomp-sem-pac-tbody').innerHTML = semPac.map(s => `
    <tr>
      <td>${s.numero_movimento || '—'}</td>
      <td>${s.numero_sei || '—'}</td>
      <td>${fmtBrData(s.data_requisicao)}</td>
      <td>${nomeSetorPac(s.setor_requisitante_id)}</td>
      <td>${s.descricao_objeto || '—'}</td>
      <td>${fmtMoeda(s.valor_tu_mlp)}</td>
      <td>${fmtMoeda(s.valor_rdc)}</td>
    </tr>
  `).join('');
}

function toggleAcompLinha(itemId) {
  document.getElementById(`acomp-sub-${itemId}`)?.classList.toggle('hidden');
}
