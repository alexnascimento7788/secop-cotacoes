// ── Utilitários ───────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
const processoId = params.get('id');

function fmtBr(iso) {
  if (!iso) return '—';
  const d = iso.split('T')[0].split('-');
  if (d.length < 3) return iso;
  return `${d[2]}/${d[1]}/${d[0]}`;
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

// ── Carregar dados ────────────────────────────────────────────────────────────

async function carregar() {
  if (!processoId) {
    document.getElementById('loader').textContent = 'ID do processo não informado.';
    return;
  }
  try {
    const [res, statusRes] = await Promise.all([
      fetch(`/api/processos/${processoId}`),
      fetch('/api/status')
    ]);
    const statusList = statusRes.ok ? await statusRes.json() : [];
    const sel = document.getElementById('status-select');
    sel.innerHTML = statusList.map(s => `<option value="${s.nome}">${s.nome}</option>`).join('');
    if (!res.ok) throw new Error();
    const data = await res.json();

    processo          = data;
    fornecedores      = data.fornecedores || [];
    itens             = data.itens || [];
    vencedorId        = data.proposta_vencedora_id;
    mostrarMenorPreco = data.mostrar_menor_preco !== 0;
    precos            = {};

    document.getElementById('chk-menor-preco').checked = mostrarMenorPreco;

    data.precos.forEach(p => {
      precos[`${p.item_id}_${p.fornecedor_id}`] = {
        preco_unitario_mes: p.preco_unitario_mes,
        preco_total_ano:    p.preco_total_ano
      };
    });

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

  // "Editar fornecedores" → fornecedor.html?processo_id=X
  document.getElementById('btn-editar-forn').href = `fornecedor.html?processo_id=${processoId}`;

  const meta = [
    { label: 'Tipo',           value: processo.tipo_contratacao || '—' },
    { label: 'Setor',          value: processo.setor_solicitante || '—' },
    { label: 'Responsável',    value: processo.responsavel || '—' },
    { label: 'Data Abertura',  value: fmtBr(processo.data_abertura) },
    { label: 'Início',         value: fmtBr(processo.previsao_inicio) },
    { label: 'Término',        value: fmtBr(processo.previsao_termino) },
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
  fornecedores.forEach((f, i) => {
    const cls = fornCls(f.id);
    html += `<th class="${cls}">${ordinals[i] || (i+1)+'º'} FORNECEDOR</th>`;
  });
  html += '</tr></thead><tbody>';

  campos.forEach(c => {
    html += `<tr><td class="col-fixed"><strong>${c.label}</strong></td>`;
    fornecedores.forEach(f => {
      const cls = fornCls(f.id);
      let val   = f[c.key] || '—';
      if (c.fmt) val = c.fmt(val) || '—';
      html += `<td class="${cls}">${val}</td>`;
    });
    html += '</tr>';
  });

  html += '</tbody>';
  table.innerHTML = html;
}

// ── Tabela de preços (somente leitura) ───────────────────────────────────────

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
  const totalCols = 4 + nForn * 2;

  if (!itens.length && !nForn) {
    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td colspan="4" class="loader">Nenhum item ou fornecedor cadastrado.</td></tr>';
    return;
  }

  const ordinals = ['1º','2º','3º','4º','5º','6º','7º','8º'];

  // ── Linha 1: nomes dos fornecedores
  let thRow = `<tr>
    <th class="col-fixed" rowspan="2">Item</th>
    <th class="col-fixed" rowspan="2">Qtde</th>
    <th class="col-fixed" rowspan="2">Unid.</th>
    <th class="col-fixed" rowspan="2">Descrição</th>`;
  fornecedores.forEach((f, i) => {
    const cls = fornCls(f.id);
    thRow += `<th class="${cls}" colspan="2">${ordinals[i] || (i+1)+'º'} — ${f.nome || 'Fornecedor'}</th>`;
  });
  thRow += '</tr>';

  // ── Linha 2: R$ UNIT/MÊS | R$ TOTAL/ANO
  let thSubRow = '<tr>';
  fornecedores.forEach(f => {
    const cls = fornCls(f.id);
    thSubRow += `<th class="${cls}">R$ UNIT/MÊS</th><th class="${cls}">R$ TOTAL/ANO</th>`;
  });
  thSubRow += '</tr>';
  thead.innerHTML = thRow + thSubRow;

  // ── Pré-calcula totais por fornecedor (para encontrar o vencedor geral)
  const totaisForn = {};
  fornecedores.forEach((_, i) => { totaisForn[i] = 0; });
  itens.forEach(item => {
    fornecedores.forEach((f, i) => {
      const p   = precos[`${item.id}_${f.id}`] || {};
      const u   = p.preco_unitario_mes;
      const tot = p.preco_total_ano ?? (u != null ? u * item.quantidade : null);
      if (tot != null) totaisForn[i] += parseFloat(tot) || 0;
    });
  });

  // ── Vencedor geral: único fornecedor com menor VALOR TOTAL (destaque em todas as linhas)
  const withTot   = fornecedores.map((_, i) => ({ i, v: totaisForn[i] })).filter(x => x.v > 0);
  const minTotIdx = mostrarMenorPreco && withTot.length >= 2 ? withTot.reduce((a, b) => b.v < a.v ? b : a).i : -1;

  // ── Linhas dos itens
  let rows = '';
  itens.forEach(item => {
    let row = `<tr>
      <td class="col-fixed">${item.item_num}</td>
      <td class="col-fixed">${item.quantidade}</td>
      <td class="col-fixed">${item.unidade || ''}</td>
      <td class="col-fixed">${item.descricao}</td>`;

    fornecedores.forEach((f, i) => {
      const key   = `${item.id}_${f.id}`;
      const p     = precos[key] || {};
      const cls   = fornCls(f.id);
      const unit  = p.preco_unitario_mes;
      const total = p.preco_total_ano ?? (unit != null ? unit * item.quantidade : null);

      const isMin = i === minTotIdx;

      row += `
        <td class="${cls}${isMin ? ' col-min' : ''}">${unit != null ? fmtMoeda(unit) : '—'}</td>
        <td class="${cls}${isMin ? ' col-min' : ''}">${total != null ? fmtMoeda(total) : '—'}</td>`;
    });
    row += '</tr>';
    rows += row;
  });

  // ── Footer: VALOR TOTAL (reutiliza minTotIdx já calculado)

  let footer = `<tr class="row-section-header row-sec-totals"><td colspan="4">VALOR TOTAL</td>`;
  fornecedores.forEach((f, i) => {
    const cls   = fornCls(f.id);
    const isMin = i === minTotIdx;
    footer += `<td class="${cls}${isMin ? ' col-min' : ''}" colspan="2">${totaisForn[i] > 0 ? fmtMoeda(totaisForn[i]) : '—'}</td>`;
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
    fornecedores.forEach(f => {
      r += `<td class="${fornCls(f.id)}" colspan="2">${f[key] || '—'}</td>`;
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

  const moedaRow = (label, key) => {
    let r = `<tr class="row-rodape"><td class="col-fixed" colspan="4">${label}</td>`;
    fornecedores.forEach(f => {
      const v = f[key];
      r += `<td class="${fornCls(f.id)}" colspan="2">${v != null ? fmtMoeda(v) : '—'}</td>`;
    });
    return r + '</tr>';
  };
  const moedaRowFb = (label, key) => {
    let r = `<tr class="row-rodape"><td class="col-fixed" colspan="4">${label}</td>`;
    fornecedores.forEach((f, i) => {
      const v = f[key] ?? (totaisForn[i] > 0 ? totaisForn[i] : null);
      r += `<td class="${fornCls(f.id)}" colspan="2">${v != null ? fmtMoeda(v) : '—'}</td>`;
    });
    return r + '</tr>';
  };
  footer += moedaRowFb('Proposta Inicial', 'proposta_inicial');
  footer += moedaRowFb('Proposta Final',   'proposta_final');

  // ── Footer: Proposta Vencedora (com botão Marcar)
  let vencRow = `<tr class="row-rodape"><td class="col-fixed" colspan="4">Proposta Vencedora</td>`;
  fornecedores.forEach(f => {
    const isV  = isVenc(f.id);
    const cls  = fornCls(f.id);
    vencRow += `<td class="${cls}" colspan="2" style="text-align:center;">`;
    if (isV) {
      vencRow += `<span style="font-weight:700;color:var(--verde);">✓ Vencedor</span>`;
    } else {
      vencRow += `<button class="btn btn-outline btn-sm btn-marcar-venc no-print" data-id="${f.id}">Marcar</button>`;
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

// ── Bloco de impressão — tabela unificada ─────────────────────────────────────

function atualizarPrintBlock() {
  const nForn = fornecedores.length;
  if (!nForn) { document.getElementById('print-block').innerHTML = ''; return; }

  const totalCols = 4 + nForn * 2;
  const ordinals  = ['1º','2º','3º','4º','5º','6º','7º','8º'];

  // Pré-calcula totais por fornecedor
  const totForn = new Array(nForn).fill(0);
  itens.forEach(item => {
    fornecedores.forEach((f, i) => {
      const p   = precos[`${item.id}_${f.id}`] || {};
      const tot = p.preco_total_ano ?? (p.preco_unitario_mes != null ? p.preco_unitario_mes * item.quantidade : null);
      if (tot != null) totForn[i] += parseFloat(tot) || 0;
    });
  });

  // Vencedor geral: único fornecedor com menor VALOR TOTAL (destaque em toda a tabela)
  const withTotP   = totForn.map((v, i) => ({ v, i })).filter(x => x.v > 0);
  const minTotIdxP = mostrarMenorPreco && withTotP.length >= 2 ? withTotP.reduce((a, b) => b.v < a.v ? b : a).i : -1;

  const vc = (fId) => isVenc(fId);
  const cellCls = (fId, isMin) => {
    const cls = [];
    if (vc(fId)) cls.push('prt-venc');
    if (isMin)   cls.push('prt-min');
    return cls.length ? ` class="${cls.join(' ')}"` : '';
  };

  // ── Linha de processo info + campos de fornecedor (8 linhas)
  const leftRows  = [
    ['Objeto',                       processo?.objeto || '—'],
    ['Data',                         fmtBr(processo?.data_abertura || processo?.criado_em)],
    ['Tipo de Contratação',          processo?.tipo_contratacao || '—'],
    ['Setor Solicitante',            processo?.setor_solicitante || '—'],
    ['Previsão de início do contrato',  fmtBr(processo?.previsao_inicio)],
    ['Previsão de término do contrato', fmtBr(processo?.previsao_termino)],
    ['Descrição da contratação',     processo?.descricao || '—'],
    ['Responsável pela Elaboração',  processo?.responsavel || '—'],
  ];

  const rightFields = [
    null,
    { label: 'Nome',            key: 'nome' },
    { label: 'Contato',         key: 'contato' },
    { label: 'Telefone',        key: 'telefone' },
    { label: 'Celular',         key: 'celular' },
    { label: 'E-mail',          key: 'email' },
    { label: 'Data da proposta', key: 'data_proposta', fmt: fmtBr },
    { label: 'Frete',           key: 'frete' },
  ];

  let h = `<div class="prt-titulo">QUADRO COMPARATIVO</div><table class="prt-table">`;

  leftRows.forEach(([label, val], ri) => {
    const rf = rightFields[ri];
    // Divide os 4 cols da esquerda: rótulo (2 cols, dir.) + valor (2 cols, esq.)
    h += `<tr><td class="prt-lbl" colspan="2">${label}:</td><td class="prt-val" colspan="2">${val}</td>`;

    if (ri === 0) {
      fornecedores.forEach((f, i) => {
        h += `<td class="prt-forn-hdr${vc(f.id) ? ' prt-venc-hdr' : ''}" colspan="2">${ordinals[i] || (i+1)+'º'} FORNECEDOR</td>`;
      });
    } else if (rf) {
      fornecedores.forEach(f => {
        let fv = f[rf.key] || '—';
        if (rf.fmt) fv = rf.fmt(fv) || '—';
        h += `<td class="prt-forn-info${vc(f.id) ? ' prt-venc' : ''}" colspan="2">${rf.label}: ${fv}</td>`;
      });
    } else {
      fornecedores.forEach(f => {
        h += `<td class="prt-forn-info${vc(f.id) ? ' prt-venc' : ''}" colspan="2"></td>`;
      });
    }
    h += `</tr>`;
  });

  // ── Sub-cabeçalho dos itens
  h += `<tr class="prt-item-hdr"><th>Item</th><th>Qtde</th><th>Unid.</th><th>DESCRIÇÃO</th>`;
  fornecedores.forEach(f => {
    h += `<th${cellCls(f.id, false)}>R$ UNIT</th><th${cellCls(f.id, false)}>R$ TOTAL</th>`;
  });
  h += `</tr>`;

  // ── Linhas dos itens
  itens.forEach(item => {
    h += `<tr><td class="prt-left">${item.item_num}</td><td class="prt-left">${item.quantidade}</td><td class="prt-left">${item.unidade || ''}</td><td class="prt-left">${item.descricao}</td>`;
    fornecedores.forEach((f, i) => {
      const p      = precos[`${item.id}_${f.id}`] || {};
      const u      = p.preco_unitario_mes;
      const tot    = p.preco_total_ano ?? (u != null ? u * item.quantidade : null);
      const isMin = i === minTotIdxP;
      h += `<td${cellCls(f.id, isMin)}>${u != null ? fmtMoeda(u) : '—'}</td>`;
      h += `<td${cellCls(f.id, isMin)}>${tot != null ? fmtMoeda(tot) : '—'}</td>`;
    });
    h += `</tr>`;
  });

  // ── VALOR TOTAL e RESUMO TOTAL GERAL (reutiliza minTotIdxP já calculado)
  h += `<tr class="prt-sec"><td colspan="4">VALOR TOTAL</td>`;
  fornecedores.forEach((f, i) => {
    h += `<td${cellCls(f.id, i === minTotIdxP)} colspan="2" style="font-weight:700">${totForn[i] > 0 ? fmtMoeda(totForn[i]) : '—'}</td>`;
  });
  h += `</tr>`;

  h += `<tr class="prt-sec"><td colspan="4">RESUMO TOTAL GERAL</td>`;
  fornecedores.forEach((f, i) => {
    h += `<td${cellCls(f.id, i === minTotIdxP)} colspan="2" style="font-weight:700">${totForn[i] > 0 ? fmtMoeda(totForn[i]) : '—'}</td>`;
  });
  h += `</tr>`;

  // ── CONDIÇÕES GERAIS
  const secHdrPrint = t => {
    let r = `<tr class="prt-sec"><td colspan="4">${t}</td>`;
    for (let i = 0; i < nForn; i++) r += `<td colspan="2">—</td>`;
    return r + '</tr>';
  };
  h += secHdrPrint('CONDIÇÕES GERAIS');

  const fRow = (label, key) => {
    let r = `<tr><td class="prt-lbl" colspan="4">${label}</td>`;
    fornecedores.forEach(f => { r += `<td${cellCls(f.id, false)} colspan="2">${f[key] || '—'}</td>`; });
    return r + '</tr>';
  };

  h += fRow('Observações',          'observacoes');
  h += fRow('Condição de Pagamento','prazo_pagamento');
  h += fRow('Prazo de Entrega',     'prazo_entrega');

  // ── Incluso Frete: Sim (X) — Não ( ) conforme valor salvo
  h += `<tr><td class="prt-lbl" colspan="4">Incluso Frete</td>`;
  fornecedores.forEach(f => {
    const v = f.frete || '';
    const incluso  = v === 'Sim' || v === 'Incluso';
    const simMark  = incluso ? 'X' : ' ';
    const naoMark  = (!incluso && v !== '') ? 'X' : ' ';
    h += `<td${cellCls(f.id, false)} colspan="2">Sim (${simMark}) — Não (${naoMark})</td>`;
  });
  h += `</tr>`;

  h += secHdrPrint('GARANTIA');
  h += fRow('Prazo de Garantia', 'prazo_garantia');
  h += secHdrPrint('HISTÓRICO DE NEGOCIAÇÃO');

  const mRow = (label, key) => {
    let r = `<tr><td class="prt-lbl" colspan="4">${label}</td>`;
    fornecedores.forEach((f, i) => {
      const v = f[key] ?? (totForn[i] > 0 ? totForn[i] : null);
      r += `<td${cellCls(f.id, false)} colspan="2">${v != null ? fmtMoeda(v) : '—'}</td>`;
    });
    return r + '</tr>';
  };

  h += mRow('Proposta Inicial', 'proposta_inicial');
  h += `<tr style="height:10px;"><td colspan="${totalCols}"></td></tr>`;
  h += `<tr style="height:10px;"><td colspan="${totalCols}"></td></tr>`;
  h += mRow('Proposta Final',   'proposta_final');

  // ── Proposta Vencedora
  h += `<tr><td class="prt-lbl" colspan="4">Proposta Vencedora</td>`;
  fornecedores.forEach(f => {
    h += `<td${cellCls(f.id, false)} colspan="2" style="text-align:center;font-weight:700">${vc(f.id) ? 'x' : ''}</td>`;
  });
  h += `</tr></table>`;

  // ── OBS (abaixo da tabela, texto simples)
  const obsGeral  = (document.getElementById('obs-geral')?.value  || '').trim();
  const obsPortal = (document.getElementById('obs-portal')?.value || '').trim();
  if (obsGeral || obsPortal) {
    h += `<div class="prt-obs">`;
    if (obsGeral)  h += `<p><strong>OBS:</strong> ${obsGeral}</p>`;
    if (obsPortal) h += `<p><strong>OBS — Portal de Compras Governamentais:</strong> ${obsPortal}</p>`;
    h += `</div>`;
  }

  // ── Rodapé de impressão
  const now = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  h += `<div class="prt-footer">
    <span>CEASA Minas Centrais de Abastecimento de Minas Gerais</span>
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
