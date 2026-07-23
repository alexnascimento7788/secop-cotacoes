// ── Utilitários ───────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
const processoId = params.get('id');

function fmtBr(iso) {
  if (!iso) return '—';
  // Separador entre data e hora varia: 'T' em datas ISO, espaço em DATETIME do SQLite (criado_em)
  const d = iso.split(/[T ]/)[0].split('-');
  if (d.length < 3) return iso;
  return `${d[2]}/${d[1]}/${d[0]}`;
}

// "Incluso Frete" (Sim/Não) e "Termo" (CIF/FOB) são marcações independentes.
// Normaliza também registros salvos na janela entre v3.8.2 e v3.8.3, quando
// CIF/FOB ainda podiam vir gravados direto em "frete" (sem frete_termo existir).
function normalizarFrete(f) {
  let frete = f.frete || '';
  let termo = f.frete_termo || '';
  if (!termo && (frete === 'CIF' || frete === 'FOB')) { termo = frete; frete = ''; }
  else if (frete === 'Incluso') { frete = 'Sim'; }
  return { frete, termo };
}

function fmtFrete(f) {
  const { frete, termo } = normalizarFrete(f);
  const partes = [];
  if (frete) partes.push(frete);
  if (termo) partes.push(termo);
  return partes.length ? partes.join(' — ') : '—';
}

function fmtMoeda(v) {
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '';
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  setTimeout(() => { el.className = ''; }, 3500);
}

// ── Estado global ─────────────────────────────────────────────────────────────

let processo          = null;
let fornecedores      = [];
let itens             = [];
let precos            = {}; // { `${item_id}_${forn_id}`: { preco_unitario_mes, preco_total_ano } }
let vencedorId        = null;
let mostrarMenorPreco = true;
let totaisForn        = {}; // { fornId: totalValue } — soma de tudo (R$ + percentual), usada pra ranking/menor-preço
let totaisFornMoeda   = {}; // { fornId: totalValue } — só a parte em R$ (itens normais + extras fixos), usada só pra decidir o formato de exibição
let podeEditarCotacao = true;
let tiposExtra        = []; // catálogo Unidade+Descrição+Sinal (Configurações → Itens Extras)

// Sinal (positivo/negativo) e tipo de valor (fixo em R$ ou percentual) vêm do
// catálogo tipos_extra, amarrados à Unidade da linha extra
function sinalDoTipo(unidade) {
  const t = tiposExtra.find(x => x.unidade === unidade);
  return t?.sinal === 'negativo' ? 'negativo' : 'positivo';
}
function tipoValorDoTipo(unidade) {
  const t = tiposExtra.find(x => x.unidade === unidade);
  return t?.tipo_valor === 'percentual' ? 'percentual' : 'fixo';
}

// Exibe o valor de uma linha extra com o sinal do tipo em destaque: "(-) R$ 30,00" / "(+) R$ 50,00"
function fmtMoedaExtra(v, sinal) {
  const abs = Math.abs(parseFloat(v)) || 0;
  return `${sinal === 'negativo' ? '(-)' : '(+)'} ${fmtMoeda(abs)}`;
}
// Idem, para linha extra percentual: "(-) 10%" / "(+) 5%". O número entra somado
// direto no VALOR TOTAL igual a uma linha fixa (sem calcular sobre nenhuma base) —
// decisão explícita do Alex em 2026-07-23, pode ser revista se o uso real pedir
// um percentual calculado sobre uma base específica no futuro.
function fmtPercentualExtra(v, sinal) {
  const abs = Math.abs(parseFloat(v)) || 0;
  return `${sinal === 'negativo' ? '(-)' : '(+)'} ${abs}%`;
}

function aplicarPermissaoUI() {
  document.getElementById('status-select').disabled  = !podeEditarCotacao;
  document.getElementById('chk-menor-preco').disabled = !podeEditarCotacao;
  document.getElementById('btn-salvar-obs').style.display = podeEditarCotacao ? '' : 'none';
  document.getElementById('obs-geral').readOnly  = !podeEditarCotacao;
  document.getElementById('obs-portal').readOnly = !podeEditarCotacao;
}

// ── Labels de coluna (lidas do localStorage — editadas em fornecedor.html) ────

function getColLabel(key) {
  return localStorage.getItem(`secop_col_${key}_${processoId}`) || (key === 'unit' ? 'R$ UNIT/MÊS' : 'R$ TOTAL/ANO');
}

// ── Labels das observações (editáveis aqui mesmo, salvos por processo) ────────

function getObsLabel(key) {
  return localStorage.getItem(`secop_obs_${key}_${processoId}`) || (key === 'geral' ? 'OBS-1' : 'OBS-2');
}

function aplicarLabelsObs() {
  document.getElementById('lbl-obs-geral').textContent  = getObsLabel('geral');
  document.getElementById('lbl-obs-portal').textContent = getObsLabel('portal');
}

function editarObsLabel(key) {
  const novo = prompt('Nome da observação:', getObsLabel(key));
  if (novo !== null && novo.trim()) {
    localStorage.setItem(`secop_obs_${key}_${processoId}`, novo.trim());
    aplicarLabelsObs();
  }
}

// ── Totais e ordenação por valor crescente ────────────────────────────────────

// NOTA (2026-07-23): linhas extras percentuais (tipos_extra.tipo_valor='percentual')
// somam o número digitado direto aqui, junto com tudo que já é R$ — não há cálculo
// de "X% sobre uma base". Decisão explícita do Alex: no uso real, quando o item é
// percentual os itens normais tendem a ficar em R$ 0, então a soma direta já
// representa o total pretendido. Se o uso mudar (itens com valor real + percentual
// junto), essa regra provavelmente precisa ser revista para calcular sobre uma base.
function computarTotais() {
  totaisForn = {};
  totaisFornMoeda = {};
  fornecedores.forEach(f => { totaisForn[f.id] = 0; totaisFornMoeda[f.id] = 0; });
  itens.forEach(item => {
    const sinalItem    = item.extra ? sinalDoTipo(item.unidade)     : null;
    const ehPercentual = item.extra && tipoValorDoTipo(item.unidade) === 'percentual';
    fornecedores.forEach(f => {
      const p   = precos[`${item.id}_${f.id}`] || {};
      const u   = p.preco_unitario_mes;
      const tot = p.preco_total_ano ?? (u != null ? u * item.quantidade : null);
      if (tot == null) return;
      let v = parseFloat(tot) || 0;
      // O sinal de uma linha extra é sempre relido do catálogo atual, não do que
      // foi gravado no preço — se o Sinal do tipo mudar depois de já ter valores
      // lançados (ex: "Taxa" virou Positivo), o total reflete a mudança na hora,
      // sem precisar re-salvar cada preço. Consistente com a exibição da própria
      // linha (fmtMoedaExtra/fmtPercentualExtra), que já faz a mesma releitura.
      if (item.extra) v = sinalItem === 'negativo' ? -Math.abs(v) : Math.abs(v);
      totaisForn[f.id] += v;
      if (!ehPercentual) totaisFornMoeda[f.id] += v; // só a parte em R$, pra decidir o formato de exibição do total
    });
  });
}

// Quando a parte em R$ do total de um fornecedor é zero e só sobrou valor vindo
// de linhas extras percentuais, o VALOR TOTAL deve ser exibido como percentual
// (ex: "-23,7%"), não como moeda — reflete o mesmo cenário descrito na nota acima
// (uso típico: itens normais em R$ 0, só o percentual carrega o valor real).
function totalEhPercentual(fId) {
  return (totaisFornMoeda[fId] || 0) === 0 && (totaisForn[fId] || 0) !== 0;
}

function fmtPercentualTotal(v) {
  const arred = Math.round(v * 100) / 100;
  return `${arred.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

function fmtTotalFornecedor(fId) {
  const v = totaisForn[fId] || 0;
  if (v === 0) return '—';
  return totalEhPercentual(fId) ? fmtPercentualTotal(v) : fmtMoeda(v);
}

// Fornecedor tem preço em todos os itens? Linhas extras (ex: TAXA) valem pra
// todos os fornecedores a partir do momento em que são criadas — precisam ser
// lançadas por todo mundo, contam pra completude igual a um item normal.
function fornecedorCompleto(fId) {
  if (!itens.length) return true;
  return itens.every(item => {
    const p = precos[`${item.id}_${fId}`] || {};
    return p.preco_total_ano != null || p.preco_unitario_mes != null;
  });
}

// Completos ordenados por valor crescente → incompletos → pesquisa na internet → pesquisa compra pública → declínio sempre no final
function fornecedoresOrdenados() {
  const sortByTotal = arr => [...arr].sort((a, b) => {
    const ta = totaisForn[a.id] || 0;
    const tb = totaisForn[b.id] || 0;
    if (ta === 0 && tb === 0) return 0;
    if (ta === 0) return 1;
    if (tb === 0) return -1;
    return ta - tb;
  });
  const ativos       = fornecedores.filter(f => !f.declinio && !f.pesquisa_internet && !f.pesquisa_compra_publica);
  const pesqInternet = fornecedores.filter(f => !f.declinio &&  f.pesquisa_internet);
  const pesqCompras  = fornecedores.filter(f => !f.declinio && !f.pesquisa_internet && f.pesquisa_compra_publica);
  const declinados   = fornecedores.filter(f =>  f.declinio);
  const completos    = ativos.filter(f =>  fornecedorCompleto(f.id));
  const incompletos  = ativos.filter(f => !fornecedorCompleto(f.id));
  return [...sortByTotal(completos), ...incompletos, ...sortByTotal(pesqInternet), ...sortByTotal(pesqCompras), ...declinados];
}

// ── Carregar dados ────────────────────────────────────────────────────────────

async function carregar() {
  if (!processoId) {
    document.getElementById('loader').textContent = 'ID do processo não informado.';
    return;
  }
  try {
    const [res, statusRes, extraRes] = await Promise.all([
      fetch(`/api/processos/${processoId}`),
      fetch('/api/status'),
      fetch('/api/tipos-extra')
    ]);
    const statusList = statusRes.ok ? await statusRes.json() : [];
    const sel = document.getElementById('status-select');
    sel.innerHTML = statusList.map(s => `<option value="${s.nome}">${s.nome}</option>`).join('');
    tiposExtra = extraRes.ok ? await extraRes.json() : [];
    if (!res.ok) throw new Error();
    const data = await res.json();

    processo          = data;
    fornecedores      = data.fornecedores || [];
    itens             = data.itens || [];
    vencedorId        = data.proposta_vencedora_id;
    mostrarMenorPreco = data.mostrar_menor_preco !== 0;
    precos            = {};

    const user = await getCurrentUser();
    podeEditarCotacao = !!user && (user.role === 'admin' || data.criado_por_id === user.id);
    aplicarPermissaoUI();

    document.getElementById('chk-menor-preco').checked = mostrarMenorPreco;
    aplicarLabelsObs();

    data.precos.forEach(p => {
      precos[`${p.item_id}_${p.fornecedor_id}`] = {
        preco_unitario_mes: p.preco_unitario_mes,
        preco_total_ano:    p.preco_total_ano
      };
    });

    computarTotais();
    renderCabecalho();
    renderFornecedoresInfo();
    renderTabelaPrecos();
    atualizarPrintBlock();

    document.getElementById('obs-geral').value  = data.observacoes  || '';
    document.getElementById('obs-portal').value = data.observacoes2 || '';
    document.getElementById('status-select').value = data.status || 'Em cotação';

    document.getElementById('loader').style.display  = 'none';
    document.getElementById('content').style.display = 'block';

  } catch {
    document.getElementById('loader').textContent = 'Processo não encontrado.';
  }
}

// ── Cabeçalho (somente leitura) ───────────────────────────────────────────────

function renderCabecalho() {
  document.title = `${processo.numero_processo} — SECOP Cotações`;
  document.getElementById('ph-numero').textContent    = `Processo ${processo.numero_processo}`;
  document.getElementById('ph-objeto-txt').textContent = processo.objeto || '—';

  document.getElementById('btn-editar-forn').href = `fornecedor.html?processo_id=${processoId}`;

  const meta = [
    { label: 'Tipo',           value: processo.tipo_contratacao || '—' },
    { label: 'Setor',          value: processo.setor_solicitante || '—' },
    { label: 'Responsável',    value: processo.responsavel || '—' },
    { label: 'Data Abertura',  value: fmtBr(processo.data_abertura) },
    { label: 'Início',         value: fmtBr(processo.previsao_inicio) },
    { label: 'Término',        value: fmtBr(processo.previsao_termino) },
    { label: 'Criado por',     value: processo.criado_por_username || 'Admin (legado)' },
  ];

  document.getElementById('ph-meta').innerHTML = meta
    .map(m => `<span><strong>${m.label}:</strong> ${m.value}</span>`)
    .join('');

  if (processo.descricao) {
    document.getElementById('ph-meta').innerHTML +=
      `<span style="grid-column:span 3;color:#444;">${processo.descricao}</span>`;
  }
}

// ── Tabela de fornecedores (somente tela) ─────────────────────────────────────

function renderFornecedoresInfo() {
  const wrap  = document.getElementById('forn-info-wrap');
  const table = document.getElementById('forn-info-table');

  if (!fornecedores.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';

  const ordinals = ['1º','2º','3º','4º','5º','6º','7º','8º'];
  const fOrds    = fornecedoresOrdenados();

  const campos = [
    { label: 'Nome',          key: 'nome' },
    { label: 'Contato',       key: 'contato' },
    { label: 'Telefone',      key: 'telefone' },
    { label: 'Celular',       key: 'celular' },
    { label: 'E-mail',        key: 'email' },
    { label: 'Data Proposta', key: 'data_proposta', fmt: fmtBr },
    { label: 'Frete',         key: 'frete' },
  ];

  let html = `<thead><tr>
    <th class="col-fixed" style="min-width:130px;">—</th>`;
  fOrds.forEach((f, i) => {
    const incompleto = !fornecedorCompleto(f.id);
    const badge = f.declinio
      ? ' <span style="color:#E65100;font-size:10px;font-weight:400;display:block;">⚠ Declínio</span>'
      : (incompleto ? ' <span style="color:#e53e3e;font-size:10px;font-weight:400;display:block;">⚠ Cotação Incompleta</span>' : '');
    html += `<th class="${fornCls(f.id)}">${ordinals[i] || (i+1)+'º'} FORNECEDOR${badge}</th>`;
  });
  html += '</tr></thead><tbody>';

  campos.forEach((c, ci) => {
    html += `<tr><td class="col-fixed"><strong>${c.label}</strong></td>`;
    fOrds.forEach(f => {
      const cls = fornCls(f.id);
      if (f.declinio) {
        if (ci === 0) {
          // Uma célula cobrindo TODAS as linhas — textos juntos e centralizados
          html += `<td class="${cls} col-declinio" rowspan="${campos.length}" style="text-align:center;vertical-align:middle;line-height:1.8;"><strong style="display:block;text-transform:uppercase;font-size:12px;letter-spacing:.4px;">Declínio</strong><strong style="display:block;margin-top:4px;">${f.nome || '—'}</strong></td>`;
        }
        // ci > 0: coberto pelo rowspan — sem <td>
      } else if (f.pesquisa_internet || f.pesquisa_compra_publica) {
        if (ci === 0) {
          // Uma célula cobrindo TODAS as linhas — textos juntos e centralizados
          const rotulo = f.pesquisa_internet ? 'Pesquisa na Internet' : 'Pesquisa Compra Pública';
          html += `<td class="${cls}" rowspan="${campos.length}" style="text-align:center;vertical-align:middle;line-height:1.8;"><strong style="display:block;text-transform:uppercase;font-size:12px;letter-spacing:.4px;">${rotulo}</strong><strong style="display:block;margin-top:4px;">${f.nome || '—'}</strong></td>`;
        }
        // ci > 0: coberto pelo rowspan — sem <td>
      } else {
        const val = c.key === 'frete' ? fmtFrete(f)
          : c.fmt ? (c.fmt(f[c.key]) || '—') : (f[c.key] || '—');
        html += `<td class="${cls}">${val}</td>`;
      }
    });
    html += '</tr>';
  });

  html += '</tbody>';
  table.innerHTML = html;
}

// ── Tabela de preços (somente tela) ──────────────────────────────────────────

function isVenc(fId) {
  return vencedorId != null && parseInt(fId) === parseInt(vencedorId);
}

function fornCls(fId) {
  return isVenc(fId) ? 'col-fornecedor vencedor' : 'col-fornecedor';
}

function renderTabelaPrecos() {
  const thead = document.getElementById('preco-thead');
  const tbody  = document.getElementById('preco-tbody');
  const nForn  = fornecedores.length;

  if (!itens.length && !nForn) {
    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td colspan="4" class="loader">Nenhum item ou fornecedor cadastrado.</td></tr>';
    return;
  }

  const ordinals = ['1º','2º','3º','4º','5º','6º','7º','8º'];
  const fOrds    = fornecedoresOrdenados();

  // ── Linha 1: nomes dos fornecedores (ordenados por valor)
  let thRow = `<tr>
    <th class="col-fixed" rowspan="2">Item</th>
    <th class="col-fixed" rowspan="2">Qtde</th>
    <th class="col-fixed" rowspan="2">Unid.</th>
    <th class="col-fixed" rowspan="2">Descrição</th>`;
  fOrds.forEach((f, i) => {
    const incompleto = !fornecedorCompleto(f.id);
    const badge = f.declinio
      ? ' <span style="color:#E65100;font-size:10px;font-weight:400;">⚠ Declínio</span>'
      : (incompleto ? ' <span style="color:#e53e3e;font-size:10px;font-weight:400;">⚠ Incompleta</span>' : '');
    thRow += `<th class="${fornCls(f.id)}" colspan="2">${ordinals[i] || (i+1)+'º'} — ${f.nome || 'Fornecedor'}${badge}</th>`;
  });
  thRow += '</tr>';

  // ── Linha 2: labels de coluna
  let thSubRow = '<tr>';
  fOrds.forEach(f => {
    const cls = fornCls(f.id);
    thSubRow += `<th class="${cls}">${getColLabel('unit')}</th><th class="${cls}">${getColLabel('total')}</th>`;
  });
  thSubRow += '</tr>';
  thead.innerHTML = thRow + thSubRow;

  // ── Menor preço (fornecedor com menor valor total geral — exclui incompletos)
  const withTot   = fOrds.map(f => ({ fId: f.id, v: totaisForn[f.id] || 0 })).filter(x => x.v !== 0 && fornecedorCompleto(x.fId));
  const minFornId = mostrarMenorPreco && withTot.length >= 2 ? withTot.reduce((a, b) => b.v < a.v ? b : a).fId : -1;

  // ── Linhas dos itens
  let rows = '';
  itens.forEach(item => {
    const sinalItem     = item.extra ? sinalDoTipo(item.unidade)     : null;
    const tipoValorItem = item.extra ? tipoValorDoTipo(item.unidade) : null;
    const fmtExtra      = tipoValorItem === 'percentual' ? fmtPercentualExtra : fmtMoedaExtra;
    let row = `<tr class="${item.extra ? 'row-extra ' + (sinalItem === 'negativo' ? 'row-extra-neg' : 'row-extra-pos') : ''}">
      <td class="col-fixed">${item.extra ? 'EXTRA' : item.item_num}</td>
      <td class="col-fixed">${item.quantidade}</td>
      <td class="col-fixed">${item.unidade || ''}</td>
      <td class="col-fixed">${item.descricao}</td>`;

    fOrds.forEach(f => {
      const p     = precos[`${item.id}_${f.id}`] || {};
      const cls   = fornCls(f.id);
      const unit  = p.preco_unitario_mes;
      const total = p.preco_total_ano ?? (unit != null ? unit * item.quantidade : null);
      const isMin = f.id === minFornId;

      const unitTxt  = unit  != null ? (item.extra ? fmtExtra(unit,  sinalItem) : fmtMoeda(unit))  : (item.extra ? 'Não lançado' : '—');
      const totalTxt = total != null ? (item.extra ? fmtExtra(total, sinalItem) : fmtMoeda(total)) : (item.extra ? 'Não lançado' : '—');

      row += `
        <td class="${cls}${isMin ? ' col-min' : ''}">${unitTxt}</td>
        <td class="${cls}${isMin ? ' col-min' : ''}">${totalTxt}</td>`;
    });
    row += '</tr>';
    rows += row;
  });

  // ── Footer: VALOR TOTAL
  let footer = `<tr class="row-section-header row-sec-totals"><td colspan="4">VALOR TOTAL</td>`;
  fOrds.forEach(f => {
    const cls   = fornCls(f.id);
    const isMin = f.id === minFornId;
    footer += `<td></td><td class="${cls}${isMin ? ' col-min' : ''}">${fmtTotalFornecedor(f.id)}</td>`;
  });
  footer += '</tr>';

  // ── Footer: CONDIÇÕES GERAIS
  const secHdrScreen = t => {
    let r = `<tr class="row-section-header"><td colspan="4">${t}</td>`;
    for (let i = 0; i < nForn; i++) r += `<td colspan="2"></td>`;
    return r + '</tr>';
  };
  footer += secHdrScreen('CONDIÇÕES GERAIS');

  const footerRow = (label, key) => {
    let r = `<tr class="row-rodape"><td class="col-fixed" colspan="4">${label}</td>`;
    fOrds.forEach(f => {
      const isMin = f.id === minFornId && !!f[key];
      r += `<td class="${fornCls(f.id)}${isMin ? ' col-min' : ''}" colspan="2">${f[key] || '—'}</td>`;
    });
    return r + '</tr>';
  };
  footer += footerRow('Prazo de Entrega',   'prazo_entrega');
  footer += footerRow('Prazo de Pagamento', 'prazo_pagamento');

  // ── Footer: GARANTIA
  footer += secHdrScreen('GARANTIA');
  footer += footerRow('Prazo de Garantia', 'prazo_garantia');

  // ── Footer: HISTÓRICO DE NEGOCIAÇÃO
  footer += secHdrScreen('HISTÓRICO DE NEGOCIAÇÃO');

  const moedaRowFb = (label, key) => {
    let r = `<tr class="row-rodape"><td class="col-fixed" colspan="4">${label}</td>`;
    fOrds.forEach(f => {
      // Não usa o total como fallback quando ele vem só de extra percentual —
      // "-23,7%" não é um valor monetário de proposta.
      const v = f[key] ?? (totaisForn[f.id] !== 0 && !totalEhPercentual(f.id) ? totaisForn[f.id] : null);
      const isMin = f.id === minFornId && v != null;
      r += `<td class="${fornCls(f.id)}${isMin ? ' col-min' : ''}" colspan="2">${v != null ? fmtMoeda(v) : '—'}</td>`;
    });
    return r + '</tr>';
  };
  footer += moedaRowFb('Proposta Inicial', 'proposta_inicial');
  footer += moedaRowFb('Proposta Final',   'proposta_final');

  // ── Footer: Proposta Vencedora
  let vencRow = `<tr class="row-rodape"><td class="col-fixed" colspan="4">Proposta Vencedora</td>`;
  fOrds.forEach(f => {
    const isV = isVenc(f.id);
    const cls = fornCls(f.id);
    vencRow += `<td class="${cls}" colspan="2" style="text-align:center;">`;
    if (isV) {
      vencRow += `<span style="font-weight:700;color:var(--verde);">✓ Vencedor</span>`;
    } else if (podeEditarCotacao) {
      vencRow += `<button class="btn btn-outline btn-sm btn-marcar-venc no-print" data-id="${f.id}">Marcar</button>`;
    } else {
      vencRow += `<span style="color:var(--text-subtle);">—</span>`;
    }
    vencRow += '</td>';
  });
  vencRow += '</tr>';
  footer += vencRow;

  tbody.innerHTML = rows + footer;

  // Listener: marcar vencedor
  tbody.querySelectorAll('.btn-marcar-venc').forEach(btn => {
    btn.addEventListener('click', async () => {
      const fId = parseInt(btn.dataset.id);
      try {
        await fetch(`/api/processos/${processoId}/vencedor/${fId}`, { method: 'PUT' });
        vencedorId = fId;
        renderFornecedoresInfo();
        renderTabelaPrecos();
        atualizarPrintBlock();
        toast('Vencedor marcado!', 'success');
      } catch { toast('Erro ao marcar vencedor.', 'error'); }
    });
  });
}

// ── Bloco de impressão ────────────────────────────────────────────────────────

function atualizarPrintBlock() {
  const nForn = fornecedores.length;
  if (!nForn) { document.getElementById('print-block').innerHTML = ''; return; }

  const totalCols = 4 + nForn * 2;
  const ordinals  = ['1º','2º','3º','4º','5º','6º','7º','8º'];
  const fOrds     = fornecedoresOrdenados();

  const withTot  = fOrds.map(f => ({ fId: f.id, v: totaisForn[f.id] || 0 })).filter(x => x.v !== 0 && fornecedorCompleto(x.fId));
  const minFornId = mostrarMenorPreco && withTot.length >= 2 ? withTot.reduce((a, b) => b.v < a.v ? b : a).fId : -1;

  const vc = (fId) => isVenc(fId);
  const cellCls = (fId, isMin) => {
    const cls = [];
    if (vc(fId)) cls.push('prt-venc');
    if (isMin)   cls.push('prt-min');
    return cls.length ? ` class="${cls.join(' ')}"` : '';
  };

  const leftRows = [
    ['Objeto',                          processo?.objeto || '—'],
    ['Data',                            fmtBr(processo?.data_abertura || processo?.criado_em)],
    ['Tipo de Contratação',             processo?.tipo_contratacao || '—'],
    ['Setor Solicitante',               processo?.setor_solicitante || '—'],
    ['Previsão de início do contrato',  fmtBr(processo?.previsao_inicio)],
    ['Previsão de término do contrato', fmtBr(processo?.previsao_termino)],
    ['Descrição da contratação',        processo?.descricao || '—'],
    ['Responsável pela Elaboração',     processo?.responsavel || '—'],
  ];

  const rightFields = [
    null,
    { label: 'Nome',             key: 'nome' },
    { label: 'Contato',          key: 'contato' },
    { label: 'Telefone',         key: 'telefone' },
    { label: 'Celular',          key: 'celular' },
    { label: 'E-mail',           key: 'email' },
    { label: 'Data da proposta', key: 'data_proposta', fmt: fmtBr },
    { label: 'Frete',            key: 'frete' },
  ];

  let h = `<div class="prt-titulo">QUADRO COMPARATIVO</div><table class="prt-table">`;

  leftRows.forEach(([label, val], ri) => {
    const rf = rightFields[ri];
    h += `<tr><td class="prt-lbl" colspan="2">${label}:</td><td class="prt-val" colspan="2">${val}</td>`;

    if (ri === 0) {
      fOrds.forEach((f, i) => {
        const incompleto = !fornecedorCompleto(f.id);
        const badge = f.declinio ? ' ⚠ Declínio' : (incompleto ? ' ⚠ Incompleta' : '');
        h += `<td class="prt-forn-hdr${vc(f.id) ? ' prt-venc-hdr' : ''}" colspan="2">${ordinals[i] || (i+1)+'º'} FORNECEDOR${badge}</td>`;
      });
    } else if (rf) {
      fOrds.forEach(f => {
        const cls = `prt-forn-info${vc(f.id) ? ' prt-venc' : ''}`;
        if (f.declinio) {
          if (rf.key === 'nome') {
            const totalInfoRows = rightFields.filter(r => r != null).length;
            h += `<td class="${cls} prt-declinio" colspan="2" rowspan="${totalInfoRows}" style="text-align:center;vertical-align:middle;"><strong style="display:block;text-transform:uppercase;font-size:8px;letter-spacing:.4px;">Declínio</strong><strong style="display:block;margin-top:2px;">${f.nome || '—'}</strong></td>`;
          }
          // demais linhas cobertas pelo rowspan — sem <td>
        } else if (f.pesquisa_internet || f.pesquisa_compra_publica) {
          if (rf.key === 'nome') {
            const totalInfoRows = rightFields.filter(r => r != null).length;
            const rotulo = f.pesquisa_internet ? 'Pesquisa na Internet' : 'Pesquisa Compra Pública';
            h += `<td class="${cls}" colspan="2" rowspan="${totalInfoRows}" style="text-align:center;vertical-align:middle;"><strong style="display:block;text-transform:uppercase;font-size:8px;letter-spacing:.4px;">${rotulo}</strong><strong style="display:block;margin-top:2px;">${f.nome || '—'}</strong></td>`;
          }
          // demais linhas cobertas pelo rowspan — sem <td>
        } else {
          let fv = rf.key === 'frete' ? fmtFrete(f) : (f[rf.key] || '—');
          if (rf.fmt) fv = rf.fmt(fv) || '—';
          h += `<td class="${cls}" colspan="2">${rf.label}: ${fv}</td>`;
        }
      });
    } else {
      fOrds.forEach(f => {
        h += `<td class="prt-forn-info${vc(f.id) ? ' prt-venc' : ''}" colspan="2"></td>`;
      });
    }
    h += `</tr>`;
  });

  // ── Sub-cabeçalho dos itens
  h += `<tr class="prt-item-hdr"><th>Item</th><th>Qtde</th><th>Unid.</th><th>DESCRIÇÃO</th>`;
  fOrds.forEach(f => {
    h += `<th${cellCls(f.id, false)}>${getColLabel('unit')}</th><th${cellCls(f.id, false)}>${getColLabel('total')}</th>`;
  });
  h += `</tr>`;

  // ── Linhas dos itens
  itens.forEach(item => {
    const sinalItem     = item.extra ? sinalDoTipo(item.unidade)     : null;
    const tipoValorItem = item.extra ? tipoValorDoTipo(item.unidade) : null;
    const fmtExtraPrt   = tipoValorItem === 'percentual' ? fmtPercentualExtra : fmtMoedaExtra;
    h += `<tr class="${item.extra ? 'prt-extra ' + (sinalItem === 'negativo' ? 'prt-extra-neg' : 'prt-extra-pos') : ''}"><td class="prt-left">${item.extra ? 'EXTRA' : item.item_num}</td><td class="prt-left">${item.quantidade}</td><td class="prt-left">${item.unidade || ''}</td><td class="prt-left">${item.descricao}</td>`;
    fOrds.forEach(f => {
      const p     = precos[`${item.id}_${f.id}`] || {};
      const u     = p.preco_unitario_mes;
      const tot   = p.preco_total_ano ?? (u != null ? u * item.quantidade : null);
      const isMin = f.id === minFornId;
      const uTxt   = u   != null ? (item.extra ? fmtExtraPrt(u,   sinalItem) : fmtMoeda(u))   : (item.extra ? 'Não lançado' : '—');
      const totTxt = tot != null ? (item.extra ? fmtExtraPrt(tot, sinalItem) : fmtMoeda(tot)) : (item.extra ? 'Não lançado' : '—');
      h += `<td${cellCls(f.id, isMin)}>${uTxt}</td>`;
      h += `<td${cellCls(f.id, isMin)}>${totTxt}</td>`;
    });
    h += `</tr>`;
  });

  // ── VALOR TOTAL
  h += `<tr class="prt-sec"><td colspan="4">VALOR TOTAL</td>`;
  fOrds.forEach(f => {
    const incompleto = !fornecedorCompleto(f.id);
    const totalTxtFmt = fmtTotalFornecedor(f.id);
    const display = totalTxtFmt !== '—' ? totalTxtFmt + (incompleto ? ' *' : '') : '—';
    h += `<td${cellCls(f.id, f.id === minFornId)} colspan="2" style="font-weight:700">${display}</td>`;
  });
  h += `</tr>`;

  // ── RESUMO TOTAL GERAL
  h += `<tr class="prt-sec"><td colspan="4">RESUMO TOTAL GERAL</td>`;
  fOrds.forEach(f => {
    const incompleto = !fornecedorCompleto(f.id);
    const totalTxtFmt = fmtTotalFornecedor(f.id);
    const display = totalTxtFmt !== '—' ? totalTxtFmt + (incompleto ? ' *' : '') : '—';
    h += `<td${cellCls(f.id, f.id === minFornId)} colspan="2" style="font-weight:700">${display}</td>`;
  });
  h += `</tr>`;

  // ── CONDIÇÕES GERAIS
  const secHdrPrint = t => {
    let r = `<tr class="prt-sec"><td colspan="4">${t}</td>`;
    for (let i = 0; i < nForn; i++) r += `<td colspan="2">—</td>`;
    return r + '</tr>';
  };
  h += secHdrPrint('CONDIÇÕES GERAIS');

  const fRow = (label, key, destacarMin = false) => {
    let r = `<tr><td class="prt-lbl" colspan="4">${label}</td>`;
    fOrds.forEach(f => {
      const isMin = destacarMin && f.id === minFornId && !!f[key];
      r += `<td${cellCls(f.id, isMin)} colspan="2">${f[key] || '—'}</td>`;
    });
    return r + '</tr>';
  };

  h += fRow('Observações',           'observacoes');
  h += fRow('Condição de Pagamento', 'prazo_pagamento', true);
  h += fRow('Prazo de Entrega',      'prazo_entrega',   true);

  // ── Incluso Frete (Sim/Não) e Termo (CIF/FOB) — marcações independentes
  h += `<tr><td class="prt-lbl" colspan="4">Incluso Frete</td>`;
  fOrds.forEach(f => {
    const { frete: v, termo: t } = normalizarFrete(f);
    const mark = (val, opt) => val === opt ? 'X' : ' ';
    h += `<td${cellCls(f.id, false)} colspan="2">Sim (${mark(v,'Sim')}) — Não (${mark(v,'Não')}) — CIF (${mark(t,'CIF')}) — FOB (${mark(t,'FOB')})</td>`;
  });
  h += `</tr>`;

  h += secHdrPrint('GARANTIA');
  h += fRow('Prazo de Garantia', 'prazo_garantia', true);
  h += secHdrPrint('HISTÓRICO DE NEGOCIAÇÃO');

  const mRow = (label, key) => {
    let r = `<tr><td class="prt-lbl" colspan="4">${label}</td>`;
    fOrds.forEach(f => {
      // Não usa o total como fallback quando ele vem só de extra percentual —
      // "-23,7%" não é um valor monetário de proposta.
      const v = f[key] ?? (totaisForn[f.id] !== 0 && !totalEhPercentual(f.id) ? totaisForn[f.id] : null);
      const isMin = f.id === minFornId && v != null;
      r += `<td${cellCls(f.id, isMin)} colspan="2">${v != null ? fmtMoeda(v) : '—'}</td>`;
    });
    return r + '</tr>';
  };

  const spacerRow = () => {
    let r = `<tr style="height:10px;"><td class="prt-lbl" colspan="4"></td>`;
    fOrds.forEach(f => { r += `<td${cellCls(f.id, false)} colspan="2"></td>`; });
    return r + '</tr>';
  };

  h += mRow('Proposta Inicial', 'proposta_inicial');
  h += spacerRow();
  h += spacerRow();
  h += mRow('Proposta Final',   'proposta_final');

  // ── Proposta Vencedora
  h += `<tr><td class="prt-lbl" colspan="4">Proposta Vencedora</td>`;
  fOrds.forEach(f => {
    h += `<td${cellCls(f.id, false)} colspan="2" style="text-align:center;font-weight:700">${vc(f.id) ? 'x' : ''}</td>`;
  });
  h += `</tr></table>`;

  // ── OBS
  const obsGeral  = (document.getElementById('obs-geral')?.value  || '').trim();
  const obsPortal = (document.getElementById('obs-portal')?.value || '').trim();
  if (obsGeral || obsPortal) {
    h += `<div class="prt-obs">`;
    if (obsGeral)  h += `<p><strong>${getObsLabel('geral')}:</strong> ${obsGeral}</p>`;
    if (obsPortal) h += `<p><strong>${getObsLabel('portal')}:</strong> ${obsPortal}</p>`;
    h += `</div>`;
  }

  // ── Rodapé de impressão
  const now = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  h += `<div class="prt-footer">
    <span>CeasaMinas Centrais de Abastecimento de Minas Gerais</span>
    <span>Gerado em: ${now}</span>
  </div>`;

  document.getElementById('print-block').innerHTML = h;
}

// ── Status ────────────────────────────────────────────────────────────────────

document.getElementById('status-select').addEventListener('change', async function () {
  try {
    await fetch(`/api/processos/${processoId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: this.value })
    });
    toast('Status atualizado', 'success');
  } catch { toast('Erro ao atualizar status', 'error'); }
});

// ── Salvar OBS ────────────────────────────────────────────────────────────────

document.getElementById('btn-salvar-obs').addEventListener('click', async () => {
  const btn = document.getElementById('btn-salvar-obs');
  btn.disabled    = true;
  btn.textContent = 'Salvando...';
  try {
    await fetch(`/api/processos/${processoId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objeto:            processo?.objeto,
        setor_solicitante: processo?.setor_solicitante,
        tipo_contratacao:  processo?.tipo_contratacao,
        responsavel:       processo?.responsavel,
        descricao:         processo?.descricao,
        previsao_inicio:   processo?.previsao_inicio,
        previsao_termino:  processo?.previsao_termino,
        data_abertura:     processo?.data_abertura,
        status:            document.getElementById('status-select').value,
        observacoes:       document.getElementById('obs-geral').value,
        observacoes2:      document.getElementById('obs-portal').value
      })
    });
    toast('Observações salvas!', 'success');
  } catch { toast('Erro ao salvar.', 'error'); }
  finally {
    btn.disabled    = false;
    btn.textContent = 'Salvar OBS';
  }
});

// ── Destacar menor preço ──────────────────────────────────────────────────────

document.getElementById('chk-menor-preco').addEventListener('change', async function () {
  mostrarMenorPreco = this.checked;
  renderTabelaPrecos();
  atualizarPrintBlock();
  try {
    await fetch(`/api/processos/${processoId}/mostrar-menor-preco`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mostrar: mostrarMenorPreco })
    });
  } catch { toast('Erro ao salvar preferência.', 'error'); }
});

// ── Imprimir ──────────────────────────────────────────────────────────────────

document.getElementById('btn-print').addEventListener('click', () => {
  atualizarPrintBlock();
  window.print();
});

// ── Init ──────────────────────────────────────────────────────────────────────

carregar();
initSuggestAutocomplete('obs-geral',  'observacoes');
initSuggestAutocomplete('obs-portal', 'observacoes2');
