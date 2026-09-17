// PAC — Lançamento: DFDs disponíveis pro(s) setor(es) do usuário e a tabela de
// itens (colunas configuráveis pelo DEPLA, sticky + grupos colapsáveis).

function toast(msg, tipo) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (tipo ? ' ' + tipo : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
}

function fmtBr(iso) {
  if (!iso) return '';
  const d = String(iso).split(/[T ]/)[0].split('-');
  if (d.length < 3) return iso;
  return `${d[2]}/${d[1]}/${d[0]}`;
}
function brParaIso(br) {
  const m = String(br || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
function fmtMoeda(v) {
  if (v === null || v === undefined || v === '') return '';
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function parseMoeda(s) {
  if (!s || s === '') return null;
  const v = parseFloat(String(s).replace(/[R$\s.]/g, '').replace(',', '.'));
  return isNaN(v) ? null : v;
}

function badgeStatusDfd(status) {
  const icone = { aberto: '●', analise: '⚠', em_consolidacao: '📊', consolidado: '✅', fechado: '🔒' };
  const map = { aberto: 'Aberto', analise: 'Em análise', em_consolidacao: 'Em consolidação', consolidado: 'Consolidado', fechado: 'Fechado' };
  return `<span class="badge badge-${status}">${icone[status] || ''} ${map[status] || status}</span>`;
}

// Lê a mensagem de erro real do corpo da resposta (qualquer status, não só
// 409) — sem isso, toda rejeição do backend (403 de setor, 404 de item já
// removido, etc.) virava o mesmo toast genérico "Erro ao X", escondendo o
// motivo de verdade. Corpo pode não ser JSON (ex.: erro 500 cru do Express)
// — nesse caso cai no fallback.
async function mensagemErro(res, fallback) {
  try {
    const e = await res.json();
    return e.error || fallback;
  } catch {
    return fallback;
  }
}

let _dfdAtualId = null;
let _dfdAtual = null;
let _meusSetores = [];
let _pedidosLiberados = {}; // item_id -> Set('editar'|'excluir') aprovados e ainda não consumidos
let _itensAtuais = [];
let _finalizacaoPorSetor = {}; // setor_id -> finalizado_em (ou null)

document.addEventListener('DOMContentLoaded', () => {
  atualizarCabecalhoUsuario();
  atualizarRelogioHeader();
  setInterval(atualizarRelogioHeader, 60 * 1000);
  carregarDfds();
  aplicarAcessoImportacao();
});

// Link "Importação" dentro do galho Gestão da sidebar — acesso é só por role
// (master/admin_sistema, ver routes/pac-importacao.js), não Perfil/Rotina;
// mesma checagem duplicada em pac-gestao.js/pac-acompanhamento.js (cada
// página tem sua própria sidebar, sem componente compartilhado).
let _usuarioPac = null; // guardado pra decidir a válvula de escape do master no bloqueio de pendências (ver renderFinalizacao)

async function aplicarAcessoImportacao() {
  try {
    const user = await window.getCurrentUser();
    _usuarioPac = user;
    const el = document.getElementById('nav-pac-importacao');
    if (el && user && (user.username === 'master' || user.role === 'admin_sistema')) el.style.display = '';
  } catch {}
}

const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function atualizarRelogioHeader() {
  const agora = new Date();
  const hora = document.getElementById('pac-lanc-hora');
  if (hora) hora.textContent = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
  const data = document.getElementById('pac-lanc-data');
  if (data) data.textContent = `${String(agora.getDate()).padStart(2, '0')}/${MESES_PT[agora.getMonth()]}/${agora.getFullYear()}`;
}

// Foto (mesmo endpoint que a sidebar já usa) ou, sem foto, iniciais do nome
// sobre fundo na cor do módulo — o avatar sai da sidebar e vive só aqui
// nesta página (ver guarda em auth.js/_injetarFoto).
function renderAvatarHeader(user) {
  const el = document.getElementById('pac-lanc-avatar');
  if (!el) return;
  if (user && user.tem_foto) {
    el.innerHTML = `<img src="/api/usuarios/${user.id}/foto" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;display:block;" />`;
    return;
  }
  const nome = (user && (user.nome_completo || user.username)) || '';
  const iniciais = nome.trim().split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() || '').join('') || '?';
  el.innerHTML = `<div style="width:36px;height:36px;border-radius:50%;background:var(--verde);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;">${iniciais}</div>`;
}

// Linha 3/4 do cabeçalho — pedido do Alex, 2026-09-15: a saudação + análise
// preditiva só faz sentido com um DFD já aberto (antes disso, na tela que
// lista os DFDs, fica escondida — ver atualizarCabecalhoUsuario/abrirDfd/
// fecharDfd). O campo de "setor padrão" autoatendimento (v4.22.0) saiu —
// não tinha uso real; a ordem de _meusSetores já vem de `setores.ordem`
// (definida no admin), não precisa de escolha do usuário.
function saudacaoPorHorario() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Bom dia';
  if (h >= 12 && h < 18) return 'Boa tarde';
  return 'Boa noite';
}

function diasRestantes(dataIso) {
  if (!dataIso) return null;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const alvo = new Date(String(dataIso).split(/[T ]/)[0] + 'T00:00:00');
  return Math.round((alvo - hoje) / 86400000);
}

let _nomeUsuarioPac = '';

async function atualizarCabecalhoUsuario() {
  document.getElementById('pac-lanc-linha3').style.display = 'none';
  document.getElementById('pac-lanc-linha4').style.display = 'none';
  try {
    const [user, setoresRes] = await Promise.all([
      window.getCurrentUser(),
      fetch('/api/pac/meus-setores'),
    ]);
    _meusSetores = setoresRes.ok ? await setoresRes.json() : [];
    _nomeUsuarioPac = (user && (user.nome_completo || user.username)) || '';
    renderAvatarHeader(user);
  } catch {}
}

// Saudação + análise preditiva sobre o DFD que acabou de ser aberto — só
// aparece dentro do DFD (pedido do Alex, 2026-09-15: "a mensagem deve ocorrer
// somente com o dfd aberto e não na tela que lista os dfds"). Precisa de
// _itensAtuais/_finalizacaoPorSetor já carregados (chamar depois de
// renderItens()/carregarStatusFinalizacao() em abrirDfd).
//
// Mensagem de status (linha4) passou a cobrir TODOS os status do DFD, não só
// "aberto" — pedido do Alex, 2026-09-16: "precisa caminhar conforme o que
// está ocorrendo de verdade" (aberto sem item / em andamento + prazo / em
// análise podendo solicitar edição / em consolidação / fechado-cancelado).
// Mesma lógica de mensagemStatusDfd() em pac-gestao.js, duplicada aqui com
// texto na 1ª pessoa (convenção do projeto, sem módulo compartilhado novo).
function mensagemStatusLancamento({ status, temItens, todosFinalizados, dias, anoBase }) {
  const prazoTxto = dias == null ? '' : dias > 0 ? ` Você tem ${dias} dia(s) para lançar.` : dias === 0 ? ' O prazo termina hoje!' : ` O prazo já venceu há ${-dias} dia(s).`;
  if (status === 'cancelado') return { texto: 'Este DFD foi cancelado.', tom: 'muted' };
  if (status === 'fechado') return { texto: 'Este DFD está fechado — processo concluído.', tom: 'success' };
  if (status === 'consolidado') return { texto: 'Consolidação finalizada — aguardando o fechamento do DFD pelo DEPLA.', tom: 'info' };
  if (status === 'em_consolidacao') return { texto: 'Em consolidação — o DEPLA está trabalhando os itens.', tom: 'info' };
  if (status === 'analise') return { texto: 'Este DFD está em análise do DEPLA. Precisa alterar algo? Você pode solicitar um pedido de edição.', tom: 'warning' };
  // status === 'aberto'
  if (!temItens) return { texto: `Notei que você ainda não iniciou o PAC ${anoBase}.${prazoTxto}`, tom: 'warning' };
  if (!todosFinalizados) return { texto: `Vi que você já começou o PAC ${anoBase}. Continue lançando os itens.${prazoTxto}`, tom: 'info' };
  return { texto: `Você já finalizou o lançamento — pronto pra seguir ao próximo passo.`, tom: 'success' };
}
function renderMensagemLancamento() {
  const linha3 = document.getElementById('pac-lanc-linha3');
  const linha4 = document.getElementById('pac-lanc-linha4');
  linha3.textContent = `${saudacaoPorHorario()}, ${_nomeUsuarioPac}!`;
  if (_meusSetores.length > 1) {
    linha3.textContent += ` Você tem ${_meusSetores.map(s => s.nome).join(' e ')} a preencher.`;
  }
  linha3.style.display = '';

  const dias = diasRestantes(_dfdAtual.data_entrega);
  const todosFinalizados = _meusSetores.length > 0 && _meusSetores.every(s => !!_finalizacaoPorSetor[s.id]);
  const { texto, tom } = mensagemStatusLancamento({
    status: _dfdAtual.status, temItens: _itensAtuais.length > 0, todosFinalizados, dias, anoBase: _dfdAtual.ano_base,
  });
  linha4.textContent = texto;
  linha4.className = `pac-status-msg tom-${tom}`;
  linha4.style.display = '';
}

const ICONE_VAZIO = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" stroke-width="1.5"><path d="M9 12h6M9 16h6M9 8h1"/><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;

// Código estável do DFD (nunca some/reaparece com outro dono) — pedido do
// Alex, 2026-09-06: testando com vários DFDs criados/apagados durante os
// testes, sem número nenhum na tela ficava difícil saber qual é qual.
// Deriva de `id` (AUTOINCREMENT de verdade — SQLite nunca reusa esse número,
// mesmo depois de excluir uma linha) + ano_base; não é uma coluna nova no
// banco, é só formatação (sempre reproduzível a partir do que já existe).
function codigoDfd(d) {
  return `DFD-${String(d.id).padStart(3, '0')}-${d.ano_base}`;
}

async function carregarDfds() {
  try {
    const res = await fetch('/api/pac/dfds');
    const dfds = res.ok ? await res.json() : [];
    document.getElementById('dfds-tbody').innerHTML = dfds.map(d => `
      <tr>
        <td><strong>${codigoDfd(d)}</strong></td>
        <td>${d.titulo}</td>
        <td>${d.ano_base}</td>
        <td>${badgeStatusDfd(d.status)}</td>
        <td>${d.itens_count ?? 0}</td>
        <td style="text-align:right;"><button class="btn btn-primary btn-sm" onclick="abrirDfd(${d.id})">Abrir →</button></td>
      </tr>
    `).join('') || `<tr><td colspan="6" style="padding:32px 20px;text-align:center;color:var(--text-subtle);">
        <div style="display:flex;flex-direction:column;align-items:center;gap:8px;">
          ${ICONE_VAZIO}
          <span>Nenhum DFD disponível para o seu setor no momento.</span>
        </div>
      </td></tr>`;
  } catch {
    toast('Erro ao carregar DFDs', 'error');
  }
}

async function abrirDfd(id) {
  _dfdAtualId = id;
  document.getElementById('pac-dfd-lista').style.display = 'none';
  document.getElementById('pac-dfd-itens').style.display = 'block';

  const [dfdRes, setoresRes] = await Promise.all([
    fetch(`/api/pac/dfds/${id}`),
    fetch('/api/pac/meus-setores'),
  ]);
  if (!dfdRes.ok) { toast('Erro ao abrir DFD', 'error'); fecharDfd(); return; }
  _dfdAtual = await dfdRes.json();
  const todosMeusSetores = setoresRes.ok ? await setoresRes.json() : [];
  // Só os setores do usuário que TAMBÉM participam DESTE DFD — sem isso, um
  // gestor de 2+ setores via o outro setor "fantasma" aqui mesmo quando o
  // DFD só foi liberado pra 1 (mensagem de saudação, filtro "Setor", contador
  // de "Finalizar meu DFD" e o próprio multiSetor/tabela usam _meusSetores
  // pra tudo). Achado testando de verdade, 2026-09-17 (Alex: "o DFD foi
  // liberado somente para um, então não faz sentido termos os 2 destacados").
  const idsParticipantes = new Set((_dfdAtual.setores || []).map(s => s.id));
  _meusSetores = todosMeusSetores.filter(s => idsParticipantes.has(s.id));

  document.getElementById('pac-lanc-titulo').textContent = `${codigoDfd(_dfdAtual)} — ${_dfdAtual.titulo}`;
  const linha2 = document.getElementById('pac-lanc-linha2');
  // Data de vencimento (entrega) do DFD — pedido do Alex, 2026-09-07: aparecer
  // sempre que o DFD específico for aberto. DFD criado antes desta versão
  // pode não ter essa data (fica "não informado", não trava nada).
  const vencTexto = _dfdAtual.data_entrega ? `Vencimento: ${fmtBr(_dfdAtual.data_entrega)}` : 'Vencimento: não informado';
  linha2.innerHTML = `Lançamento · ${badgeStatusDfd(_dfdAtual.status)} · ${vencTexto}`;
  linha2.style.display = '';

  await carregarListas();
  await renderMeusPedidos(); // calcula _pedidosLiberados antes da tabela usar
  await carregarStatusFinalizacao(); // calcula _finalizacaoPorSetor antes da tabela usar
  await renderItens(); // popula _itensAtuais (renderFinalizacao precisa disso pra decidir "tem item lançado?")
  renderFinalizacao();
  renderMensagemLancamento();
  iniciarAutoRefreshKpis();
}

// "Execução dos itens" (status_execucao) é alterado pelo DEPLA em Gestão >
// Acompanhamento, não em Lançamento — sem alguma forma de atualização, o
// indicador fica parado até alguém clicar "🔄 Atualizar" manualmente. Pedido
// do Alex, 2026-09-08: "movimentações feitas enxergar isto em tempo real ou
// com refresh da página, hoje é uma informação que já nasce morta". Sem
// WebSocket no projeto, a solução possível é polling — só busca /itens de
// novo e atualiza os indicadores (renderFinalizacao, que NÃO toca na tabela
// de itens em si), pra não perder uma edição em andamento em campo aberto.
let _kpiAutoRefreshTimer = null;
function iniciarAutoRefreshKpis() {
  pararAutoRefreshKpis();
  _kpiAutoRefreshTimer = setInterval(async () => {
    if (!_dfdAtualId) return;
    try {
      const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/itens`);
      // Confere de novo depois do await — se o usuário saiu do DFD enquanto
      // a requisição estava no ar, _dfdAtual já é null e renderFinalizacao()
      // quebraria (lê _dfdAtual.status).
      if (res.ok && _dfdAtualId) { _itensAtuais = await res.json(); renderFinalizacao(); }
    } catch { /* silencioso — próxima batida tenta de novo */ }
  }, 30000);
}
function pararAutoRefreshKpis() {
  if (_kpiAutoRefreshTimer) { clearInterval(_kpiAutoRefreshTimer); _kpiAutoRefreshTimer = null; }
}

function fecharDfd() {
  _dfdAtualId = null; _dfdAtual = null;
  pararAutoRefreshKpis();
  document.getElementById('pac-dfd-itens').style.display = 'none';
  document.getElementById('pac-dfd-lista').style.display = 'block';
  document.getElementById('pac-lanc-titulo').textContent = 'Lançamento';
  document.getElementById('pac-lanc-linha2').style.display = 'none';
  document.getElementById('pac-lanc-linha3').style.display = 'none';
  document.getElementById('pac-lanc-linha4').style.display = 'none';
  carregarDfds();
}

/* ── Popup "Acompanhamento" (do meu setor) ──────────────────────────────────
   Substitui a antiga página/rotina separada "pac-acompanhamento" pra quem
   lança — mesmas colunas de Lançamento (só leitura), com botão de imprimir
   e de fechar dentro do próprio popup (ver .modal-overlay-print no CSS). Não
   busca dado novo: reaproveita _itensAtuais, que já vem filtrado pro(s)
   setor(es) do usuário logado (mesma fonte que a tabela editável usa). */
function abrirAcompanhamentoPopup() {
  const nomeSetores = _meusSetores.map(s => s.nome).join(', ') || '—';
  const vencTexto = _dfdAtual.data_entrega ? `Vencimento: ${fmtBr(_dfdAtual.data_entrega)}` : 'Vencimento: não informado';
  document.getElementById('acomp-pop-subtitulo').textContent =
    `${codigoDfd(_dfdAtual)} — ${_dfdAtual.titulo} · ${nomeSetores} · ${vencTexto}`;

  const colunasPrincipais = _dfdAtual.colunas.filter(c => c.grupo === 'A' && c.slug !== 'numero_item');
  const colunasContrato = _dfdAtual.colunas.filter(c => c.grupo === 'C');
  const temColContrato = colunasContrato.length > 0;
  const multiSetor = _meusSetores.length > 1;

  document.getElementById('acomp-pop-thead').innerHTML =
    `<tr>${multiSetor ? '<th>Setor</th>' : ''}<th>ID PAC</th><th>Nº PAC</th>${colunasPrincipais.map(c => `<th>${c.label}</th>`).join('')}${temColContrato ? '<th>Contrato</th>' : ''}</tr>`;

  const colspan = (multiSetor ? 1 : 0) + 2 + colunasPrincipais.length + (temColContrato ? 1 : 0);
  document.getElementById('acomp-pop-tbody').innerHTML = _itensAtuais.map(item => `
    <tr>
      ${multiSetor ? `<td data-label="Setor">${nomeSetorLanc(item.setor_id)}</td>` : ''}
      <td data-label="ID PAC">${item.codigo_pac || '—'}</td>
      <td data-label="Nº PAC">${item.numero_pac || '—'}</td>
      ${colunasPrincipais.map(c => `<td data-label="${c.label}">${formatarValorExibicao(c, item.valores[c.id])}</td>`).join('')}
      ${temColContrato ? renderCelulaContratoSomenteLeitura(item) : ''}
    </tr>
  `).join('') || `<tr><td colspan="${colspan}" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item lançado ainda.</td></tr>`;

  document.getElementById('modal-acompanhamento').classList.add('open');
}

// Indicadores — pedido do Alex, 2026-09-08: primeiro só no popup ("no botão
// de acompanhamento também"), depois direto na tela principal de Lançamento
// também ("não deveríamos ter valores somando nesta tela? só temos em
// acompanhamento"). Redesenho, mesma data (Alex, depois de terminar o teste
// ponta-a-ponta): "Itens lançados" saiu (não fazia sentido), "Setores
// finalizados"/"Execução dos itens" viraram pizza, "Valor estimado" virou
// "Valor realizado" (realizado/estimado, igual Gestão) com velocímetro —
// zero lib nova, SVG inline (ver svgPizza/svgVelocimetro abaixo, mesmos
// helpers duplicados em pac-gestao.js). Calculado com o que já está
// carregado (_itensAtuais/_dfdAtual/_finalizacaoPorSetor), sem requisição
// nova (o /itens já devolve realizado_tu_mlp/realizado_rdc por item).
// Redesenho 2026-09-08 (2ª volta, mesma tarde): Alex mandou print mostrando o
// formato que queria de verdade — gráfico de pizza "de tela cheia" (título
// em cima, fatias com % escrito em cima, legenda embaixo), não um ícone
// pequeno dentro de uma linha de texto ("os indicadores que quero são neste
// formato e não em linha da forma que foi feita"). "Execução dos itens" no
// print dele tem a MESMA legenda das opções reais de status_execucao (Não
// Iniciado/Processado DEPLA/Fracionamento Aberto/Processo Finalizado) — não
// é mais só 2 fatias (finalizado/pendente), é a distribuição completa por
// status (ver STATUS_EXECUCAO_KPI abaixo).
// 3ª rodada de ajuste (mesma tarde, 2026-09-08) — Alex apontou 3 problemas
// concretos nesta 1ª versão de pizza "de tela cheia":
// 1) "Setores Finalizados" some de nome estranho e, quando chega em 100%,
//    fica só um círculo verde liso com um número em cima ("fica em branco").
//    Virou DONUT (buraco no meio) com o texto "X de Y" centralizado — mesmo
//    a 100%, o miolo mostra algo com substância, não um número solto.
// 2) Legenda "em posição ruim" (embaixo, cortando linha) — virou uma coluna
//    ao LADO do donut, com o valor de cada fatia junto do rótulo.
// 3) Velocímetro "mais bacana" — ganhou faixas de cor fixas (vermelho/
//    laranja/verde, referência visual tipo velocímetro de verdade) em vez
//    de uma única barra colorida condicionalmente, mais os extremos "0%"/
//    "100%" marcados e o número grande dentro do mostrador.
function svgPizzaMulti(fatias, centroTexto) {
  const total = fatias.reduce((s, f) => s + f.valor, 0) || 1;
  const cx = 90, cy = 90, r = 72, rBuraco = 44;
  const toRad = a => (a * Math.PI) / 180;
  let anguloAtual = -90;
  const paths = [], rotulos = [];
  fatias.forEach(f => {
    const pct = f.valor / total;
    if (pct <= 0) return;
    const anguloFatia = Math.min(pct * 360, 359.999); // 360 fecha o path errado (M=A coincidentes)
    const anguloFim = anguloAtual + anguloFatia;
    const x1 = cx + r * Math.cos(toRad(anguloAtual)), y1 = cy + r * Math.sin(toRad(anguloAtual));
    const x2 = cx + r * Math.cos(toRad(anguloFim)), y2 = cy + r * Math.sin(toRad(anguloFim));
    const largeArc = anguloFatia > 180 ? 1 : 0;
    paths.push(`<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${f.cor}" stroke="var(--surface)" stroke-width="2"></path>`);
    if (pct >= 0.035) {
      const meio = anguloAtual + anguloFatia / 2;
      const lx = cx + (r + rBuraco) / 2 * Math.cos(toRad(meio)), ly = cy + (r + rBuraco) / 2 * Math.sin(toRad(meio));
      rotulos.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="11" font-weight="700" fill="#fff" text-anchor="middle" dominant-baseline="middle" style="paint-order:stroke;stroke:rgba(0,0,0,.35);stroke-width:2px;">${Math.round(pct * 100)}%</text>`);
    }
    anguloAtual = anguloFim;
  });
  const fsCentro = !centroTexto ? 0 : (centroTexto.length > 5 ? 15 : 20);
  const centro = centroTexto
    ? `<circle cx="${cx}" cy="${cy}" r="${rBuraco}" fill="var(--surface)"></circle>
       <text x="${cx}" y="${cy}" font-size="${fsCentro}" font-weight="800" text-anchor="middle" dominant-baseline="middle" fill="var(--text)">${centroTexto}</text>`
    : '';
  return `<svg viewBox="0 0 180 180" width="140" height="140" style="flex-shrink:0;">${paths.join('')}${centro}${rotulos.join('')}</svg>`;
}
function legendaGrafico(fatias) {
  return `<div style="display:flex;flex-direction:column;gap:5px;font-size:12px;text-align:left;">${
    fatias.map(f => `<span style="display:flex;align-items:center;gap:6px;white-space:nowrap;">
      <span style="width:10px;height:10px;border-radius:2px;background:${f.cor};display:inline-block;flex-shrink:0;"></span>${f.label} <strong style="margin-left:auto;padding-left:10px;">${f.valor}</strong>
    </span>`).join('')
  }</div>`;
}
function cardGrafico(titulo, corpoSvg, legenda, fracaoTexto) {
  return `<div class="card" style="flex:1 1 260px;padding:16px;">
    <div style="font-size:13px;font-weight:600;margin-bottom:10px;text-align:center;">${titulo}</div>
    <div style="display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap;">
      ${corpoSvg}
      ${legenda}
    </div>
    ${fracaoTexto ? `<div style="font-size:12px;color:var(--text-muted);margin-top:10px;text-align:center;">${fracaoTexto}</div>` : ''}
  </div>`;
}
// Mesmas 5 opções de dfd_itens.status_execucao (routes/pac.js,
// STATUS_EXECUCAO_VALIDOS) + uma cor fixa cada, pro gráfico de pizza de
// "Execução dos itens" bater com a legenda real do sistema (não é lista
// solta — se um status novo for adicionado lá, precisa espelhar aqui).
const STATUS_EXECUCAO_KPI = [
  { label: 'Não Iniciado', cor: '#c0392b' },
  { label: 'Processado DEPLA', cor: '#d97706' },
  { label: 'Fracionamento Aberto', cor: '#2563eb' },
  { label: 'Processo Finalizado', cor: 'var(--verde, #2E7D32)' },
  { label: 'Cancelado', cor: '#9ca3af' },
];
function svgVelocimetro(pct) {
  const p = Math.max(0, Math.min(100, pct));
  const raio = 44, cx = 50, cy = 50, L = Math.PI * raio; // comprimento do arco (meio-círculo)
  const zonas = [{ ini: 0, fim: 50, cor: '#c0392b' }, { ini: 50, fim: 80, cor: '#d97706' }, { ini: 80, fim: 100, cor: 'var(--verde, #2E7D32)' }];
  const arcoZona = z => {
    const comp = (z.fim - z.ini) / 100 * L, offset = -(z.ini / 100 * L);
    return `<path d="M 6 50 A ${raio} ${raio} 0 0 1 94 50" fill="none" stroke="${z.cor}" stroke-width="10"
      stroke-dasharray="${comp.toFixed(1)} ${L.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></path>`;
  };
  const theta = (180 - (p / 100) * 180) * Math.PI / 180;
  const x2 = cx + 34 * Math.cos(theta), y2 = cy - 34 * Math.sin(theta);
  return `<svg viewBox="0 0 100 68" width="160" height="109" style="flex-shrink:0;">
    ${zonas.map(arcoZona).join('')}
    <line x1="${cx}" y1="${cy}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--text, #222)" stroke-width="2.5" stroke-linecap="round"></line>
    <circle cx="${cx}" cy="${cy}" r="4" fill="var(--text, #222)"></circle>
    <text x="4" y="63" font-size="7" fill="var(--text-muted)">0%</text>
    <text x="96" y="63" font-size="7" fill="var(--text-muted)" text-anchor="end">100%</text>
    <text x="${cx}" y="42" font-size="16" font-weight="800" text-anchor="middle" fill="var(--text)">${p}%</text>
  </svg>`;
}
function renderKpisLancamento(elId) {
  const wrap = document.getElementById(elId);
  if (!wrap) return;
  const itens = _itensAtuais || [];

  const totalSetores = _meusSetores.length;
  const setoresFinalizados = _meusSetores.filter(s => _finalizacaoPorSetor[s.id]).length;

  const contagemExecucao = STATUS_EXECUCAO_KPI.map(s => ({
    label: s.label, cor: s.cor, valor: itens.filter(i => i.status_execucao === s.label).length,
  }));
  const itensFinalizados = itens.filter(i => i.status_execucao === 'Processo Finalizado').length;

  const idValorEstimado = (_dfdAtual.colunas.find(c => c.slug === 'valor_estimado') || {}).id;
  const totais = itens.reduce((acc, i) => {
    acc.estimado += Number((i.valores || {})[idValorEstimado]) || 0;
    acc.realizado += (Number(i.realizado_tu_mlp) || 0) + (Number(i.realizado_rdc) || 0);
    return acc;
  }, { estimado: 0, realizado: 0 });
  const pctRealizado = totais.estimado ? Math.round((totais.realizado / totais.estimado) * 100) : 0;

  const cardSetores = totalSetores > 1 ? (() => {
    const fatias = [
      { label: 'Finalizados', valor: setoresFinalizados, cor: 'var(--verde, #2E7D32)' },
      { label: 'Pendentes', valor: totalSetores - setoresFinalizados, cor: '#c0392b' },
    ];
    return cardGrafico('Progresso de Setores', svgPizzaMulti(fatias, `${setoresFinalizados}/${totalSetores}`), legendaGrafico(fatias), '');
  })() : '';

  const cardExecucao = cardGrafico('Execução dos itens', svgPizzaMulti(contagemExecucao, `${itensFinalizados}/${itens.length}`), legendaGrafico(contagemExecucao), '');

  const cardValor = cardGrafico('Valor realizado', svgVelocimetro(pctRealizado), '',
    `R$ ${fmtMoeda(totais.realizado)} de R$ ${fmtMoeda(totais.estimado)}`);

  wrap.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap;">${cardSetores}${cardExecucao}${cardValor}</div>`;
}

function renderCelulaContratoSomenteLeitura(item) {
  const cfg = cfgContrato(estadoContrato(item));
  return `<td data-label="Contrato" style="text-align:center;">${cfg.icone} ${cfg.texto}</td>`;
}

function fecharAcompanhamentoPopup() {
  document.getElementById('modal-acompanhamento').classList.remove('open');
}

/* ── Tabela de itens ─────────────────────────────────────────────────────── */

// Grupo B (Possui Contrato?) e C (Nº/Razão Social/Vencimento) viram 1 coluna só
// ("Contrato") — badge com texto (Sim/Não já visível, sem depender de hover),
// clique abre popup com o seletor Sim/Não + os campos de C.
// Setor do item só vira COLUNA (e ganha filtro) quando o usuário está
// vinculado a mais de 1 setor — pedido do Alex (2026-09-06, confirmado como
// situação real de produção, não só teste): sem isso, itens de setores
// diferentes apareciam misturados na mesma tabela sem nenhuma pista de qual
// é qual. Com 1 setor só (o caso comum), a tela continua idêntica a sempre.
function nomeSetorLanc(setorId) {
  return (_meusSetores.find(s => s.id === setorId) || {}).nome || '—';
}

async function renderItens() {
  // ID PAC e Nº PAC ficam fixos (sticky) no início da tabela — nenhum dos dois
  // é uma "coluna" configurável do catálogo (são campos diretos de dfd_itens:
  // codigo_pac e numero_pac), então são renderizados à parte, fora do loop de
  // colunasPrincipais. "Número" (numero_item, sequencial interno) não aparece
  // mais na tela — instrução do Alex era só ID_PAC + NUMERO_PAC visíveis; o
  // numero_item continua existindo por baixo, só pra ordenação.
  const colunasPrincipais = _dfdAtual.colunas.filter(c => c.grupo === 'A' && c.slug !== 'numero_item');
  const colunasContrato = _dfdAtual.colunas.filter(c => c.grupo === 'C');
  const temColContrato = colunasContrato.length > 0;
  const multiSetor = _meusSetores.length > 1;

  const filtroWrap = document.getElementById('lanc-filtro-setor-wrap');
  const filtroSelect = document.getElementById('lanc-filtro-setor');
  filtroWrap.style.display = multiSetor ? '' : 'none';
  if (multiSetor && !filtroSelect.dataset.montado) {
    filtroSelect.innerHTML = '<option value="">Todos os meus setores</option>' +
      _meusSetores.map(s => `<option value="${s.id}">${s.nome}</option>`).join('');
    filtroSelect.dataset.montado = '1';
  }
  const filtroSetorId = multiSetor && filtroSelect.value ? Number(filtroSelect.value) : null;

  const thead = document.getElementById('lanc-itens-thead');
  thead.innerHTML = `<tr>${multiSetor ? '<th>Setor</th>' : ''}<th class="dfd-col-fixa-1">ID PAC</th><th class="dfd-col-fixa-2">Nº PAC</th>${colunasPrincipais.map(c => `<th>${c.label}</th>`).join('')}${temColContrato ? '<th>Contrato</th>' : ''}<th></th></tr>`;

  const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/itens`);
  _itensAtuais = res.ok ? await res.json() : [];
  let itensExibidos = filtroSetorId ? _itensAtuais.filter(i => i.setor_id === filtroSetorId) : _itensAtuais;

  // Filtros adicionais — pedido do Alex, 2026-09-15: fonte pagadora, data
  // desejada, nº PAC, objeto (a antiga coluna "Subitem", agora digitável).
  const colunaPorSlug = slug => (_dfdAtual.colunas || []).find(c => c.slug === slug);
  const colFonte = colunaPorSlug('fonte_pagadora');
  const colData = colunaPorSlug('data_desejada');
  const colObjeto = colunaPorSlug('subitem');

  const selFonte = document.getElementById('lanc-filtro-fonte');
  if (selFonte && colFonte && !selFonte.dataset.montado) {
    selFonte.innerHTML = '<option value="">Todas</option>' + (_listasCache.fonte_pagadora || []).map(o => `<option value="${o.valor}">${o.valor}</option>`).join('');
    selFonte.dataset.montado = '1';
  }
  const fFonte = selFonte?.value;
  const fData = document.getElementById('lanc-filtro-data')?.value;
  const fNumeroPac = document.getElementById('lanc-filtro-numero-pac')?.value.trim().toLowerCase();
  const fObjeto = document.getElementById('lanc-filtro-objeto')?.value.trim().toLowerCase();

  if (fFonte && colFonte) itensExibidos = itensExibidos.filter(i => (i.valores || {})[colFonte.id] === fFonte);
  if (fData && colData) itensExibidos = itensExibidos.filter(i => (i.valores || {})[colData.id] === fData);
  if (fNumeroPac) itensExibidos = itensExibidos.filter(i => String(i.numero_pac || '').toLowerCase().includes(fNumeroPac) || String(i.codigo_pac || '').toLowerCase().includes(fNumeroPac));
  if (fObjeto && colObjeto) itensExibidos = itensExibidos.filter(i => String((i.valores || {})[colObjeto.id] || '').toLowerCase().includes(fObjeto));

  // Filtro "só itens com campo em branco" — pedido do Alex, 2026-09-07: o
  // aviso de pendência só cita os 5 primeiros números, isso deixa ver a
  // lista completa (com todas as colunas, pra achar o campo vazio de vez).
  const totalPendencias = itensExibidos.filter(itemTemPendencia).length;
  const pendWrap = document.getElementById('lanc-filtro-pendencia-wrap');
  const pendCheckbox = document.getElementById('lanc-filtro-pendencia');
  if (totalPendencias > 0) {
    pendWrap.style.display = 'flex';
    document.getElementById('lanc-filtro-pendencia-label').textContent =
      `Só itens com campo em branco (${totalPendencias})`;
  } else {
    pendWrap.style.display = 'none';
    pendCheckbox.checked = false; // nada pendente — não deixa o filtro "travado" ligado escondido
  }
  if (pendCheckbox.checked) itensExibidos = itensExibidos.filter(itemTemPendencia);

  const contagem = document.getElementById('lanc-dfd-contagem');
  if (contagem) {
    contagem.textContent = itensExibidos.length === _itensAtuais.length
      ? (_itensAtuais.length === 1 ? '1 item lançado' : `${_itensAtuais.length} itens lançados`)
      : `${itensExibidos.length} de ${_itensAtuais.length} itens (filtrado)`;
  }

  const colspan = (multiSetor ? 1 : 0) + 2 + colunasPrincipais.length + (temColContrato ? 1 : 0) + 1;
  const tbody = document.getElementById('lanc-itens-tbody');
  tbody.innerHTML = itensExibidos.map(item => {
    const liberado = _pedidosLiberados[item.id] || new Set();
    const setorFinalizado = !!_finalizacaoPorSetor[item.setor_id];
    const podeExcluir = (_dfdAtual.status === 'aberto' && !setorFinalizado) || liberado.has('excluir');
    // "análise" OU setor já finalizado (com DFD ainda aberto pros outros
    // setores) — nos dois casos, "fechado" não aceita nem pedido.
    const podeSolicitar = _dfdAtual.status !== 'fechado' && (_dfdAtual.status === 'analise' || setorFinalizado);
    return `
    <tr data-item-id="${item.id}">
      ${multiSetor ? `<td data-label="Setor">${nomeSetorLanc(item.setor_id)}</td>` : ''}
      <td class="dfd-col-fixa-1" data-label="ID PAC">${item.codigo_pac || '—'}</td>
      <td class="dfd-col-fixa-2" data-label="Nº PAC">${item.numero_pac || '—'}</td>
      ${colunasPrincipais.map(c => renderCelula(item, c, -1, liberado)).join('')}
      ${temColContrato ? renderCelulaContrato(item, colunasContrato) : ''}
      <td style="text-align:right;white-space:nowrap;">
        ${!itemEditavel(item, liberado) ? '' : itemTemPendencia(item)
          ? `<button class="btn btn-primary btn-xs" onclick="concluirItem(${item.id})" title="Confere se falta algo e confirma">✅ Concluir</button>`
          : `<span class="pac-item-completo" style="color:var(--verde,#2E7D32);font-size:12px;font-weight:600;white-space:nowrap;">✅ Completo</span>`}
        ${podeExcluir
          ? `<button class="btn btn-danger btn-xs" onclick="excluirItem(${item.id})">Excluir</button>`
          : (podeSolicitar ? `<button class="btn btn-secondary btn-xs" onclick="abrirPedido(${item.id}, 'excluir')">Solicitar exclusão</button>` : '')}
        ${(!itemEditavel(item, liberado) && podeSolicitar)
          ? `<button class="btn btn-secondary btn-xs" onclick="abrirPedido(${item.id}, 'editar')">Solicitar edição</button>` : ''}
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="${colspan}" style="padding:20px;text-align:center;color:var(--text-subtle);">Nenhum item lançado ainda.</td></tr>`;

  wireCelulas();
  renderFormNovoItem();
}

const ICONE_CONTRATO_SIM = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--verde)" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15l2 2 4-4"/></svg>`;
const ICONE_CONTRATO_NAO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;
const ICONE_CONTRATO_PENDENTE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a15c00" stroke-width="2"><path d="M12 9v4"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L14.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 17h.01"/></svg>`;
// Distinta de "Pendente" (que pede ação — item lançado ao vivo sem resposta
// ainda) — traço tracejado marca "dado histórico sem essa informação na
// planilha original", não uma pendência que alguém precisa resolver agora.
const ICONE_CONTRATO_NAO_INFORMADO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" stroke-width="1.5" stroke-dasharray="3 2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;

// "possui_contrato" (grupo B) é a fonte da verdade sobre o estado — não dá
// mais pra inferir isso pelo preenchimento das colunas de grupo C, porque
// "Não" deliberado e "ainda não respondido" ficavam iguais (colunas vazias
// nos dois casos). Ver valoresContratoDoForm() pra como "Não" é gravado.
function estadoContrato(item) {
  const possuiCol = _dfdAtual.colunas.find(c => c.slug === 'possui_contrato');
  const v = possuiCol ? item.valores[possuiCol.id] : null;
  if (v === 'Sim') return 'sim';
  if (v === 'Não') return 'nao';
  if (v === 'Não informado') return 'nao_informado';
  return 'pendente';
}

// Extraído de renderCelulaContrato pra ser reaproveitado tal e qual no popup
// de Acompanhamento (somente leitura) — mesmos ícones/textos/cores em
// qualquer tela que mostrar a coluna Contrato, por definição (mesma função).
function cfgContrato(estado) {
  return {
    sim: { icone: ICONE_CONTRATO_SIM, texto: 'Com contrato', titulo: 'Clique para ver/editar os dados do contrato' },
    nao: { icone: ICONE_CONTRATO_NAO, texto: 'Sem contrato', titulo: 'Clique para ver/editar os dados do contrato' },
    nao_informado: { icone: ICONE_CONTRATO_NAO_INFORMADO, texto: 'Não informado', titulo: 'Dado histórico importado sem essa informação na planilha original — clique para preencher se souber' },
    pendente: { icone: ICONE_CONTRATO_PENDENTE, texto: 'Pendente', titulo: 'Contrato ainda não informado — clique para responder' },
  }[estado];
}

function renderCelulaContrato(item, colunasContrato) {
  const estado = estadoContrato(item);
  const cfg = cfgContrato(estado);
  return `<td data-label="Contrato" style="text-align:center;">
    <button type="button" class="badge-contrato ${estado}" title="${cfg.titulo}" onclick="abrirModalContrato(${item.id})">${cfg.icone} ${cfg.texto}</button>
  </td>`;
}

// Editável = DFD aberto E o setor do item ainda não finalizado — OU um
// pedido de edição aprovado (uso único, ver liberado). Mesma trava do
// servidor (requireDfdEditavel em routes/pac.js), só pra não oferecer no
// front uma ação que vai voltar 409 na certa.
function itemEditavel(item, liberado) {
  if (liberado && liberado.has('editar')) return true;
  return _dfdAtual.status === 'aberto' && !_finalizacaoPorSetor[item.setor_id];
}

function renderCelula(item, coluna, indice, liberado) {
  const classe = indice === 0 ? 'dfd-col-fixa-1' : indice === 1 ? 'dfd-col-fixa-2' : '';
  const valor = coluna.slug === 'numero_item' ? item.numero_item : item.valores[coluna.id];
  const editavel = itemEditavel(item, liberado);

  if (coluna.tipo_input === 'auto') {
    return `<td class="${classe}" data-label="${coluna.label}">${valor ?? ''}</td>`;
  }
  if (!editavel) {
    return `<td class="${classe}" data-label="${coluna.label}">${formatarValorExibicao(coluna, valor)}</td>`;
  }
  // Editável só por causa de um pedido de edição aprovado (uso único) —
  // ganha um botão "Salvar" explícito, não só o salvamento implícito no
  // blur/change. Pedido do Alex, 2026-09-08: "com botão salvar hoje não
  // tem" — como isso consome a autorização de uma vez só, o clique
  // deliberado deixa mais claro o que está acontecendo do que só tirar o
  // foco do campo sem querer.
  const somenteViaLiberado = !(_dfdAtual.status === 'aberto' && !_finalizacaoPorSetor[item.setor_id]);
  // Campo obrigatório (grupo A) ainda em branco — destaque visual direto no
  // campo, além do aviso já existente no topo da página (pedido do Alex,
  // 2026-09-15). "numero_item" nunca é editável aqui (tipo 'auto'), não
  // precisa excluir de novo.
  const pendente = coluna.grupo === 'A' && (valor === undefined || valor === null || String(valor).trim() === '');
  return `<td class="${classe}" data-label="${coluna.label}">${renderInputCelula(item.id, coluna, valor, somenteViaLiberado, pendente)}</td>`;
}

function formatarValorExibicao(coluna, valor) {
  if (valor === null || valor === undefined || valor === '') return '—';
  if (coluna.tipo_input === 'data') return fmtBr(valor);
  if (coluna.tipo_input === 'moeda') return 'R$ ' + fmtMoeda(valor);
  if (coluna.slug === 'fonte_pagadora') return textoRateioFonte(valor) || valor;
  return valor;
}

/* ── Rateio de fonte pagadora (item pode ratear entre 2+ fontes por %) ──────
   Coluna "fonte_pagadora" continua um <select> simples pro caso comum (1
   fonte só = 100% automático, sem precisar abrir nada); o botão "⚖" ao lado
   abre este modal pra marcar 2+ fontes com percentual — o valor salvo na
   MESMA coluna (dfd_itens_valores, sem tabela nova) passa a ser um JSON tipo
   {"TU":60,"RDC":40} em vez do texto simples quando há 2+ fontes. Pedido do
   Alex, 2026-09-16 — ficou de fora de Parâmetros de propósito (lá só cadastra
   os TIPOS possíveis; o rateio é por item, na hora de lançar). */
function parseRateioFonte(valor) {
  if (!valor) return null;
  const s = String(valor).trim();
  if (!s.startsWith('{')) return null;
  try {
    const obj = JSON.parse(s);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch { return null; }
}
function textoRateioFonte(valor) {
  const rateio = parseRateioFonte(valor);
  if (!rateio) return null;
  return Object.entries(rateio).map(([f, p]) => `${f} ${p}%`).join(' / ');
}

let _rfItemId = null, _rfColunaId = null;

function abrirModalRateioFonte(itemId, colunaId) {
  const item = _itensAtuais.find(i => i.id === itemId);
  if (!item) return;
  _rfItemId = itemId; _rfColunaId = colunaId;
  const valorAtual = item.valores[colunaId];
  const rateioAtual = parseRateioFonte(valorAtual) || (valorAtual ? { [valorAtual]: 100 } : {});
  const opcoes = (_listasCache.fonte_pagadora || []).map(o => o.valor);
  document.getElementById('rateio-fonte-linhas').innerHTML = opcoes.map(op => `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <label style="display:flex;align-items:center;gap:6px;flex:1;cursor:pointer;">
        <input type="checkbox" id="rf-chk-${op}" ${rateioAtual[op] != null ? 'checked' : ''} onchange="atualizarTotalRateioFonte()"> ${op}
      </label>
      <input type="number" id="rf-pct-${op}" min="0" max="100" step="0.01" value="${rateioAtual[op] ?? ''}"
        style="width:80px;text-align:right;" placeholder="%" oninput="atualizarTotalRateioFonte()">
    </div>`).join('');
  document.getElementById('rateio-fonte-msg').textContent = '';
  atualizarTotalRateioFonte();
  document.getElementById('modal-rateio-fonte').classList.add('open');
}
function fecharModalRateioFonte() {
  document.getElementById('modal-rateio-fonte').classList.remove('open');
  _rfItemId = null; _rfColunaId = null;
}
function lerRateioFonteForm() {
  const opcoes = (_listasCache.fonte_pagadora || []).map(o => o.valor);
  const rateio = {};
  opcoes.forEach(op => {
    const chk = document.getElementById(`rf-chk-${op}`);
    if (chk && chk.checked) rateio[op] = Number(document.getElementById(`rf-pct-${op}`).value) || 0;
  });
  return rateio;
}
function atualizarTotalRateioFonte() {
  const rateio = lerRateioFonteForm();
  const total = Object.values(rateio).reduce((s, v) => s + v, 0);
  const el = document.getElementById('rateio-fonte-total');
  if (!el) return;
  el.textContent = `Total: ${total}%`;
  el.style.color = Math.abs(total - 100) < 0.01 ? 'var(--verde,#2E7D32)' : '#c0392b';
}
async function salvarRateioFonte() {
  const rateio = lerRateioFonteForm();
  const fontes = Object.keys(rateio);
  const msg = document.getElementById('rateio-fonte-msg');
  if (!fontes.length) { msg.textContent = 'Marque ao menos uma fonte pagadora.'; return; }
  const total = fontes.reduce((s, f) => s + rateio[f], 0);
  if (Math.abs(total - 100) > 0.01) { msg.textContent = `A soma dos percentuais precisa ser 100% (está em ${total}%).`; return; }
  // 1 fonte só = mesmo formato simples de sempre (texto puro) — não vira
  // JSON pra um caso que já era 100% implícito, sem mudar nada de quem nunca
  // usar rateio.
  const valor = fontes.length === 1 ? fontes[0] : JSON.stringify(rateio);
  try {
    const res = await fetch(`/api/pac/itens/${_rfItemId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valores: { [_rfColunaId]: valor } }),
    });
    if (res.status === 409) { const e = await res.json(); msg.textContent = e.error || 'Não foi possível salvar.'; return; }
    if (!res.ok) { const e = await res.json().catch(() => ({})); msg.textContent = e.error || 'Erro ao salvar.'; return; }
    fecharModalRateioFonte();
    await renderItens();
    renderFinalizacao();
    toast('Rateio da fonte pagadora salvo.');
  } catch { msg.textContent = 'Erro ao salvar.'; }
}

function renderInputCelula(itemId, coluna, valor, comBotaoSalvar, pendente) {
  const domId = `campo-${itemId}-${coluna.id}`;
  const base = `id="${domId}" data-item="${itemId}" data-coluna="${coluna.id}" data-tipo="${coluna.tipo_input}"`;
  const classePendente = pendente ? ' campo-pendente' : '';
  const botaoSalvar = comBotaoSalvar
    ? ` <button type="button" class="btn btn-primary btn-xs" style="vertical-align:middle;" onclick="salvarCampoItem(document.getElementById('${domId}'))" title="Salvar">💾</button>`
    : '';
  if (coluna.tipo_input === 'select') {
    // Fonte Pagadora ganha um botão "⚖" ao lado pra ratear entre 2+ fontes
    // por percentual (pedido do Alex, 2026-09-16) — o <select> comum some
    // quando já existe um rateio salvo (edição de rateio só pelo modal,
    // senão o select sobrescreveria o JSON com um valor único sem querer).
    if (coluna.slug === 'fonte_pagadora') {
      const rateio = parseRateioFonte(valor);
      const btnRateio = ` <button type="button" class="btn btn-secondary btn-xs" style="vertical-align:middle;" onclick="abrirModalRateioFonte(${itemId},${coluna.id})" title="Ratear entre mais de uma fonte pagadora">⚖</button>`;
      if (rateio) {
        return `<span class="${classePendente.trim()}" style="font-size:12.5px;white-space:nowrap;" title="${textoRateioFonte(valor)}">${textoRateioFonte(valor)}</span>${btnRateio}`;
      }
      const opcoesFonte = (_listasCache[coluna.lista] || []).map(o =>
        `<option value="${o.valor}" ${o.valor === valor ? 'selected' : ''}>${o.valor}</option>`).join('');
      return `<select ${base} class="${classePendente.trim()}" style="width:110px;"><option value="">${pendente ? 'Item não preenchido' : '—'}</option>${opcoesFonte}</select>${btnRateio}`;
    }
    const opcoes = (_listasCache[coluna.lista] || []).map(o =>
      `<option value="${o.valor}" ${o.valor === valor ? 'selected' : ''}>${o.valor}</option>`).join('');
    // Largura FIXA (não só min-width) — pedido do Alex, 2026-09-15: uma opção
    // errada/comprida demais vinda da importação (ex.: valor de Unidade
    // bugado) fazia o navegador dimensionar o <select> fechado pela opção
    // mais larga da LISTA inteira, mesmo sem estar selecionada — a coluna
    // "esticava" e desalinhava as seguintes (Qtd/Valor Estimado apareciam
    // deslocadas, "dentro" de Unidade). width fixo tira esse comportamento;
    // Unidade especificamente volta ao tamanho normal (é sempre texto curto).
    const largura = coluna.slug === 'unidade_medida' ? 90 : 150;
    const tituloAtual = valor ? ` title="${String(valor).replace(/"/g, '&quot;')}"` : '';
    return `<select ${base} class="${classePendente.trim()}" style="width:${largura}px;max-width:${largura}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"${tituloAtual}><option value="">${pendente ? 'Item não preenchido' : '—'}</option>${opcoes}</select>${botaoSalvar}`;
  }
  if (coluna.tipo_input === 'textarea') {
    return `<textarea ${base} class="${classePendente.trim()}" rows="1" style="min-width:200px;" placeholder="${pendente ? 'Item não preenchido' : ''}">${valor || ''}</textarea>${botaoSalvar}`;
  }
  if (coluna.tipo_input === 'moeda') {
    return `<input type="text" ${base} class="${classePendente.trim()}" value="${valor != null ? fmtMoeda(valor) : ''}" style="width:110px;text-align:right;" placeholder="${pendente ? 'Item não preenchido' : '0,00'}" />${botaoSalvar}`;
  }
  if (coluna.tipo_input === 'numero') {
    return `<input type="number" ${base} class="${classePendente.trim()}" value="${valor ?? ''}" style="width:80px;" step="any" placeholder="${pendente ? 'Não preenchido' : ''}" />${botaoSalvar}`;
  }
  if (coluna.tipo_input === 'data') {
    return `<input type="date" ${base} class="${classePendente.trim()}" value="${valor || ''}" style="width:140px;" />${botaoSalvar}`;
  }
  return `<input type="text" ${base} class="${classePendente.trim()}" value="${valor || ''}" style="min-width:140px;" placeholder="${pendente ? 'Item não preenchido' : ''}" />${botaoSalvar}`;
}

/* ── Popup "Dados do contrato" (grupo C) — aberto pela coluna única Contrato ── */

let _mcItemId = null;
let _mcModoCriacao = false;
let _mcSetorNovo = null;

function abrirModalContrato(itemId) {
  const item = _itensAtuais.find(i => i.id === itemId);
  if (!item) return;
  _mcModoCriacao = false;
  _mcSetorNovo = null;
  _mcItemId = itemId;
  const colunasContrato = _dfdAtual.colunas.filter(c => c.grupo === 'C');
  const liberado = _pedidosLiberados[itemId] || new Set();
  const editavel = _dfdAtual.status === 'aberto' || liberado.has('editar');
  const estado = estadoContrato(item);

  const selectPossui = document.getElementById('mc-possui');
  // "Não informado" só aparece como opção quando o item JÁ está nesse estado
  // (dado histórico importado) — não faz sentido oferecer isso pra alguém
  // respondendo um item lançado ao vivo, só existe pra não perder a marca
  // sem querer ao abrir/salvar o popup de um item migrado.
  document.getElementById('mc-opcao-nao-informado').hidden = estado !== 'nao_informado';
  selectPossui.value = estado === 'pendente' ? 'nao' : estado;
  selectPossui.disabled = !editavel;

  document.getElementById('mc-subtitulo').textContent = '';
  document.getElementById('mc-campos').innerHTML = colunasContrato.map(c => {
    const valor = item.valores[c.id];
    const campo = editavel ? renderInputCelula(itemId, c, valor) : `<div style="padding:8px 0;">${formatarValorExibicao(c, valor)}</div>`;
    return `<div class="form-group" style="margin-bottom:10px;"><label>${c.label}</label>${campo}</div>`;
  }).join('') || '<p class="text-muted">Nenhuma coluna de contrato ativa neste DFD.</p>';

  mcAtualizarVisibilidadeCampos();
  document.getElementById('mc-salvar').style.display = editavel ? '' : 'none';
  document.getElementById('mc-msg').textContent = '';
  document.getElementById('modal-contrato').classList.add('open');
}

// Contrato é obrigatório antes do item existir — "+ Novo item" não cria mais
// uma linha em branco direto; abre este popup primeiro (Sim/Não já aqui),
// e só cria o item de fato em salvarContrato() quando o usuário confirmar.
// Sem isso dava pra clicar "+ Novo item" e nunca mais tocar no Contrato.
function abrirModalContratoNovoItem(setorId) {
  _mcModoCriacao = true;
  _mcItemId = null;
  _mcSetorNovo = Number(setorId);
  const colunasContrato = _dfdAtual.colunas.filter(c => c.grupo === 'C');
  const nomeSetor = (_meusSetores.find(s => s.id === _mcSetorNovo) || {}).nome;

  const selectPossui = document.getElementById('mc-possui');
  selectPossui.value = 'nao';
  selectPossui.disabled = false;

  document.getElementById('mc-subtitulo').textContent = `Novo item${nomeSetor ? ' — ' + nomeSetor : ''}`;
  document.getElementById('mc-campos').innerHTML = colunasContrato.map(c =>
    `<div class="form-group" style="margin-bottom:10px;"><label>${c.label}</label>${renderInputCelula('novo', c, '')}</div>`
  ).join('') || '<p class="text-muted">Nenhuma coluna de contrato ativa neste DFD.</p>';

  mcAtualizarVisibilidadeCampos();
  document.getElementById('mc-salvar').style.display = '';
  document.getElementById('mc-msg').textContent = '';
  document.getElementById('modal-contrato').classList.add('open');
}

// Os campos de contrato (grupo C) só fazem sentido enquanto "Sim" está
// selecionado — evita a confusão de mostrar Nº/Razão Social/Vencimento
// junto de um "Não" (era exatamente essa mistura que deixava a lógica pouco clara).
function mcAtualizarVisibilidadeCampos() {
  const sim = document.getElementById('mc-possui').value === 'sim';
  document.getElementById('mc-campos').style.display = sim ? '' : 'none';
}

function fecharModalContrato() {
  document.getElementById('modal-contrato').classList.remove('open');
  _mcItemId = null;
  _mcModoCriacao = false;
  _mcSetorNovo = null;
}

// "Possui Contrato?" (grupo B) não aparece mais como coluna própria na
// tabela, mas agora tem um lugar explícito no popup (o seletor Sim/Não) em vez
// de ser deduzido silenciosamente do preenchimento dos campos — era isso que
// deixava a lógica pouco clara. Se "Não", os campos de C são zerados.
function valoresContratoDoForm() {
  const colunasContrato = _dfdAtual.colunas.filter(c => c.grupo === 'C');
  const escolha = document.getElementById('mc-possui').value; // 'sim' | 'nao' | 'nao_informado'
  const valores = {};
  if (escolha === 'sim') {
    document.querySelectorAll('#mc-campos [data-coluna]').forEach(el => {
      let v = el.value;
      if (el.dataset.tipo === 'moeda') { const n = parseMoeda(v); v = n == null ? '' : String(n); }
      valores[el.dataset.coluna] = v === '' ? null : v;
    });
  } else if (escolha === 'nao_informado') {
    // Mantém a marca de dado histórico (mesma convenção da importação: texto
    // vira "Não informado", data fica NULL — ver routes/pac-importacao.js).
    colunasContrato.forEach(c => { valores[c.id] = c.tipo_input === 'data' ? null : 'Não informado'; });
  } else {
    // "Não" precisa ficar distinguível de "ainda não respondido" (ver
    // estadoContrato) — os campos de texto/número seguem nulos, mas a coluna
    // de data ganha uma sentinela (01/01/1900) em vez de NULL, porque
    // "Sem contrato" é uma resposta completa e definitiva, não uma ausência.
    colunasContrato.forEach(c => { valores[c.id] = c.tipo_input === 'data' ? '1900-01-01' : null; });
  }
  const possuiCol = _dfdAtual.colunas.find(c => c.slug === 'possui_contrato');
  if (possuiCol) valores[possuiCol.id] = escolha === 'sim' ? 'Sim' : escolha === 'nao_informado' ? 'Não informado' : 'Não';
  return valores;
}

async function salvarContrato() {
  const valores = valoresContratoDoForm();
  try {
    const res = _mcModoCriacao
      ? await fetch(`/api/pac/dfds/${_dfdAtualId}/itens`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setor_id: _mcSetorNovo, valores }),
        })
      : await fetch(`/api/pac/itens/${_mcItemId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ valores }),
        });
    if (res.status === 409) {
      const e = await res.json();
      // "Pedido de edição" só faz sentido pra item que já EXISTE — em modo de
      // criação (_mcModoCriacao, _mcItemId ainda é null) o servidor nega com
      // o mesmo pedeEdicao:true (setor já finalizado), mas ofertarPedidoEdicao
      // fechava o modal na hora e abria um confirm() falando em "editar este
      // item" pra um item que nunca chegou a existir — parecia que tinha
      // salvo (modal sumia sem erro visível) quando na verdade tinha sido
      // corretamente bloqueado. Achado pelo Alex testando de verdade,
      // 2026-09-08. Em criação, só mostra a mensagem de erro mesmo.
      if (e.pedeEdicao && !_mcModoCriacao) { fecharModalContrato(); ofertarPedidoEdicao(_mcItemId); return; }
      document.getElementById('mc-msg').style.color = '#c00';
      document.getElementById('mc-msg').textContent = e.error || 'Não foi possível salvar.';
      return;
    }
    if (!res.ok) {
      document.getElementById('mc-msg').style.color = '#c00';
      document.getElementById('mc-msg').textContent = await mensagemErro(res, 'Não foi possível salvar.');
      return;
    }
    if (!_mcModoCriacao && _dfdAtual.status !== 'aberto') await renderMeusPedidos();
    fecharModalContrato();
    renderItens();
  } catch {
    document.getElementById('mc-msg').style.color = '#c00';
    document.getElementById('mc-msg').textContent = 'Erro ao salvar.';
  }
}


let _listasCache = {};

async function carregarListas() {
  const listas = [...new Set(_dfdAtual.colunas.filter(c => c.lista).map(c => c.lista))];
  const entradas = await Promise.all(listas.map(async l => {
    const res = await fetch(`/api/pac/parametros?lista=${encodeURIComponent(l)}`);
    return [l, res.ok ? (await res.json()).filter(p => p.ativo) : []];
  }));
  _listasCache = Object.fromEntries(entradas);
}

function wireCelulas() {
  document.querySelectorAll('#lanc-itens-tbody [data-item][data-coluna]').forEach(el => {
    const evento = (el.tagName === 'SELECT') ? 'change' : 'blur';
    el.addEventListener(evento, () => salvarCampoItem(el));
  });
}

async function salvarCampoItem(el) {
  const itemId = el.dataset.item;
  const colunaId = el.dataset.coluna;
  const tipo = el.dataset.tipo;
  let valor = el.value;
  if (tipo === 'moeda') { const n = parseMoeda(valor); valor = n == null ? '' : String(n); el.value = valor === '' ? '' : fmtMoeda(n); }

  try {
    const res = await fetch(`/api/pac/itens/${itemId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valores: { [colunaId]: valor === '' ? null : valor } }),
    });
    if (res.status === 409) {
      const e = await res.json();
      if (e.pedeEdicao) { ofertarPedidoEdicao(itemId); return; }
      toast(e.error || 'Não foi possível salvar.', 'error');
      return;
    }
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      if (e.especificacaoMinima) { abrirModalEspecificacaoMin(e.especificacaoMinima.mensagem); return; }
      toast(e.error || 'Erro ao salvar campo', 'error');
      return;
    }
    // Edição sob um pedido aprovado consome o pedido (uso único) — recarrega
    // pra refletir que a linha volta a ficar bloqueada.
    if (_dfdAtual.status !== 'aberto') { await renderMeusPedidos(); await renderItens(); return; }
    // Atualiza o item em memória e reroda o aviso de pendência na hora — sem
    // isso, corrigir um campo em branco só refletia depois de um F5 (pedido
    // do Alex, 2026-09-07). Se o filtro "só pendências" está ligado, o item
    // corrigido pode sair da lista — renderItens() de novo cobre isso.
    const item = _itensAtuais.find(i => String(i.id) === String(itemId));
    if (item) {
      item.valores = item.valores || {};
      item.valores[colunaId] = valor === '' ? null : valor;
    }
    // Tira (ou recoloca) o destaque vermelho na hora, sem esperar um F5 —
    // bug relatado pelo Alex, 2026-09-15: preencher um campo obrigatório
    // não limpava o vermelho sozinho até recarregar a página.
    const coluna = (_dfdAtual.colunas || []).find(c => String(c.id) === String(colunaId));
    if (coluna && coluna.grupo === 'A') {
      el.classList.toggle('campo-pendente', valor === '' || valor == null);
    }
    // Troca o botão "✅ Concluir" por um selo "✅ Completo" assim que o item
    // deixa de ter pendência, e volta pro botão se um campo obrigatório for
    // limpo de novo depois — nunca só REMOVE sem deixar rastro (era assim
    // até v4.24.0: sumia sozinho sem clique nenhum, o Alex relatou como bug
    // de confundir, 2026-09-16 — a v4.24.0 anterior tinha corrigido uma
    // reclamação de "clicar de novo confirma algo que já tava certo", mas
    // trocou por um problema pior). O campo continua editável do mesmo jeito
    // depois disso — o selo é só indicativo, nunca trava nada.
    const linha = document.querySelector(`[data-item-id="${itemId}"]`);
    const celulaAcoes = linha?.querySelector('td:last-child');
    const btnConcluir = celulaAcoes?.querySelector('button[onclick^="concluirItem("]');
    const seloCompleto = celulaAcoes?.querySelector('.pac-item-completo');
    if (item && !itemTemPendencia(item)) {
      if (btnConcluir) btnConcluir.outerHTML = `<span class="pac-item-completo" style="color:var(--verde,#2E7D32);font-size:12px;font-weight:600;white-space:nowrap;">✅ Completo</span>`;
    } else if (item && seloCompleto) {
      seloCompleto.outerHTML = `<button class="btn btn-primary btn-xs" onclick="concluirItem(${itemId})" title="Confere se falta algo e confirma">✅ Concluir</button>`;
    }
    if (document.getElementById('lanc-filtro-pendencia')?.checked) await renderItens();
    renderFinalizacao();
  } catch {
    toast('Erro ao salvar campo', 'error');
  }
}

// "Salvar item" explícito — pedido do Alex, 2026-09-15: "hoje quando termina
// fica confuso se aperta tab ou enter". Cada campo já salva sozinho ao sair
// dele (wireCelulas/salvarCampoItem, blur/change) — este botão não manda
// nada de novo, só confirma pro usuário que não falta campo (mesmo critério
// de itemTemPendencia) e, se faltar, rola até o primeiro campo em branco em
// vez de deixar ele procurando na tabela.
function concluirItem(itemId) {
  const item = _itensAtuais.find(i => String(i.id) === String(itemId));
  if (!item) return;
  if (!itemTemPendencia(item)) {
    toast('Item completo — todos os campos já estão salvos.', 'success');
    return;
  }
  const colunas = (_dfdAtual.colunas || []).filter(c => c.grupo === 'A' && c.slug !== 'numero_item');
  const faltando = colunas.find(c => {
    const v = (item.valores || {})[c.id];
    return v === undefined || v === null || String(v).trim() === '';
  });
  toast(faltando ? `Falta preencher: ${faltando.label}` : 'Ainda há campo(s) em branco neste item.', 'error');
  if (faltando) {
    const campo = document.getElementById(`campo-${itemId}-${faltando.id}`);
    if (campo) { campo.scrollIntoView({ behavior: 'smooth', block: 'center' }); campo.focus(); }
  }
}

function abrirModalEspecificacaoMin(mensagem) {
  document.getElementById('esp-min-msg').textContent = mensagem;
  document.getElementById('modal-especificacao-min').classList.add('open');
}
function fecharModalEspecificacaoMin() {
  document.getElementById('modal-especificacao-min').classList.remove('open');
}

function ofertarPedidoEdicao(itemId) {
  if (!confirm('Este DFD está em análise. Deseja solicitar um pedido de edição para este item?')) return;
  abrirPedido(itemId, 'editar');
}

async function abrirPedido(itemId, tipo) {
  const justificativa = prompt(tipo === 'excluir' ? 'Justificativa para excluir este item:' : 'Justificativa para editar este item:');
  if (justificativa === null || !justificativa.trim()) return;
  try {
    const res = await fetch('/api/pac/pedidos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId, tipo, justificativa: justificativa.trim() }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    toast('Pedido enviado ao DEPLA.');
    renderMeusPedidos();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

async function excluirItem(itemId) {
  if (!confirm('Excluir este item?')) return;
  try {
    const res = await fetch(`/api/pac/itens/${itemId}`, { method: 'DELETE' });
    if (res.status === 409) {
      const e = await res.json();
      if (e.pedeEdicao) { ofertarPedidoEdicaoExcluir(itemId); return; }
      toast(e.error || 'Não foi possível excluir.', 'error');
      return;
    }
    if (!res.ok) { toast(await mensagemErro(res, 'Erro ao excluir item'), 'error'); return; }
    await renderItens();
    renderFinalizacao();
  } catch {
    toast('Erro ao excluir item', 'error');
  }
}

function ofertarPedidoEdicaoExcluir(itemId) {
  if (!confirm('Este DFD está em análise. Deseja solicitar um pedido de exclusão para este item?')) return;
  abrirPedido(itemId, 'excluir');
}

/* ── Novo item ───────────────────────────────────────────────────────────── */

function renderFormNovoItem() {
  const wrap = document.getElementById('lanc-novo-item');
  if (_dfdAtual.status !== 'aberto') { wrap.innerHTML = ''; return; }
  if (!_meusSetores.length) { wrap.innerHTML = '<span class="text-muted">Você não está vinculado a nenhum setor.</span>'; return; }

  // Setor já finalizado ("Finalizar meu DFD") não entra mais como opção pra
  // lançar item novo — a trava do servidor já bloqueia, isso só evita
  // oferecer uma ação que vai falhar na certa.
  const disponiveis = _meusSetores.filter(s => !_finalizacaoPorSetor[s.id]);
  if (!disponiveis.length) { wrap.innerHTML = '<span class="text-muted">Todos os seus setores já foram finalizados neste DFD.</span>'; return; }

  const selectSetor = disponiveis.length > 1
    ? `<select id="novo-item-setor" style="margin-right:10px;">${disponiveis.map(s => `<option value="${s.id}">${s.nome}</option>`).join('')}</select>`
    : `<input type="hidden" id="novo-item-setor" value="${disponiveis[0].id}" />`;

  wrap.innerHTML = `${selectSetor}<button class="btn btn-primary btn-sm" onclick="iniciarNovoItem()">+ Novo item</button>`;
}

// Contrato é obrigatório (ver abrirModalContratoNovoItem) — só pula direto
// pra criarItem() quando o DFD nem tem a coluna de contrato ativada.
// Só nasce um item novo depois do último (do mesmo setor) estar completo —
// pedido do Alex, 2026-09-15: clicar em "Novo" repetido sem preencher nada
// ia empilhando itens em branco.
function iniciarNovoItem() {
  const setorId = Number(document.getElementById('novo-item-setor').value);
  const pendentes = pendenciasDoSetor(setorId);
  if (pendentes.length) {
    const item = pendentes[0];
    const colunas = (_dfdAtual.colunas || []).filter(c => c.grupo === 'A' && c.slug !== 'numero_item');
    const faltando = colunas.find(c => {
      const v = (item.valores || {})[c.id];
      return v === undefined || v === null || String(v).trim() === '';
    });
    toast(`Finalize o item pendente antes de lançar outro${faltando ? ` (falta: ${faltando.label})` : ''}.`, 'error');
    const alvo = (faltando && document.getElementById(`campo-${item.id}-${faltando.id}`))
      || document.querySelector(`[data-item-id="${item.id}"]`);
    if (alvo) { alvo.scrollIntoView({ behavior: 'smooth', block: 'center' }); alvo.focus?.(); }
    return;
  }
  const temColContrato = _dfdAtual.colunas.some(c => c.grupo === 'C');
  if (temColContrato) {
    abrirModalContratoNovoItem(document.getElementById('novo-item-setor').value);
  } else {
    criarItem();
  }
}

async function criarItem() {
  const setorId = document.getElementById('novo-item-setor').value;
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/itens`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setor_id: Number(setorId), valores: {} }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    await renderItens();
    renderFinalizacao(); // item novo nasce com tudo em branco — pendência aparece na hora
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

/* ── Finalização por setor ("Finalizar meu DFD") ────────────────────────────
   Sinaliza ao DEPLA que o setor terminou de lançar — trava escrita nesse
   setor (mesma trava do DFD "em análise", ver requireDfdEditavel no
   servidor) mesmo com o DFD continuando aberto pros OUTROS setores. Um
   gestor com mais de um setor vinculado finaliza cada um separadamente. ── */

async function carregarStatusFinalizacao() {
  if (!_meusSetores.length) { _finalizacaoPorSetor = {}; return; }
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/status-finalizacao`);
    const info = res.ok ? await res.json() : { setores: [] };
    _finalizacaoPorSetor = Object.fromEntries(info.setores.map(s => [s.setor_id, s.finalizado_em]));
  } catch { _finalizacaoPorSetor = {}; }
}

// Item com algum campo do grupo A (o "corpo" do lançamento, exceto Contrato
// — que tem regra própria, vazio lá vira "Não informado" na importação e
// isso NÃO conta como pendência) ainda em branco — mesmo critério de
// itensComPendencia() no servidor (routes/pac.js). Pedido do Alex,
// 2026-09-06/07: precisa aparecer ANTES de tentar finalizar, e dar pra ver a
// lista completa (não só os 5 primeiros), não só um erro depois do clique.
function itemTemPendencia(item) {
  const colunas = (_dfdAtual.colunas || []).filter(c => c.grupo === 'A' && c.slug !== 'numero_item');
  return colunas.some(c => {
    const v = (item.valores || {})[c.id];
    return v === undefined || v === null || String(v).trim() === '';
  });
}

function pendenciasDoSetor(setorId) {
  return _itensAtuais.filter(i => i.setor_id === setorId).filter(itemTemPendencia);
}

// Chamado DEPOIS de renderItens() — precisa de _itensAtuais pra só oferecer o
// botão quando o setor já tem ao menos 1 item lançado (Alex: "visível somente
// quando... o gestor tem ao menos 1 item lançado").
function renderFinalizacao() {
  // Indicadores da tela principal — mesmo gatilho de atualização que o resto
  // desta função (toda mudança que mexe em pendência/finalização também pode
  // mudar itens lançados/execução/valor estimado). Pedido do Alex,
  // 2026-09-08: "não deveríamos ter valores somando nesta tela?".
  renderKpisLancamento('lanc-kpis');

  // Botão+flyout — pedido do Alex, 2026-09-08 (2ª rodada, mesmo dia): "tudo
  // abaixo dos indicadores deve ser botão flutuante com a informação dentro
  // dele" (mesmo padrão do flyout de pedidos, ver alternarPedidosFlyout).
  const btn = document.getElementById('lanc-finalizar-btn');
  const badge = document.getElementById('lanc-finalizar-count');
  if (!btn) return;
  if (_dfdAtual.status !== 'aberto' || !_meusSetores.length) {
    btn.style.display = 'none';
    fecharFinalizarFlyout();
    return;
  }
  const pendentesPorSetor = _meusSetores.map(s => ({ setor: s, pendentes: pendenciasDoSetor(s.id).length }));
  const totalSetoresPendentes = pendentesPorSetor.filter(x => !_finalizacaoPorSetor[x.setor.id]).length;
  btn.style.display = '';
  if (totalSetoresPendentes > 0) {
    badge.style.display = '';
    badge.textContent = totalSetoresPendentes;
    badge.classList.add('alerta');
  } else {
    badge.style.display = 'none';
    badge.classList.remove('alerta');
  }

  document.getElementById('lanc-finalizar-corpo').innerHTML = _meusSetores.map(s => {
    const fin = _finalizacaoPorSetor[s.id];
    if (fin) return `<div class="lanc-fin-linha"><strong>${s.nome}:</strong> <span class="badge badge-aberto">✅ Finalizado em ${fmtBr(String(fin).split(' ')[0])}</span></div>`;
    const temItem = _itensAtuais.some(i => i.setor_id === s.id);
    if (!temItem) return '';
    const pendentes = pendenciasDoSetor(s.id);
    if (pendentes.length) {
      const souMaster = _usuarioPac && _usuarioPac.username === 'master';
      return `<div class="lanc-fin-linha lanc-fin-pendente">
        <strong>${s.nome}:</strong>
        <span class="text-muted">⚠️ ${pendentes.length} item(ns) com campo(s) em branco — preencha antes de finalizar.</span>
        <button type="button" class="btn btn-secondary btn-xs" onclick="verPendenciasSetor()">Ver todos</button>
        ${souMaster
          ? `<button class="btn btn-secondary btn-xs" onclick="finalizarMeuSetor(${s.id}, true)" title="Só master: finaliza mesmo com pendência">Finalizar assim mesmo (master)</button>`
          : `<button class="btn btn-secondary btn-xs" disabled title="Preencha os campos em branco antes de finalizar">Finalizar meu DFD</button>`}
      </div>`;
    }
    return `<div class="lanc-fin-linha"><strong>${s.nome}:</strong> <button class="btn btn-secondary btn-xs" onclick="finalizarMeuSetor(${s.id})">Finalizar meu DFD</button></div>`;
  }).join('');
}

function alternarFinalizarFlyout() {
  const flyout = document.getElementById('lanc-finalizar-flyout');
  flyout.style.display = flyout.style.display === 'none' ? 'block' : 'none';
}
function fecharFinalizarFlyout() {
  document.getElementById('lanc-finalizar-flyout').style.display = 'none';
}

// Liga o filtro "só itens com campo em branco" e rola até a tabela — atalho
// do botão "Ver todos" no aviso de pendência (que só cita a contagem, não a
// lista, ver renderFinalizacao()).
function verPendenciasSetor() {
  const checkbox = document.getElementById('lanc-filtro-pendencia');
  checkbox.checked = true;
  renderItens();
  document.getElementById('lanc-itens-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Botão "🔄 Atualizar" — pedido do Alex, 2026-09-07: depois de corrigir um
// item, o aviso de pendência não se atualizava sozinho (precisava de F5).
// salvarCampoItem() já corrige isso pra edição de campo direto na tabela;
// este botão cobre o resto (pedido aprovado por outra aba/pessoa, etc.).
async function atualizarLancamento() {
  await carregarStatusFinalizacao();
  await renderItens();
  renderFinalizacao();
  toast('Atualizado.');
}

async function finalizarMeuSetor(setorId, forcar) {
  const aviso = forcar
    ? 'Existem itens com campo(s) em branco. Como master, você pode finalizar assim mesmo — confirma?'
    : 'Ao finalizar, você não poderá mais incluir ou editar itens deste setor sem solicitar autorização ao DEPLA. Confirmar?';
  if (!confirm(aviso)) return;
  try {
    const res = await fetch(`/api/pac/dfds/${_dfdAtualId}/setores/${setorId}/finalizar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ forcar: !!forcar }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    toast('Setor finalizado.');
    await carregarStatusFinalizacao();
    await renderItens();
    renderFinalizacao();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

/* ── Meus pedidos ────────────────────────────────────────────────────────── */

// Mensageria "viva" — pedido do Alex, 2026-09-08: o indicador de número do
// SOLICITANTE (aqui) só conta respostas que ele ainda não abriu pra ler
// (aprovado/rejeitado com visualizado_pelo_solicitante_em nulo) — pedido
// ainda "pendente" (esperando o DEPLA) não conta pra ele, esse número é do
// DEPLA (pac-cnt-pedidos em pac-gestao.js, já existia). Abrir o flyout marca
// tudo como lido (marcarPedidosLidos) e o número some.
async function renderMeusPedidos() {
  const res = await fetch('/api/pac/pedidos');
  const pedidos = res.ok ? await res.json() : [];
  const doDfd = pedidos.filter(p => p.dfd_id === _dfdAtualId);

  _pedidosLiberados = {};
  doDfd.forEach(p => {
    if (p.status === 'aprovado' && !p.consumido_em && p.item_id) {
      (_pedidosLiberados[p.item_id] ??= new Set()).add(p.tipo);
    }
  });

  const btn = document.getElementById('lanc-pedidos-btn');
  if (!doDfd.length) {
    btn.style.display = 'none';
    fecharPedidosFlyout();
    return;
  }
  btn.style.display = '';
  const naoLidos = doDfd.filter(p => ['aprovado', 'rejeitado'].includes(p.status) && !p.visualizado_pelo_solicitante_em).length;
  const badge = document.getElementById('lanc-pedidos-count');
  badge.textContent = naoLidos || doDfd.length;
  badge.classList.toggle('alerta', naoLidos > 0);
  document.getElementById('lanc-pedidos-tbody').innerHTML = doDfd.map(p => {
    const clicavel = p.status === 'aprovado' && p.item_id;
    const statusTexto = p.status === 'rejeitado' && p.bloqueado ? 'rejeitado (definitivo)' : p.status;
    const podeContestar = p.status === 'rejeitado' && !p.bloqueado;
    return `
    <tr${clicavel ? ` style="cursor:pointer;" onclick="irParaItemDoPedido(${p.item_id})" title="Ir para o item"` : ''}>
      <td>#${p.item_id ?? '—'}</td>
      <td>${p.tipo}</td>
      <td>${p.justificativa || '—'}</td>
      <td>${statusTexto}</td>
      <td>${p.resposta || '—'}${podeContestar ? ` <button type="button" class="btn btn-secondary btn-xs" onclick="event.stopPropagation(); contestarPedido(${p.id})">Contestar</button>` : ''}</td>
    </tr>`;
  }).join('');
}

async function marcarPedidosLidos() {
  try { await fetch('/api/pac/pedidos/marcar-lidos', { method: 'POST' }); } catch {}
}

// Discorda de uma rejeição e manda um novo porquê — só funciona 1 vez (ver
// tentativa/bloqueado em routes/pac.js). Pedido do Alex, 2026-09-08: "o
// gestor do setor aceita ou não, ele pode recusar e enviar o porquê".
async function contestarPedido(pedidoId) {
  const justificativa = prompt('Por que você está contestando essa rejeição?');
  if (justificativa === null || !justificativa.trim()) return;
  try {
    const res = await fetch(`/api/pac/pedidos/${pedidoId}/contestar`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ justificativa: justificativa.trim() }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    toast('Contestação enviada — voltou pra fila do DEPLA.');
    await renderMeusPedidos();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

function alternarPedidosFlyout() {
  const flyout = document.getElementById('lanc-pedidos-flyout');
  const abrindo = flyout.style.display === 'none';
  flyout.style.display = abrindo ? 'block' : 'none';
  if (abrindo) marcarPedidosLidos().then(renderMeusPedidos);
}
function fecharPedidosFlyout() {
  document.getElementById('lanc-pedidos-flyout').style.display = 'none';
}
function fecharFlyoutSeClicouFora(e, flyoutId, btnId, fechar) {
  const flyout = document.getElementById(flyoutId);
  const btn = document.getElementById(btnId);
  if (flyout && flyout.style.display !== 'none' && !flyout.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
    fechar();
  }
}
document.addEventListener('click', e => {
  fecharFlyoutSeClicouFora(e, 'lanc-pedidos-flyout', 'lanc-pedidos-btn', fecharPedidosFlyout);
  fecharFlyoutSeClicouFora(e, 'lanc-finalizar-flyout', 'lanc-finalizar-btn', fecharFinalizarFlyout);
});
// Clicar num pedido aprovado no flyout já leva direto pro item — pedido do
// Alex, 2026-09-08: "se tiver item aprovado clicando nele já vai para o
// item". A <tr> da tabela de itens já tem data-item-id (ver renderItens).
function irParaItemDoPedido(itemId) {
  fecharPedidosFlyout();
  const row = document.querySelector(`tr[data-item-id="${itemId}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('item-destaque');
  setTimeout(() => row.classList.remove('item-destaque'), 2000);
}
