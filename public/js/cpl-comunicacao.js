// CPL — Comunicação Concessionários (parcelamento da outorga). Tela única:
// métricas + lista + envio (individual/seleção/massa) + autorizar/
// desautorizar + registrar retorno. Carga inicial e a importação de
// "parcelamento já informado" foram feitas 1x direto no banco (ver
// [[project_secop_cpl_comunicacao]]) — não existe mais import nesta tela,
// o fluxo é só pela plataforma a partir de agora. Teste de envio/template
// fica em Admin → Comunicação → Templates (botão "Testar envio"), não aqui.
// Ver routes/cpl-comunicacao.js.

function toast(msg, tipo) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (tipo ? ' ' + tipo : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
}

let _cplLista = [];
const _cplExpandidos = new Set();
const _cplDetalheCache = new Map();
const _cplSelecionados = new Set();
const _cplConfirmandoDesfazer = new Set();
let _cplBuscaTimer = null;

const CPL_SITUACAO_LABEL = {
  pendente: 'Pendente de envio', aguardando: 'Aguardando resposta', retornado: 'Retornado',
  informado: 'Parcelamento informado', desabilitado: 'Desabilitado',
};

// Campo com hora (ultimo_envio_em, criado_em do envio) vem de datetime('now')
// do SQLite, que é sempre UTC — precisa converter pro fuso do Brasil antes de
// exibir. Campo só com data (data_aceite, vem de planilha, sem hora) não tem
// esse problema — mostra direto, sem conversão.
function fmtDataHoraBrCpl(iso) {
  if (!iso) return '—';
  const [data, hora] = String(iso).split(/[T ]/);
  const d = (data || '').split('-');
  if (d.length < 3) return String(iso);
  if (!hora) return `${d[2]}/${d[1]}/${d[0]}`;
  const dt = new Date(`${data}T${hora}Z`);
  if (isNaN(dt)) return String(iso);
  return dt.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function cplFiltrarDebounce() {
  clearTimeout(_cplBuscaTimer);
  _cplBuscaTimer = setTimeout(cplCarregar, 300);
}

async function cplCarregarMetricas() {
  try {
    const m = await fetch('/api/cpl-comunicacao/metricas').then(r => r.json());
    const filtroAtual = document.getElementById('cpl-filtro-status').value;
    const cards = [
      ['', 'Total', m.total],
      ['pendente', 'Pendente de envio', m.pendente],
      ['aguardando', 'Aguardando resposta', m.aguardando],
      ['retornado', 'Retornado', m.retornado],
      ['informado', 'Parcelamento informado', m.informado],
    ];
    document.getElementById('cpl-kpis').innerHTML = cards.map(([valor, label, num]) => `
      <div class="cpl-kpi${filtroAtual === valor ? ' ativo' : ''}" onclick="cplFiltrarPorKpi('${valor}')">
        <div class="cpl-kpi-num">${num}</div>
        <div class="cpl-kpi-label">${label}</div>
      </div>
    `).join('');
  } catch {}
}

function cplFiltrarPorKpi(status) {
  document.getElementById('cpl-filtro-status').value = status;
  cplCarregar();
}

async function cplCarregar() {
  const tbody = document.getElementById('cpl-tbody');
  const busca = document.getElementById('cpl-busca').value.trim();
  const status = document.getElementById('cpl-filtro-status').value;
  const params = new URLSearchParams();
  if (busca) params.set('busca', busca);
  if (status) params.set('status', status);
  try {
    _cplLista = await fetch(`/api/cpl-comunicacao/concessionarios?${params}`).then(r => r.json());
    cplRenderTabela();
    cplCarregarMetricas();
  } catch {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--vermelho);padding:16px;">Erro ao carregar.</td></tr>';
  }
}

function cplRenderTabela() {
  const tbody = document.getElementById('cpl-tbody');
  if (!_cplLista.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#aaa;padding:16px;">Nenhum concessionário encontrado.</td></tr>';
    return;
  }
  tbody.innerHTML = _cplLista.map(c => {
    const expandido = _cplExpandidos.has(c.id);
    const podeEnviar = !!c.habilitado && !!c.autorizado_cpl;
    const botaoEnviar = podeEnviar
      ? `<button class="btn btn-secondary btn-sm" onclick="cplEnviarUm(${c.id})">Enviar</button>`
      : `<span style="color:var(--text-muted);font-size:11.5px;" title="Reabra o detalhe pra autorizar ou desfazer, se for o caso.">—</span>`;
    const linhas = [`
      <tr class="cpl-row" data-id="${c.id}">
        <td onclick="event.stopPropagation()"><input type="checkbox" ${_cplSelecionados.has(c.id) ? 'checked' : ''} onchange="cplToggleSelecionado(${c.id}, this.checked)"/></td>
        <td onclick="cplAlternarExpandir(${c.id})">${c.codigo}</td>
        <td onclick="cplAlternarExpandir(${c.id})">
          <div>${c.razao_social || '—'}</div>
          ${c.cnpj ? `<div style="font-size:10.5px;color:var(--text-muted);">${c.cnpj}</div>` : ''}
        </td>
        <td onclick="cplAlternarExpandir(${c.id})">${c.cidade || '—'}</td>
        <td onclick="cplAlternarExpandir(${c.id})">${c.numero_ccu}</td>
        <td onclick="cplAlternarExpandir(${c.id})">${fmtDataHoraBrCpl(c.data_aceite)}</td>
        <td onclick="cplAlternarExpandir(${c.id})"><span class="cpl-situacao ${c.situacao}">${CPL_SITUACAO_LABEL[c.situacao] || c.situacao}</span></td>
        <td onclick="cplAlternarExpandir(${c.id})">${c.envios_qtd}</td>
        <td onclick="cplAlternarExpandir(${c.id})">${fmtDataHoraBrCpl(c.ultimo_envio_em)}</td>
        <td onclick="event.stopPropagation()" style="white-space:nowrap;">${botaoEnviar}</td>
      </tr>
    `];
    if (expandido) linhas.push(cplRenderDetalheRow(c));
    return linhas.join('');
  }).join('');
  document.getElementById('cpl-sel-todos').checked = _cplLista.length > 0 && _cplLista.every(c => _cplSelecionados.has(c.id));
}

function cplRenderDetalheRow(c) {
  const det = _cplDetalheCache.get(c.id);
  if (!det) {
    return `<tr class="cpl-detalhe-row" data-detalhe-de="${c.id}"><td colspan="10">Carregando detalhes...</td></tr>`;
  }
  const envios = (det.envios || []).map(e => `
    <div class="cpl-envio-item">
      <span>${fmtDataHoraBrCpl(e.criado_em)}${e.teste ? ' <em>(teste)</em>' : ''}</span>
      <span>${e.status_envio || 'pendente'}${e.erro_msg ? ' — ' + e.erro_msg : ''}</span>
    </div>
  `).join('') || '<div style="color:var(--text-muted);font-size:12px;">Nenhum envio ainda.</div>';

  const confirmandoDesfazer = _cplConfirmandoDesfazer.has(c.id);
  const blocoParcelamento = det.parcelas_informado ? `
    <div style="margin-top:12px;font-size:12.5px;">
      <b>Parcelas informadas:</b> ${det.parcelas_qtd || 'Sim (sem detalhe — importado da planilha de parcelamento já informado)'}
    </div>
    ${confirmandoDesfazer ? `
      <div style="margin-top:8px;font-size:12px;background:#FFF3E0;border:1px solid #FFB74D;border-radius:6px;padding:8px 10px;">
        Tem certeza? Isso volta este concessionário pra pendente de envio.
        <div style="margin-top:6px;display:flex;gap:8px;">
          <button class="btn btn-sm" style="background:var(--vermelho);color:#fff;" onclick="cplDesfazerInformado(${c.id})">Sim, desfazer</button>
          <button class="btn btn-secondary btn-sm" onclick="cplCancelarDesfazer(${c.id})">Cancelar</button>
        </div>
      </div>
    ` : `
      <div style="margin-top:6px;">
        <button class="btn-link" style="background:none;border:none;color:var(--text-muted);font-size:11px;text-decoration:underline;cursor:pointer;padding:0;" onclick="cplPedirDesfazer(${c.id})">Parcelamento informado por engano? Desfazer</button>
      </div>
    `}
  ` : `
    <div class="cpl-retorno-form">
      <input type="text" id="cpl-parcelas-${c.id}" placeholder="ex: à vista, 12x, 60x"/>
      <button class="btn btn-primary btn-sm" onclick="cplRegistrarRetorno(${c.id})">Registrar retorno recebido</button>
    </div>
  `;

  return `
    <tr class="cpl-detalhe-row" data-detalhe-de="${c.id}">
      <td colspan="10">
        <div class="cpl-detalhe-grid">
          <div>
            <div class="cpl-detalhe-campo"><b>CNPJ:</b> ${det.cnpj || '—'}</div>
            <div class="cpl-detalhe-campo"><b>Cidade:</b> ${det.cidade || '—'}</div>
            <div class="cpl-detalhe-campo"><b>E-mail 1:</b> ${det.email1 || '—'}</div>
            <div class="cpl-detalhe-campo"><b>E-mail 2:</b> ${det.email2 || '—'}</div>
            <div class="cpl-detalhe-campo"><b>Telefone:</b> ${det.telefone || '—'}</div>
            <div class="cpl-detalhe-campo"><b>WhatsApp:</b> ${det.telefone_whatsapp || '—'}</div>
            <div class="cpl-detalhe-campo"><b>Data do aceite:</b> ${fmtDataHoraBrCpl(det.data_aceite)}</div>
            <div class="cpl-detalhe-campo"><b>Autorizado pela CPL:</b> ${det.autorizado_cpl ? 'Sim' : 'Não'}
              <button class="btn btn-secondary btn-sm" style="margin-left:8px;" onclick="cplAutorizar(${c.id}, ${det.autorizado_cpl ? 0 : 1})">${det.autorizado_cpl ? 'Desautorizar' : 'Autorizar'}</button>
            </div>
            <div class="cpl-detalhe-campo"><b>Observação:</b>
              <input type="text" id="cpl-obs-${c.id}" value="${(det.observacao || '').replace(/"/g, '&quot;')}" style="width:60%;padding:4px 6px;border:1px solid var(--cinza-b);border-radius:4px;background:var(--surface);color:var(--text);"/>
              <button class="btn btn-secondary btn-sm" onclick="cplSalvarObservacao(${c.id})">Salvar</button>
            </div>
          </div>
          <div>
            <div style="font-weight:700;font-size:12.5px;margin-bottom:6px;">Histórico de envios (${det.envios_qtd})</div>
            ${envios}
            ${blocoParcelamento}
          </div>
        </div>
      </td>
    </tr>
  `;
}

async function cplAlternarExpandir(id) {
  if (_cplExpandidos.has(id)) { _cplExpandidos.delete(id); cplRenderTabela(); return; }
  _cplExpandidos.add(id);
  cplRenderTabela();
  if (!_cplDetalheCache.has(id)) {
    try {
      const det = await fetch(`/api/cpl-comunicacao/concessionarios/${id}`).then(r => r.json());
      _cplDetalheCache.set(id, det);
      cplRenderTabela();
    } catch {
      toast('Erro ao carregar detalhes', 'error');
    }
  }
}

function cplToggleSelecionado(id, checked) {
  if (checked) _cplSelecionados.add(id); else _cplSelecionados.delete(id);
}

function cplToggleTodos(checked) {
  _cplLista.forEach(c => { if (checked) _cplSelecionados.add(c.id); else _cplSelecionados.delete(c.id); });
  cplRenderTabela();
}

async function cplEnviar(ids) {
  const msg = document.getElementById('cpl-envio-msg');
  if (!ids.length) { msg.style.color = 'var(--vermelho)'; msg.textContent = 'Nenhum concessionário selecionado.'; return; }
  msg.style.color = 'var(--text-muted)'; msg.textContent = 'Enviando...';
  try {
    const r = await fetch('/api/cpl-comunicacao/enviar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }).then(x => x.json());
    if (r.error) { msg.style.color = 'var(--vermelho)'; msg.textContent = r.error; return; }
    const pulados = r.pulados.length ? ` (${r.pulados.length} pulado(s): ${r.pulados.map(p => p.motivo).join(', ')})` : '';
    msg.style.color = r.enviados ? 'var(--verde)' : 'var(--vermelho)';
    msg.textContent = `${r.enviados} e-mail(s) enfileirado(s)${pulados}`;
    _cplDetalheCache.clear();
    _cplSelecionados.clear();
    await cplCarregar();
  } catch {
    msg.style.color = 'var(--vermelho)'; msg.textContent = 'Erro ao enviar.';
  }
}

function cplEnviarUm(id) { return cplEnviar([id]); }
function cplEnviarSelecionados() { return cplEnviar([..._cplSelecionados]); }
function cplEnviarTodosPendentes() { return cplEnviar(_cplLista.filter(c => c.situacao === 'pendente').map(c => c.id)); }

async function cplAutorizar(id, autorizado) {
  try {
    await fetch(`/api/cpl-comunicacao/concessionarios/${id}/autorizacao`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autorizado: !!autorizado }),
    });
    toast(autorizado ? 'Autorizado' : 'Desautorizado', 'success');
    _cplDetalheCache.delete(id);
    await cplAlternarExpandirForce(id);
    await cplCarregar();
  } catch {
    toast('Erro ao alterar autorização', 'error');
  }
}

function cplAlternarExpandirForce(id) {
  // Reabre o detalhe (já estava aberto, só precisa recarregar do cache limpo)
  _cplExpandidos.delete(id);
  return cplAlternarExpandir(id);
}

async function cplRegistrarRetorno(id) {
  const input = document.getElementById(`cpl-parcelas-${id}`);
  const parcelas_qtd = input ? input.value.trim() : '';
  if (!parcelas_qtd) { toast('Informe a quantidade de parcelas', 'error'); return; }
  try {
    const r = await fetch(`/api/cpl-comunicacao/concessionarios/${id}/retorno`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parcelas_qtd }),
    });
    if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
    toast('Retorno registrado', 'success');
    _cplDetalheCache.delete(id);
    await cplAlternarExpandirForce(id);
    await cplCarregar();
  } catch (e) {
    toast(e.message || 'Erro ao registrar retorno', 'error');
  }
}

function cplPedirDesfazer(id) {
  _cplConfirmandoDesfazer.add(id);
  cplRenderTabela();
}

function cplCancelarDesfazer(id) {
  _cplConfirmandoDesfazer.delete(id);
  cplRenderTabela();
}

async function cplDesfazerInformado(id) {
  try {
    const r = await fetch(`/api/cpl-comunicacao/concessionarios/${id}/desfazer-informado`, { method: 'PATCH' });
    if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
    toast('Parcelamento informado desfeito', 'success');
    _cplConfirmandoDesfazer.delete(id);
    _cplDetalheCache.delete(id);
    await cplAlternarExpandirForce(id);
    await cplCarregar();
  } catch (e) {
    toast(e.message || 'Erro ao desfazer', 'error');
  }
}

async function cplSalvarObservacao(id) {
  const input = document.getElementById(`cpl-obs-${id}`);
  try {
    await fetch(`/api/cpl-comunicacao/concessionarios/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ observacao: input.value }),
    });
    toast('Observação salva', 'success');
  } catch {
    toast('Erro ao salvar observação', 'error');
  }
}

document.addEventListener('DOMContentLoaded', cplCarregar);
