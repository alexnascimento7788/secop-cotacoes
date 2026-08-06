// Módulo Depop — ferramenta de validação de contratos (Setor de Cadastro).
// auth.js já garantiu que o módulo ativo é o Depop antes daqui.

// ── 1º acesso: CPF + senha de assinatura ──────────────────────────────────────

// Validação de CPF pelos dígitos verificadores (espelha o servidor em cpfValido).
function cpfValidoClient(cpf) {
  cpf = String(cpf || '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const dv = (fator) => {
    let soma = 0;
    for (let i = 0; i < fator - 1; i++) soma += parseInt(cpf[i], 10) * (fator - i);
    const resto = 11 - (soma % 11);
    return resto >= 10 ? 0 : resto;
  };
  return dv(10) === parseInt(cpf[9], 10) && dv(11) === parseInt(cpf[10], 10);
}

function mascararCpf(v) {
  return String(v).replace(/\D/g, '').slice(0, 11)
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
}

function _mostrar(id) {
  ['depop-loader', 'depop-setup', 'depop-content'].forEach(x => {
    document.getElementById(x).style.display = x === id ? '' : 'none';
  });
}

async function salvarPerfilDepop() {
  const msg    = document.getElementById('dp-setup-msg');
  const btn    = document.getElementById('dp-setup-btn');
  const cpf    = document.getElementById('dp-cpf').value;
  const senha  = document.getElementById('dp-senha').value;
  const senha2 = document.getElementById('dp-senha2').value;
  msg.style.color = 'var(--vermelho)';

  if (!cpfValidoClient(cpf)) { msg.textContent = 'CPF inválido.'; return; }
  if (!senha || senha.length < 6) { msg.textContent = 'A senha de assinatura deve ter ao menos 6 caracteres.'; return; }
  if (senha !== senha2) { msg.textContent = 'As senhas não conferem.'; return; }

  btn.disabled = true; btn.textContent = 'Salvando...';
  try {
    const res = await fetch('/api/depop/perfil', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cpf, senha_assinatura: senha })
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Erro ao salvar'); }
    _mostrar('depop-content'); bootApp();
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Salvar e continuar';
  }
}

// ── App de validação ──────────────────────────────────────────────────────────

const estado = { perfil: 'validador', contratos: [], aba: 'painel', cidade: '', busca: '', expandido: new Set() };
let _det = null;          // contrato aberto no preview
let _lockMine = false;    // se a trava do contrato aberto é minha (validador)
let _pingTimer = null;

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtMoeda = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum   = v => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtData  = iso => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); };

async function initDepop() {
  try {
    const res = await fetch('/api/depop/perfil');
    if (res.status === 401) { window.location.replace('/login.html'); return; }
    if (res.status === 403) { window.location.replace('/selecionar-modulo.html'); return; }
    const data = await res.json();
    estado.perfil = data.perfil || 'validador';
    if (data.precisa_setup) { _mostrar('depop-setup'); return; }
    _mostrar('depop-content');
    bootApp();
  } catch {
    _mostrar('depop-content'); bootApp();
  }
}

function bootApp() {
  // Abas
  document.querySelectorAll('#dp-tabs .page-tab').forEach(t => {
    t.addEventListener('click', () => trocarAba(t.dataset.tab));
  });
  document.getElementById('dp-filtro-cidade').addEventListener('change', e => { estado.cidade = e.target.value; renderLista(); });
  document.getElementById('dp-busca').addEventListener('input', e => { estado.busca = e.target.value.toLowerCase().trim(); renderLista(); });
  document.getElementById('dp-btn-export-massa').addEventListener('click', exportarMassa);
  if (estado.perfil === 'master') document.getElementById('dp-btn-export-massa').style.display = '';
  window.addEventListener('beforeunload', () => {
    if (_det && _lockMine && navigator.sendBeacon) navigator.sendBeacon(`/api/depop/contratos/${_det.id}/fechar`);
  });
  carregarDashboard();
  carregarContratos();
}

function trocarAba(aba) {
  estado.aba = aba;
  document.querySelectorAll('#dp-tabs .page-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === aba));
  const ehPainel = aba === 'painel';
  document.getElementById('pane-painel').classList.toggle('active', ehPainel);
  document.getElementById('pane-lista').classList.toggle('active', !ehPainel);
  if (!ehPainel) renderLista();
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function carregarDashboard() {
  let d;
  try { d = await (await fetch('/api/depop/dashboard')).json(); } catch { return; }

  document.getElementById('dp-cards').innerHTML = `
    <div class="metric-card metric-cotacao">
      <div class="metric-card-top"><span class="metric-icon">📄</span><span class="metric-label">Contratos</span></div>
      <div class="metric-value metric-val-cotacao">${d.total_contratos}</div>
      <div class="metric-hint">${d.total_concessionarios} concessionários</div>
    </div>
    <div class="metric-card metric-concluido">
      <div class="metric-card-top"><span class="metric-icon">✅</span><span class="metric-label">Validados</span></div>
      <div class="metric-value metric-val-concluido">${d.validados}</div>
      <div class="metric-hint">${d.pct_validacao}% do total</div>
    </div>
    <div class="metric-card metric-aprovacao">
      <div class="metric-card-top"><span class="metric-icon">🕐</span><span class="metric-label">Em aberto</span></div>
      <div class="metric-value metric-val-aprovacao">${d.em_aberto}</div>
      <div class="metric-hint">aguardando conferência</div>
    </div>
    <div class="metric-card metric-parado">
      <div class="metric-card-top"><span class="metric-icon">⚠️</span><span class="metric-label">Errados</span></div>
      <div class="metric-value metric-val-parado">${d.errados}</div>
      <div class="metric-hint">marcados com divergência</div>
    </div>`;

  // Gráfico de barras por cidade (contratos + concessionários)
  const maxC = Math.max(1, ...d.por_cidade.map(c => c.contratos));
  document.getElementById('dp-chart').innerHTML =
    `<div class="dp-chart-legend">
       <span><span class="dp-legend-sw" style="background:var(--verde)"></span>Contratos</span>
       <span><span class="dp-legend-sw" style="background:var(--amarelo)"></span>Concessionários</span>
     </div>` +
    d.por_cidade.map(c => `
      <div class="dp-bar-row">
        <div class="dp-bar-city" title="${esc(c.cidade)}">${esc(c.cidade)}</div>
        <div class="dp-bar-pair">
          <div class="dp-bar"><div class="dp-bar-track"><div class="dp-bar-fill contratos" style="width:${(c.contratos / maxC) * 100}%"></div></div><div class="dp-bar-val">${c.contratos}</div></div>
          <div class="dp-bar"><div class="dp-bar-track"><div class="dp-bar-fill concessionarios" style="width:${(c.concessionarios / maxC) * 100}%"></div></div><div class="dp-bar-val">${c.concessionarios}</div></div>
        </div>
      </div>`).join('');

  document.getElementById('dp-mini').innerHTML = `
    <div class="dp-mini"><div class="dp-mini-label">Linhas de tarifa</div><div class="dp-mini-value">${d.total_linhas}</div><div class="dp-mini-hint">${d.media_linhas_por_contrato} por contrato</div></div>
    <div class="dp-mini"><div class="dp-mini-label">Metragem total</div><div class="dp-mini-value">${fmtNum(d.metragem_total)}</div><div class="dp-mini-hint">m²</div></div>
    <div class="dp-mini"><div class="dp-mini-label">Sem linhas</div><div class="dp-mini-value">${d.sem_linha}</div><div class="dp-mini-hint">contratos a revisar</div></div>
    <div class="dp-mini"><div class="dp-mini-label">Tarifa atual (méd.)</div><div class="dp-mini-value">${fmtMoeda(d.media_tarifa_atual)}</div><div class="dp-mini-hint">por m²</div></div>
    <div class="dp-mini"><div class="dp-mini-label">Nova tarifa (méd.)</div><div class="dp-mini-value">${fmtMoeda(d.media_tarifa_nova)}</div><div class="dp-mini-hint">por m²</div></div>
    <div class="dp-mini"><div class="dp-mini-label">% validação</div><div class="dp-mini-value">${d.pct_validacao}%</div><div class="dp-mini-hint">${d.validados}/${d.total_contratos}</div></div>`;

  document.getElementById('dp-ranking').innerHTML = d.ranking_pior.map(r => `
    <div class="setor-bar-row">
      <div class="setor-label" title="${esc(r.cidade)}">${esc(r.cidade)}</div>
      <div class="setor-bar-track"><div class="setor-bar-fill" style="width:${r.pct}%"></div></div>
      <div class="setor-count">${r.pct}%</div>
    </div>`).join('') || '<div class="empty-state" style="padding:16px;">Sem dados</div>';
}

// ── Lista ─────────────────────────────────────────────────────────────────────
async function carregarContratos() {
  let data;
  try { data = await (await fetch('/api/depop/contratos')).json(); } catch { return; }
  estado.perfil = data.perfil || estado.perfil;
  estado.contratos = data.contratos || [];

  // Contadores das abas (totais por status)
  const cont = { pendente: 0, validado: 0, errado: 0 };
  estado.contratos.forEach(c => { cont[c.status] = (cont[c.status] || 0) + 1; });
  document.getElementById('cnt-pendente').textContent = cont.pendente;
  document.getElementById('cnt-validado').textContent = cont.validado;
  document.getElementById('cnt-errado').textContent = cont.errado;

  // Filtro de cidade
  const sel = document.getElementById('dp-filtro-cidade');
  const cidades = [...new Set(estado.contratos.map(c => c.cidade))].sort();
  const atual = estado.cidade;
  sel.innerHTML = '<option value="">Todas as cidades</option>' + cidades.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  sel.value = atual;

  if (estado.aba !== 'painel') renderLista();
}

const _rotulo = s => ({ pendente: 'A validar', validado: 'Assinado', errado: 'Errado' })[s] || s;

// Badges de resumo de um concessionário (total azul + por status).
function rollupBadges(cnt) {
  let b = `<span class="dp-group-tag">${cnt.total} contrato${cnt.total > 1 ? 's' : ''}</span>`;
  if (cnt.validado) b += `<span class="badge badge-validado">${cnt.validado} validado${cnt.validado > 1 ? 's' : ''}</span>`;
  if (cnt.pendente) b += `<span class="badge badge-pendente">${cnt.pendente} a validar</span>`;
  if (cnt.errado)   b += `<span class="badge badge-errado">${cnt.errado} errado${cnt.errado > 1 ? 's' : ''}</span>`;
  return b;
}

// Uma linha de contrato (comNome=true mostra o concessionário na 1ª coluna;
// filho=true é linha dentro de um grupo expandido, indentada).
function rowContrato(c, comNome, filho) {
  const bloqueado = c.lock && !c.lock.por_mim;
  const sit = bloqueado
    ? `<span class="dp-lock-tag">🔒 em uso · ${esc(c.lock.nome)}</span>`
    : (c.lock && c.lock.por_mim ? '<span class="dp-mine-tag">aberto por você</span>' : `<span class="badge badge-${c.status}">${_rotulo(c.status)}</span>`);
  const nomeCel = comNome ? `<span class="dp-forn">${esc(c.concessionario)}</span>` : (filho ? '<span class="dp-child-mark">└</span>' : '');
  return `<tr class="dp-row${bloqueado ? ' locked' : ''}${filho ? ' dp-child' : ''}" data-id="${c.id}" data-bloq="${bloqueado ? 1 : 0}" data-lock="${bloqueado ? esc(c.lock.nome) : ''}">
    <td>${nomeCel}</td>
    <td>${esc(c.numero_ccu || '—')}</td>
    <td style="text-align:right">${fmtMoeda(c.valor_ponto)}</td>
    <td style="text-align:right">${fmtMoeda(c.valor_30_ceasa)}</td>
    <td style="text-align:right">${sit}</td>
  </tr>`;
}

function renderLista() {
  const alvo = document.getElementById('dp-lista');
  const aba = estado.aba; // pendente | validado | errado

  // Base filtrada só por cidade + busca (o STATUS não filtra o grupo: o
  // concessionário mostra todos os seus contratos, de qualquer status).
  let base = estado.contratos.slice();
  if (estado.cidade) base = base.filter(c => c.cidade === estado.cidade);
  if (estado.busca) base = base.filter(c =>
    (c.concessionario || '').toLowerCase().includes(estado.busca) ||
    (c.numero_ccu || '').toLowerCase().includes(estado.busca));

  // Agrupa por cidade → concessionário (codigo)
  const cidades = new Map();
  base.forEach(c => {
    if (!cidades.has(c.cidade)) cidades.set(c.cidade, new Map());
    const g = cidades.get(c.cidade);
    if (!g.has(c.codigo)) g.set(c.codigo, []);
    g.get(c.codigo).push(c);
  });

  let html = '';
  let totalVisivel = 0;
  for (const [cidade, grupos] of cidades) {
    let rows = '';
    let cityCount = 0;
    for (const [codigo, contratos] of grupos) {
      const cnt = { total: contratos.length, pendente: 0, validado: 0, errado: 0 };
      contratos.forEach(c => { cnt[c.status]++; });
      if (!cnt[aba]) continue; // grupo só aparece se tiver ≥1 contrato do status da aba
      cityCount += cnt[aba];

      if (contratos.length === 1) {
        rows += rowContrato(contratos[0], true, false);
      } else {
        const key = cidade + '|' + codigo;
        const aberto = estado.expandido.has(key);
        rows += `<tr class="dp-group-head" data-key="${esc(key)}">
          <td colspan="5"><span class="dp-chev">${aberto ? '▾' : '▸'}</span><span class="dp-forn">${esc(contratos[0].concessionario)}</span>${rollupBadges(cnt)}</td>
        </tr>`;
        if (aberto) contratos.forEach(c => { rows += rowContrato(c, false, true); });
      }
    }
    if (!cityCount) continue;
    totalVisivel += cityCount;
    html += `<div class="dp-city-block card">
      <div class="card-header"><span class="card-title">${esc(cidade)}</span><span class="page-tab-count">${cityCount}</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Concessionário</th><th>CCU</th><th style="text-align:right">Valor do Ponto</th><th style="text-align:right">Outorga (30%)</th><th style="text-align:right">Situação</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  }

  if (!totalVisivel) {
    alvo.innerHTML = `<div class="card"><div class="empty-state"><p>Nenhum contrato ${({ pendente: 'a validar', validado: 'assinado', errado: 'marcado como errado' })[aba]} aqui.</p></div></div>`;
    return;
  }
  alvo.innerHTML = html;

  alvo.querySelectorAll('.dp-group-head').forEach(tr => tr.addEventListener('click', () => {
    const k = tr.dataset.key;
    if (estado.expandido.has(k)) estado.expandido.delete(k); else estado.expandido.add(k);
    renderLista();
  }));
  alvo.querySelectorAll('.dp-row').forEach(tr => tr.addEventListener('click', () => {
    if (tr.dataset.bloq === '1') { toast(`Contrato em uso por ${tr.dataset.lock}.`, 'error'); return; }
    abrirContrato(parseInt(tr.dataset.id, 10));
  }));
}

// ── Preview (Anexo I interno) ─────────────────────────────────────────────────
async function abrirContrato(id) {
  let res, data;
  try { res = await fetch(`/api/depop/contratos/${id}/abrir`, { method: 'POST' }); data = await res.json(); }
  catch { toast('Falha ao abrir o contrato.', 'error'); return; }
  if (res.status === 409) { toast(data.error || 'Contrato em uso.', 'error'); carregarContratos(); return; }
  if (!res.ok) { toast(data.error || 'Erro ao abrir.', 'error'); return; }

  _det = data.detalhe;
  _lockMine = !!(data.lock && data.lock.por_mim);
  document.getElementById('dp-doc').innerHTML = docInner(_det);
  renderPreviewActions();
  document.getElementById('dp-preview').style.display = 'flex';
  document.querySelector('.dp-paper-wrap').scrollTop = 0;

  if (_lockMine) { clearInterval(_pingTimer); _pingTimer = setInterval(() => fetch(`/api/depop/contratos/${_det.id}/ping`, { method: 'POST' }).catch(() => {}), 30000); }
}

function renderPreviewActions() {
  const box = document.getElementById('dp-preview-actions');
  const st = _det.validacao.status;
  const chip = `<span class="badge badge-${st}" style="align-self:center">${({ pendente: 'A validar', validado: 'Assinado', errado: 'Errado' })[st]}</span>`;
  if (estado.perfil === 'master') {
    box.innerHTML = chip + `<button class="btn btn-secondary btn-sm" onclick="imprimirIndividual()">🖨️ Exportar PDF</button>`;
  } else {
    box.innerHTML = chip +
      `<button class="btn btn-danger btn-sm" onclick="abrirModalErro()">Marcar como errado</button>` +
      `<button class="btn btn-primary btn-sm" onclick="abrirModalSenha()">Confirmar e assinar</button>`;
  }
}

async function fecharPreview() {
  clearInterval(_pingTimer); _pingTimer = null;
  if (_det && _lockMine) { try { await fetch(`/api/depop/contratos/${_det.id}/fechar`, { method: 'POST' }); } catch {} }
  document.getElementById('dp-preview').style.display = 'none';
  _det = null; _lockMine = false;
  carregarContratos();
}

// Invólucro "papel" (usado na impressão; no preview o próprio #dp-doc já é .dp-paper).
function docPaper(det) { return `<div class="dp-paper">${docInner(det)}</div>`; }

function docInner(det) {
  const linhas = det.linhas || [];
  const linhasHtml = linhas.length
    ? `<table class="dp-linhas">
        <thead><tr><th>Nome / Endereço</th><th class="num">Metragem (m²)</th><th class="num">Tarifa de uso atual</th><th class="num">Nova tarifa de uso</th></tr></thead>
        <tbody>${linhas.map(l => `<tr>
          <td>${esc([l.concessionario, l.endereco].filter(Boolean).join(' — '))}</td>
          <td class="num">${fmtNum(l.area_m2)}</td>
          <td class="num">${fmtMoeda(l.atual_tarifa_uso)}</td>
          <td class="num">${fmtMoeda(l.nova_tarifa_uso)}</td>
        </tr>`).join('')}</tbody>
      </table>`
    : `<div class="dp-empty-lines">Nenhuma linha encontrada para este contrato na tabela de tarifas.</div>`;

  const v = det.validacao;
  const assinado = v.status === 'validado';
  const dataDoc = assinado ? v.dt_validacao : new Date().toISOString();
  const assinaturaHtml = assinado
    ? `<span class="nome">${esc(v.validador || '')}</span><div class="timbre">Timbre: ${esc((v.hash_assinatura || '').slice(0, 12))}</div>`
    : `<span class="nome pendente">Aguardando validação</span>`;

  return `
    <div class="dp-doc-head">
      <img src="img/Ceasa_Signea.png" alt="CEASAMINAS" onerror="this.style.display='none'"/>
      <div class="dp-doc-org">CEASAMINAS<small>Centrais de Abastecimento de Minas Gerais</small></div>
      <div class="dp-doc-title"><strong>Anexo I — Conferência</strong>Setor de Cadastro</div>
    </div>

    <div class="dp-abertura">
      Este documento apresenta os dados do contrato extraídos da planilha original, para conferência do
      <strong>Setor de Cadastro / Departamento de Operações</strong>. Confira os valores destacados abaixo —
      <strong>Valor do Ponto</strong> e <strong>Outorga (30%)</strong> — antes de confirmar.
    </div>

    <div class="dp-sec-title">Resumo do contrato</div>
    <div class="dp-resumo">
      <div class="dp-field"><label>Código</label><span>${esc(det.codigo)}</span></div>
      <div class="dp-field"><label>CCU</label><span>${esc(det.numero_ccu || '—')}</span></div>
      <div class="dp-field full"><label>Concessionário</label><span>${esc(det.concessionario || '—')}</span></div>
      <div class="dp-field full"><label>Endereço</label><span>${esc(det.endereco || '—')}${det.bairro ? ' — ' + esc(det.bairro) : ''}${det.cep ? ' — CEP ' + esc(det.cep) : ''}</span></div>
      <div class="dp-field"><label>CNPJ / CPF</label><span>${esc(det.cpf_cnpj || '—')}</span></div>
      <div class="dp-field"><label>Inscrição Estadual</label><span>${esc(det.insc_estadual || '—')}</span></div>
      <div class="dp-field"><label>Cidade</label><span>${esc(det.cidade || '—')}</span></div>
      <div class="dp-field"><label>Vencimento</label><span>${det.data_vencimento ? esc(det.data_vencimento) : '—'}</span></div>
    </div>

    <div class="dp-valores">
      <div class="dp-valor-box"><div class="lbl">Valor do Ponto</div><div class="val">${fmtMoeda(det.valor_ponto)}</div></div>
      <div class="dp-valor-box"><div class="lbl">Outorga (30%)</div><div class="val">${fmtMoeda(det.valor_30_ceasa)}</div></div>
    </div>

    <div class="dp-sec-title">Linhas deste contrato (unidades / boxes)</div>
    ${linhasHtml}

    <div class="dp-selo">⚖️ Os valores acima estão sob conferência do Setor de Cadastro da CEASAMINAS.</div>

    <div class="dp-doc-foot">
      <div>Local: Contagem/MG — CEASAMINAS<br>Data: ${fmtData(dataDoc)}</div>
      <div class="dp-assinatura">${assinaturaHtml}</div>
    </div>`;
}

// ── Ações: assinar / marcar erro ──────────────────────────────────────────────
function abrirModalSenha() {
  document.getElementById('dp-senha-assinatura').value = '';
  document.getElementById('dp-senha-msg').textContent = '';
  document.getElementById('dp-modal-senha').classList.add('open');
  setTimeout(() => document.getElementById('dp-senha-assinatura').focus(), 50);
}
function abrirModalErro() {
  document.getElementById('dp-erro-obs').value = '';
  document.getElementById('dp-erro-msg').textContent = '';
  document.getElementById('dp-modal-erro').classList.add('open');
  setTimeout(() => document.getElementById('dp-erro-obs').focus(), 50);
}
function fecharModal(id) { document.getElementById(id).classList.remove('open'); }

async function confirmarAssinatura() {
  const senha = document.getElementById('dp-senha-assinatura').value;
  const msg = document.getElementById('dp-senha-msg');
  const btn = document.getElementById('dp-btn-assinar');
  if (!senha) { msg.textContent = 'Informe a senha de assinatura.'; return; }
  btn.disabled = true; btn.textContent = 'Assinando...';
  try {
    const res = await fetch(`/api/depop/contratos/${_det.id}/validar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha_assinatura: senha })
    });
    const data = await res.json();
    if (!res.ok) { msg.textContent = data.error || 'Erro ao assinar.'; return; }
    fecharModal('dp-modal-senha');
    toast('Contrato validado e assinado.', 'success');
    _lockMine = false; // servidor já liberou a trava
    await fecharPreview();
    carregarDashboard();
  } catch { msg.textContent = 'Falha de conexão.'; }
  finally { btn.disabled = false; btn.textContent = 'Assinar'; }
}

async function confirmarErro() {
  const obs = document.getElementById('dp-erro-obs').value.trim();
  const msg = document.getElementById('dp-erro-msg');
  const btn = document.getElementById('dp-btn-erro');
  if (!obs) { msg.textContent = 'Descreva o motivo do erro.'; return; }
  btn.disabled = true; btn.textContent = 'Salvando...';
  try {
    const res = await fetch(`/api/depop/contratos/${_det.id}/errado`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ observacao: obs })
    });
    const data = await res.json();
    if (!res.ok) { msg.textContent = data.error || 'Erro ao salvar.'; return; }
    fecharModal('dp-modal-erro');
    toast('Contrato marcado como errado.', 'success');
    _lockMine = false;
    await fecharPreview();
    carregarDashboard();
  } catch { msg.textContent = 'Falha de conexão.'; }
  finally { btn.disabled = false; btn.textContent = 'Confirmar erro'; }
}

// ── Impressão / PDF (impressão do navegador → salvar como PDF) ─────────────────
function imprimirDocs(dets) {
  document.getElementById('dp-print').innerHTML = dets.map(docPaper).join('');
  const limpar = () => { document.getElementById('dp-print').innerHTML = ''; window.removeEventListener('afterprint', limpar); };
  window.addEventListener('afterprint', limpar);
  window.print();
}
function imprimirIndividual() { if (_det) imprimirDocs([_det]); }

async function exportarMassa() {
  if (estado.perfil !== 'master') return;
  const btn = document.getElementById('dp-btn-export-massa');
  const status = estado.aba === 'painel' ? '' : estado.aba;
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (estado.cidade) qs.set('cidade', estado.cidade);
  btn.disabled = true; const txt = btn.textContent; btn.textContent = 'Gerando...';
  try {
    const data = await (await fetch('/api/depop/exportar?' + qs.toString())).json();
    if (!data.detalhes || !data.detalhes.length) { toast('Nenhum contrato no filtro atual.', 'error'); return; }
    imprimirDocs(data.detalhes);
  } catch { toast('Falha ao exportar.', 'error'); }
  finally { btn.disabled = false; btn.textContent = txt; }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, tipo) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (tipo ? ' ' + tipo : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
}

document.addEventListener('DOMContentLoaded', () => {
  const cpfInp = document.getElementById('dp-cpf');
  if (cpfInp) cpfInp.addEventListener('input', () => { cpfInp.value = mascararCpf(cpfInp.value); });
  initDepop();
});
