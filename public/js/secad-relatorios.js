// ── SECAD/Relatórios: adesão à renovação (front) ─────────────────────────────
// Importação (admin-only) + indicadores por prazo × cidade. Parse do Excel
// acontece aqui, no navegador, via SheetJS — mesmo padrão de
// public/js/pac-importacao.js — o servidor só recebe linhas já em JSON.

let _relArquivo = null;
let _relIniciado = false;

async function _relCarregarXLSX() {
  if (window.XLSX) return window.XLSX;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('Falha ao carregar a biblioteca de planilhas'));
    document.head.appendChild(s);
  });
}

function _relNormalizarHeader(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

// Mapeia cabeçalho da planilha → campo do sistema, de forma tolerante (não
// exige o texto exato) — pra aguentar pequenas variações entre exportações
// que o Alex gerar da query dele ao longo do tempo.
function _relMapearColuna(headerBruto) {
  const h = _relNormalizarHeader(headerBruto);
  if (h.includes('codigo')) return 'codigo';
  if (h.includes('cnpj')) return 'cnpj';
  if (h.includes('contrato') || h.includes('ccu')) return 'numero_ccu';
  if (h.includes('aceite') || h.includes('data')) return 'data_aceite';
  return null;
}

function relArquivoSelecionado(file) {
  if (!file) return;
  _relArquivo = file;
  document.getElementById('rel-dropzone-texto').textContent = `${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
  document.getElementById('rel-btn-simular').disabled = false;
  document.getElementById('rel-btn-confirmar').style.display = 'none';
  document.getElementById('rel-import-preview').style.display = 'none';
}

async function _relLerLinhas() {
  const XLSX = await _relCarregarXLSX();
  const data = await _relArquivo.arrayBuffer();
  const wb = XLSX.read(data, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (!rows.length) throw new Error('Arquivo vazio.');
  const cabecalho = rows[0].map(_relMapearColuna);
  const faltando = ['codigo', 'numero_ccu'].filter(campo => !cabecalho.includes(campo));
  if (faltando.length) throw new Error(`Não encontrei a(s) coluna(s): ${faltando.join(', ')}. Confira os cabeçalhos da planilha.`);
  return rows.slice(1).filter(r => r.some(v => String(v).trim() !== '')).map(r => {
    const linha = {};
    cabecalho.forEach((campo, i) => { if (campo) linha[campo] = r[i]; });
    return linha;
  });
}

async function relImportar(dryRun) {
  const msg = document.getElementById('rel-import-msg');
  msg.style.color = ''; msg.textContent = '';
  if (!_relArquivo) { msg.style.color = 'var(--vermelho)'; msg.textContent = 'Selecione um arquivo.'; return; }
  try {
    const linhas = await _relLerLinhas();
    const res = await fetch('/api/secad/relatorios/importar-aceites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: !!dryRun, nome_arquivo: _relArquivo.name, linhas }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Erro ao importar.');
    if (dryRun) {
      _relMostrarSimulacao(r);
      document.getElementById('rel-btn-confirmar').style.display = '';
    } else {
      msg.style.color = 'var(--verde)';
      msg.textContent = `Importado! Lote #${r.importacao_id} — ${r.total_linhas} linha(s), ${r.nao_casados} sem contrato correspondente.`;
      document.getElementById('rel-btn-confirmar').style.display = 'none';
      document.getElementById('rel-btn-simular').disabled = true;
      document.getElementById('rel-import-preview').style.display = 'none';
      _relArquivo = null;
      document.getElementById('rel-file-input').value = '';
      document.getElementById('rel-dropzone-texto').textContent = 'Clique ou arraste o arquivo aqui (.xlsx)';
      await _relCarregarImportacoes(r.importacao_id);
      await carregarRelatorioAdesao();
    }
  } catch (e) {
    msg.style.color = 'var(--vermelho)';
    msg.textContent = e.message;
  }
}

function _relMostrarSimulacao(r) {
  const el = document.getElementById('rel-import-preview');
  el.style.display = '';
  const linhasNaoCasadas = r.nao_casados_amostra.map(n => `<div class="imp-log-linha imp-log-alerta">Código ${n.codigo} / CCU ${n.numero_ccu} — nenhum contrato correspondente em Avaliação</div>`).join('');
  const linhasInvalidas = r.invalidas_amostra.map(n => `<div class="imp-log-linha imp-log-erro">Linha ${n.linha}: ${n.motivo}</div>`).join('');
  el.innerHTML = `
    <div class="imp-contadores">
      <div class="imp-contador" style="color:var(--text);">${r.total_linhas} linha(s) na planilha</div>
      <div class="imp-contador" style="color:var(--verde);">${r.casados} casam com um contrato</div>
      <div class="imp-contador" style="color:var(--amarelo);">${r.nao_casados} sem contrato correspondente</div>
      ${r.invalidas ? `<div class="imp-contador" style="color:var(--vermelho);">${r.invalidas} inválida(s)</div>` : ''}
    </div>
    ${linhasInvalidas}
    ${linhasNaoCasadas}
    ${r.nao_casados > r.nao_casados_amostra.length ? `<div class="text-muted" style="font-size:12px;margin-top:6px;">… e mais ${r.nao_casados - r.nao_casados_amostra.length} sem contrato correspondente.</div>` : ''}
    <p class="text-muted" style="font-size:12px;margin-top:10px;">
      Todas as ${r.validas} linha(s) válida(s) serão importadas (mesmo as sem contrato correspondente — elas só não entram nos indicadores por prazo/cidade).
    </p>
  `;
}

// ── Relatório ────────────────────────────────────────────────────────────────

async function initRelatorios() {
  if (_relIniciado) { carregarRelatorioAdesao(); return; }
  _relIniciado = true;
  document.getElementById('rel-filtro-importacao').addEventListener('change', carregarRelatorioAdesao);
  document.getElementById('rel-filtro-prazo').addEventListener('change', carregarRelatorioAdesao);
  document.getElementById('rel-filtro-cidade').addEventListener('change', carregarRelatorioAdesao);
  await Promise.all([_relCarregarImportacoes(), _relCarregarCidades()]);
  await carregarRelatorioAdesao();
}

async function _relCarregarImportacoes(selecionarId) {
  const sel = document.getElementById('rel-filtro-importacao');
  try {
    const res = await fetch('/api/secad/relatorios/importacoes');
    const lotes = res.ok ? await res.json() : [];
    sel.innerHTML = lotes.map((l, i) => `<option value="${l.id}">${i === 0 ? '🟢 Atual' : 'Lote anterior'} — ${l.id} · ${_relFmtDataHora(l.criado_em)} · ${l.total_linhas} linha(s)${l.nao_casados ? ` · ${l.nao_casados} sem contrato` : ''}</option>`).join('');
    if (selecionarId) sel.value = String(selecionarId);
  } catch {
    sel.innerHTML = '';
  }
}

async function _relCarregarCidades() {
  const sel = document.getElementById('rel-filtro-cidade');
  try {
    const res = await fetch('/api/secad/relatorios/cidades');
    const cidades = res.ok ? await res.json() : [];
    sel.innerHTML = '<option value="">Todas as cidades</option>' + cidades.map(c => `<option value="${c.id}">${c.descricao}</option>`).join('');
  } catch { /* mantém só "Todas as cidades" */ }
}

function _relParamsAtuais() {
  const p = new URLSearchParams();
  const imp = document.getElementById('rel-filtro-importacao').value;
  const prazo = document.getElementById('rel-filtro-prazo').value;
  const cidade = document.getElementById('rel-filtro-cidade').value;
  if (imp) p.set('importacao_id', imp);
  if (prazo) p.set('prazo', prazo);
  if (cidade) p.set('cidade_id', cidade);
  return p;
}

function _relFmtDataHora(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return String(iso);
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function carregarRelatorioAdesao() {
  const info = document.getElementById('rel-base-info');
  const cont = document.getElementById('rel-conteudo');
  try {
    const res = await fetch(`/api/secad/relatorios/adesao?${_relParamsAtuais().toString()}`);
    if (res.status === 404) {
      info.textContent = '';
      cont.innerHTML = `<div class="card"><div style="padding:40px;text-align:center;color:var(--text-muted);">Nenhuma importação feita ainda.</div></div>`;
      return;
    }
    const dados = await res.json();
    info.textContent = `Base: importação #${dados.importacao.id} — "${dados.importacao.nome_arquivo || '—'}", ${_relFmtDataHora(dados.importacao.criado_em)}, ${dados.importacao.total_linhas} linha(s)${dados.importacao.nao_casados ? ` (${dados.importacao.nao_casados} sem contrato correspondente)` : ''}.`;
    if (!dados.grupos.length) {
      cont.innerHTML = `<div class="card"><div style="padding:40px;text-align:center;color:var(--text-muted);">Nenhum contrato no intervalo de prazo previsto (2027–2032) com os filtros atuais.</div></div>`;
      return;
    }
    cont.innerHTML = dados.grupos.map(_relRenderGrupo).join('');
  } catch {
    info.textContent = '';
    cont.innerHTML = `<div class="card"><div style="padding:40px;text-align:center;color:var(--vermelho);">Erro ao carregar o relatório.</div></div>`;
  }
}

function _relRenderGrupo(g) {
  const classePct = pct => pct >= 80 ? 'rel-pct-ok' : (pct < 50 ? 'rel-pct-baixo' : '');
  const linhasCidade = g.cidades.map(c => `
    <tr>
      <td>${c.cidade}</td><td>${c.total}</td><td>${c.aceitaram}</td><td>${c.pendentes}</td>
      <td class="${classePct(c.pct)}">${c.pct.toFixed(1)}%</td>
    </tr>`).join('');
  const linhasPendentes = g.lista_pendentes.map(p => `
    <tr><td>${p.codigo}</td><td>${p.concessionario}</td><td>${p.cnpj}</td><td>${p.numero_ccu}</td><td>${p.cidade}</td></tr>
  `).join('');
  return `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header"><span class="card-title">Prazo final: ${g.prazo}</span></div>
      <div class="cards-grid" style="padding:14px 16px 0;">
        <div class="card" style="box-shadow:none;border:1px solid var(--cinza-b);"><div style="padding:14px;"><div class="text-muted" style="font-size:11px;text-transform:uppercase;">Total</div><div style="font-size:22px;font-weight:700;">${g.total.total}</div></div></div>
        <div class="card" style="box-shadow:none;border:1px solid var(--cinza-b);"><div style="padding:14px;"><div class="text-muted" style="font-size:11px;text-transform:uppercase;">Aceitaram</div><div style="font-size:22px;font-weight:700;color:var(--verde);">${g.total.aceitaram}</div></div></div>
        <div class="card" style="box-shadow:none;border:1px solid var(--cinza-b);"><div style="padding:14px;"><div class="text-muted" style="font-size:11px;text-transform:uppercase;">Pendentes</div><div style="font-size:22px;font-weight:700;color:var(--vermelho);">${g.total.pendentes}</div></div></div>
        <div class="card" style="box-shadow:none;border:1px solid var(--cinza-b);"><div style="padding:14px;"><div class="text-muted" style="font-size:11px;text-transform:uppercase;">% Adesão</div><div style="font-size:22px;font-weight:700;" class="${classePct(g.total.pct)}">${g.total.pct.toFixed(1)}%</div></div></div>
      </div>
      <div class="table-wrap" style="padding:14px 16px;">
        <table class="rel-grupo-cidades">
          <thead><tr><th>Cidade</th><th>Total</th><th>Aceitaram</th><th>Pendentes</th><th>% Adesão</th></tr></thead>
          <tbody>${linhasCidade}</tbody>
        </table>
      </div>
      ${g.lista_pendentes.length ? `
      <details style="padding:0 16px 16px;">
        <summary style="cursor:pointer;font-size:13px;color:var(--text-muted);">Ver ${g.lista_pendentes.length} concessionário(s) pendente(s)</summary>
        <div class="table-wrap" style="margin-top:10px;">
          <table class="rel-grupo-cidades">
            <thead><tr><th>Código</th><th>Concessionário</th><th>CNPJ</th><th>CCU</th><th>Cidade</th></tr></thead>
            <tbody>${linhasPendentes}</tbody>
          </table>
        </div>
      </details>` : ''}
    </div>
  `;
}

function baixarPdfAdesao() {
  window.open(`/api/secad/relatorios/adesao/pdf?${_relParamsAtuais().toString()}`, '_blank');
}
