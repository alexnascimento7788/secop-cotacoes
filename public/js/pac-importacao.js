// ── PAC: Importação de Planilhas + Console SQL (front) ────────────────────────
// Ferramenta admin-only (master/admin_sistema). O parse do Excel acontece
// aqui, no navegador, via SheetJS — mesmo padrão de public/js/novo-processo.js
// (SECOP) — o servidor só recebe linhas já em JSON.

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  setTimeout(() => { el.className = ''; }, 3500);
}

async function carregarXLSX() {
  if (window.XLSX) return window.XLSX;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('Falha ao carregar a biblioteca de planilhas'));
    document.head.appendChild(s);
  });
}

function normalizarTextoJs(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

// Fuzzy match simples: igualdade normalizada primeiro, "contém" como fallback.
function melhorMatch(headerBruto, candidatos) {
  const alvo = normalizarTextoJs(headerBruto);
  if (!alvo) return null;
  let exato = candidatos.find(c => normalizarTextoJs(c.label) === alvo);
  if (exato) return exato.slug;
  let parcial = candidatos.find(c => normalizarTextoJs(c.label).includes(alvo) || alvo.includes(normalizarTextoJs(c.label)));
  return parcial ? parcial.slug : null;
}

// ── Acesso (master/admin_sistema apenas — não é Perfil/Rotina, ver
// routes/pac-importacao.js) ───────────────────────────────────────────────────
(async () => {
  const user = await window.getCurrentUser();
  if (!user) return;
  const podeAdmin = user.username === 'master' || user.role === 'admin_sistema';
  if (!podeAdmin) {
    document.getElementById('imp-sem-acesso').style.display = 'block';
    return;
  }
  document.getElementById('imp-conteudo').style.display = 'block';
  await inicializar();
})();

// ── Abas ───────────────────────────────────────────────────────────────────────
document.querySelectorAll('#imp-tabs-topo .page-tab').forEach(t => t.addEventListener('click', () => mudarAbaTopo(t.dataset.top)));
document.querySelectorAll('#imp-tabs-fase .page-tab').forEach(t => t.addEventListener('click', () => mudarAbaFase(t.dataset.fase)));

function mudarAbaTopo(aba) {
  document.querySelectorAll('#imp-tabs-topo .page-tab').forEach(t => t.classList.toggle('active', t.dataset.top === aba));
  document.getElementById('top-importacao').classList.toggle('active', aba === 'importacao');
  document.getElementById('top-console').classList.toggle('active', aba === 'console');
}

function mudarAbaFase(fase) {
  document.querySelectorAll('#imp-tabs-fase .page-tab').forEach(t => t.classList.toggle('active', t.dataset.fase === fase));
  document.getElementById('fase-1').classList.toggle('active', fase === '1');
  document.getElementById('fase-2').classList.toggle('active', fase === '2');
}

function irParaPasso(prefixo, passo) {
  document.querySelectorAll(`#${prefixo === 'f1' ? 'fase-1' : 'fase-2'} .imp-passo`).forEach(p => p.classList.remove('active'));
  document.getElementById(`${prefixo}-passo-${passo}`).classList.add('active');
}

// ── Init: popula selects comuns às duas fases ──────────────────────────────────
let _dfds = [], _setores = [];

async function inicializar() {
  try {
    const [dfdsRes, setoresRes] = await Promise.all([
      fetch('/api/pac/importacao/dfds'),
      fetch('/api/pac/importacao/setores'),
    ]);
    _dfds = dfdsRes.ok ? await dfdsRes.json() : [];
    _setores = setoresRes.ok ? await setoresRes.json() : [];
  } catch { toast('Erro ao carregar DFDs/setores', 'error'); return; }

  const f1Select = document.getElementById('f1-dfd-select');
  f1Select.innerHTML = '<option value="novo">+ Criar novo DFD</option>' +
    _dfds.filter(d => d.status === 'aberto').map(d => `<option value="${d.id}">${d.titulo} (${d.ano_base})</option>`).join('');
  f1MudarDfd();

  document.getElementById('f1-setor-select').innerHTML = _setores.map(s => `<option value="${s.id}">${s.nome}</option>`).join('');

  document.getElementById('f2-dfd-select').innerHTML = _dfds.map(d => `<option value="${d.id}">${d.titulo} (${d.ano_base}) — ${d.status}</option>`).join('');

  // Dropzones — clique já abre o input (onclick no HTML); aqui só o
  // drag-and-drop, igual pedido no prompt.
  ['f1', 'f2'].forEach(p => {
    const zona = document.getElementById(`${p}-dropzone`);
    zona.addEventListener('dragover', e => { e.preventDefault(); zona.classList.add('drag-over'); });
    zona.addEventListener('dragleave', () => zona.classList.remove('drag-over'));
    zona.addEventListener('drop', e => {
      e.preventDefault(); zona.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f) (p === 'f1' ? f1ArquivoSelecionado : f2ArquivoSelecionado)(f);
    });
  });

  document.getElementById('sql-editor').addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') sqlExecutar();
  });
}

function f1MudarDfd() {
  const novo = document.getElementById('f1-dfd-select').value === 'novo';
  document.getElementById('f1-novo-dfd-wrap').style.display = novo ? 'grid' : 'none';
}

// ═══════════════════════════════════════════════════════════════════════════
// FASE 1 — Lançamentos DFD
// ═══════════════════════════════════════════════════════════════════════════
let _f1Arquivo = null, _f1Linhas = null, _f1ColunasAtivas = null, _f1Resultado = null;

function f1ArquivoSelecionado(file) {
  if (!file) return;
  _f1Arquivo = file;
  document.getElementById('f1-dropzone-texto').textContent = `${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
  document.getElementById('f1-btn-pre').disabled = false;
}

async function f1PreVisualizar() {
  const msg = document.getElementById('f1-msg-passo1');
  msg.style.color = ''; msg.textContent = '';
  const setorId = Number(document.getElementById('f1-setor-select').value);
  const dfdSel = document.getElementById('f1-dfd-select').value;
  if (dfdSel === 'novo') {
    const ano = document.getElementById('f1-novo-ano').value;
    const titulo = document.getElementById('f1-novo-titulo').value.trim();
    if (!ano || !titulo) { msg.style.color = '#c00'; msg.textContent = 'Preencha ano base e título do novo DFD.'; return; }
  }
  if (!_f1Arquivo) { msg.style.color = '#c00'; msg.textContent = 'Selecione um arquivo.'; return; }

  try {
    // Colunas ativas do DFD escolhido, ou (DFD novo, ainda não existe) o
    // catálogo padrão completo — mesma lista que ele vai ganhar de verdade ao
    // ser criado (ver POST /api/pac/dfds em routes/pac.js).
    const rColunas = dfdSel === 'novo'
      ? await fetch('/api/pac/importacao/colunas-catalogo')
      : await fetch(`/api/pac/importacao/dfds/${dfdSel}/colunas-ativas`);
    _f1ColunasAtivas = rColunas.ok ? await rColunas.json() : [];

    const XLSX = await carregarXLSX();
    const data = await _f1Arquivo.arrayBuffer();
    const wb = XLSX.read(data, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!rows.length) { msg.style.color = '#c00'; msg.textContent = 'Arquivo vazio.'; return; }

    _f1Linhas = rows;
    f1MontarPreview(setorId, dfdSel);
    irParaPasso('f1', 2);
  } catch (e) {
    msg.style.color = '#c00'; msg.textContent = 'Erro ao ler o arquivo: ' + e.message;
  }
}

function f1MontarPreview(setorId, dfdSel) {
  const headers = _f1Linhas[0].map(h => String(h || '').trim());
  const dataRows = _f1Linhas.slice(1).filter(r => r.some(c => String(c || '').trim() !== ''));

  document.getElementById('f1-preview-thead').innerHTML = headers.map(h => `<th>${h || '—'}</th>`).join('');
  document.getElementById('f1-preview-tbody').innerHTML = dataRows.slice(0, 5).map(r =>
    `<tr>${headers.map((_, i) => `<td>${r[i] ?? ''}</td>`).join('')}</tr>`
  ).join('');

  const candidatos = _f1ColunasAtivas.map(c => ({ slug: c.slug, label: c.label }));
  document.getElementById('f1-mapa-tbody').innerHTML = headers.map((h, i) => {
    const auto = melhorMatch(h, candidatos);
    return `<tr>
      <td>${h || `(coluna ${i + 1})`}</td>
      <td><select data-idx="${i}" onchange="f1RecalcularIndicadores()">
        <option value="">Ignorar</option>
        ${candidatos.map(c => `<option value="${c.slug}" ${c.slug === auto ? 'selected' : ''}>${c.label}</option>`).join('')}
      </select></td>
    </tr>`;
  }).join('');

  document.getElementById('f1-cnt-total').textContent = dataRows.length;
  f1RecalcularIndicadores();

  // Aviso de itens já existentes nesse setor/DFD
  const wrap = document.getElementById('f1-modo-existentes');
  if (dfdSel === 'novo') { wrap.style.display = 'none'; return; }
  fetch(`/api/pac/importacao/dfds/${dfdSel}/itens-existentes?setor_id=${setorId}`)
    .then(r => r.ok ? r.json() : { total: 0 })
    .then(({ total }) => {
      wrap.style.display = total > 0 ? 'block' : 'none';
      if (total > 0) document.getElementById('f1-modo-aviso').textContent =
        `Já existem ${total} item(ns) deste setor neste DFD.`;
    });
}

function f1RecalcularIndicadores() {
  const selects = [...document.querySelectorAll('#f1-mapa-tbody select')];
  const reconhecidas = selects.filter(s => s.value).length;
  document.getElementById('f1-cnt-reconhecidas').textContent = reconhecidas;
  document.getElementById('f1-cnt-pendentes').textContent = selects.length - reconhecidas;

  const mapeados = new Set(selects.map(s => s.value).filter(Boolean));
  const faltando = _f1ColunasAtivas.filter(c => c.obrigatoria && !mapeados.has(c.slug));
  const msg = document.getElementById('f1-msg-obrigatorias');
  const btn = document.getElementById('f1-btn-importar');
  if (faltando.length) {
    msg.textContent = `Coluna(s) obrigatória(s) não mapeada(s): ${faltando.map(c => c.label).join(', ')}`;
    btn.disabled = true;
  } else {
    msg.textContent = '';
    btn.disabled = false;
  }
}

function f1Voltar() { irParaPasso('f1', 1); }

async function f1Importar() {
  const dfdSel = document.getElementById('f1-dfd-select').value;
  const setorId = Number(document.getElementById('f1-setor-select').value);
  const modo = document.querySelector('input[name="f1-modo"]:checked')?.value || 'adicionar';

  const headers = _f1Linhas[0].map(h => String(h || '').trim());
  const dataRows = _f1Linhas.slice(1).filter(r => r.some(c => String(c || '').trim() !== ''));
  const mapeamento = {};
  document.querySelectorAll('#f1-mapa-tbody select').forEach(s => {
    if (s.value) mapeamento[headers[Number(s.dataset.idx)] || `coluna_${s.dataset.idx}`] = s.value;
  });

  const linhas = dataRows.map(r => {
    const obj = {};
    document.querySelectorAll('#f1-mapa-tbody select').forEach(s => {
      if (!s.value) return;
      obj[s.value] = r[Number(s.dataset.idx)];
    });
    return obj;
  });

  const payload = { dfd_id: dfdSel, setor_id: setorId, mapeamento, modo, linhas };
  if (dfdSel === 'novo') {
    payload.ano_base = Number(document.getElementById('f1-novo-ano').value);
    payload.titulo = document.getElementById('f1-novo-titulo').value.trim();
  }

  const btn = document.getElementById('f1-btn-importar');
  btn.disabled = true; btn.textContent = 'Importando...';
  try {
    const res = await fetch('/api/pac/importacao/dfd', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Erro ao importar');
    _f1Resultado = r;
    f1MostrarResultado(r);
    irParaPasso('f1', 3);
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Importar agora';
  }
}

function f1MostrarResultado(r) {
  document.getElementById('f1-cnt-importados').textContent = r.importados;
  document.getElementById('f1-cnt-alertas').textContent = r.alertas;
  document.getElementById('f1-cnt-erros').textContent = r.erros;
  const banner = document.getElementById('f1-banner');
  if (r.erros > 0) banner.innerHTML = `<div class="imp-banner imp-banner-vermelho">Importação concluída com ${r.erros} erro(s).</div>`;
  else if (r.alertas > 0) banner.innerHTML = `<div class="imp-banner imp-banner-amarelo">Importação concluída com ${r.alertas} alerta(s).</div>`;
  else banner.innerHTML = `<div class="imp-banner imp-banner-verde">Importação 100% bem-sucedida.</div>`;
  document.getElementById('f1-log').innerHTML = (r.log || []).map(l =>
    `<div class="imp-log-linha imp-log-${l.tipo}">${l.tipo === 'erro' ? '❌' : l.tipo === 'alerta' ? '⚠️' : '✅'} Linha ${l.linha} — ${l.mensagem}</div>`
  ).join('');
}

function f1ImportarOutroSetor() {
  document.getElementById('f1-file-input').value = '';
  document.getElementById('f1-dropzone-texto').textContent = 'Clique ou arraste o arquivo aqui';
  _f1Arquivo = null; _f1Linhas = null;
  document.getElementById('f1-btn-pre').disabled = true;
  irParaPasso('f1', 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// FASE 2 — Acompanhamento
// ═══════════════════════════════════════════════════════════════════════════
const F2_CAMPOS = [
  { slug: 'numero_pac', label: 'Nº PAC', obrigatoria: true },
  { slug: 'status_execucao', label: 'Status', obrigatoria: false },
  { slug: 'numero_sei', label: 'Nº SEI', obrigatoria: false },
  { slug: 'numero_totvs', label: 'Nº TOTVS', obrigatoria: false },
  { slug: 'data_solicitacao', label: 'Data', obrigatoria: false },
  { slug: 'valor_tu_mlp', label: 'Valor TU+MLP', obrigatoria: false },
  { slug: 'valor_rdc', label: 'Valor RDC', obrigatoria: false },
];

let _f2Arquivo = null, _f2Workbook = null, _f2AbaEscolhida = null, _f2Linhas = null, _f2Resultado = null;

function f2ArquivoSelecionado(file) {
  if (!file) return;
  _f2Arquivo = file;
  document.getElementById('f2-dropzone-texto').textContent = `${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
  document.getElementById('f2-btn-pre').disabled = false;
}

async function f2PreVisualizar() {
  const msg = document.getElementById('f2-msg-passo1');
  msg.style.color = ''; msg.textContent = '';
  if (!_f2Arquivo) { msg.style.color = '#c00'; msg.textContent = 'Selecione um arquivo.'; return; }

  try {
    const XLSX = await carregarXLSX();
    const data = await _f2Arquivo.arrayBuffer();
    _f2Workbook = XLSX.read(data, { type: 'array' });

    const abaWrap = document.getElementById('f2-aba-wrap');
    const abaSelect = document.getElementById('f2-aba-select');
    if (_f2Workbook.SheetNames.length > 1) {
      abaWrap.style.display = 'block';
      const autoAba = _f2Workbook.SheetNames.find(n => normalizarTextoJs(n).includes('acompanhamento')) || _f2Workbook.SheetNames[0];
      abaSelect.innerHTML = _f2Workbook.SheetNames.map(n => `<option value="${n}" ${n === autoAba ? 'selected' : ''}>${n}${n === autoAba ? ' (detectada automaticamente)' : ''}</option>`).join('');
      _f2AbaEscolhida = autoAba;
    } else {
      abaWrap.style.display = 'none';
      _f2AbaEscolhida = _f2Workbook.SheetNames[0];
    }

    f2CarregarAba();
    irParaPasso('f2', 2);
  } catch (e) {
    msg.style.color = '#c00'; msg.textContent = 'Erro ao ler o arquivo: ' + e.message;
  }
}

function f2MudarAba() {
  _f2AbaEscolhida = document.getElementById('f2-aba-select').value;
  f2CarregarAba();
}

function f2CarregarAba() {
  const XLSX = window.XLSX;
  const ws = _f2Workbook.Sheets[_f2AbaEscolhida];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  _f2Linhas = rows;
  f2MontarPreview();
}

function f2MontarPreview() {
  const headers = _f2Linhas[0].map(h => String(h || '').trim());
  const dataRows = _f2Linhas.slice(1).filter(r => r.some(c => String(c || '').trim() !== ''));

  document.getElementById('f2-preview-thead').innerHTML = headers.map(h => `<th>${h || '—'}</th>`).join('');
  document.getElementById('f2-preview-tbody').innerHTML = dataRows.slice(0, 5).map(r =>
    `<tr>${headers.map((_, i) => `<td>${r[i] ?? ''}</td>`).join('')}</tr>`
  ).join('');

  document.getElementById('f2-mapa-tbody').innerHTML = headers.map((h, i) => {
    const auto = melhorMatch(h, F2_CAMPOS);
    return `<tr>
      <td>${h || `(coluna ${i + 1})`}</td>
      <td><select data-idx="${i}" onchange="f2RecalcularIndicadores()">
        <option value="">Ignorar</option>
        ${F2_CAMPOS.map(c => `<option value="${c.slug}" ${c.slug === auto ? 'selected' : ''}>${c.label}</option>`).join('')}
      </select></td>
    </tr>`;
  }).join('');

  document.getElementById('f2-cnt-total').textContent = dataRows.length;
  f2RecalcularIndicadores();
}

function f2RecalcularIndicadores() {
  const selects = [...document.querySelectorAll('#f2-mapa-tbody select')];
  const idxNumeroPac = selects.find(s => s.value === 'numero_pac')?.dataset.idx;

  const headers = _f2Linhas[0];
  const dataRows = _f2Linhas.slice(1).filter(r => r.some(c => String(c || '').trim() !== ''));
  let reconhecidas = 0, semVinculo = 0;
  if (idxNumeroPac !== undefined) {
    dataRows.forEach(r => {
      const v = String(r[Number(idxNumeroPac)] || '').trim();
      if (!v || normalizarTextoJs(v) === 'naotem') semVinculo++;
      else reconhecidas++;
    });
  }
  document.getElementById('f2-cnt-reconhecidas').textContent = reconhecidas;
  document.getElementById('f2-cnt-sem-vinculo').textContent = semVinculo;

  const msg = document.getElementById('f2-msg-obrigatorias');
  const btn = document.getElementById('f2-btn-importar');
  if (idxNumeroPac === undefined) {
    msg.textContent = 'Mapeie a coluna "Nº PAC" (obrigatória).';
    btn.disabled = true;
  } else {
    msg.textContent = '';
    btn.disabled = false;
  }
}

function f2Voltar() { irParaPasso('f2', 1); }

async function f2Importar() {
  const dfdId = Number(document.getElementById('f2-dfd-select').value);
  const headers = _f2Linhas[0].map(h => String(h || '').trim());
  const dataRows = _f2Linhas.slice(1).filter(r => r.some(c => String(c || '').trim() !== ''));

  const mapeamento = {};
  document.querySelectorAll('#f2-mapa-tbody select').forEach(s => {
    if (s.value) mapeamento[headers[Number(s.dataset.idx)] || `coluna_${s.dataset.idx}`] = s.value;
  });

  const linhas = dataRows.map(r => {
    const obj = {};
    document.querySelectorAll('#f2-mapa-tbody select').forEach(s => {
      if (!s.value) return;
      obj[s.value] = r[Number(s.dataset.idx)];
    });
    return obj;
  });

  const btn = document.getElementById('f2-btn-importar');
  btn.disabled = true; btn.textContent = 'Importando...';
  try {
    const res = await fetch('/api/pac/importacao/acompanhamento', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dfd_id: dfdId, mapeamento, linhas }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Erro ao importar');
    _f2Resultado = r;
    f2MostrarResultado(r);
    irParaPasso('f2', 3);
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Importar agora';
  }
}

function f2MostrarResultado(r) {
  document.getElementById('f2-cnt-atualizados').textContent = r.atualizados;
  document.getElementById('f2-cnt-solicitacoes').textContent = r.solicitacoes_criadas;
  document.getElementById('f2-cnt-erros').textContent = r.erros;
  const banner = document.getElementById('f2-banner');
  if (r.erros > 0) banner.innerHTML = `<div class="imp-banner imp-banner-vermelho">Importação concluída com ${r.erros} erro(s).</div>`;
  else banner.innerHTML = `<div class="imp-banner imp-banner-verde">Importação 100% bem-sucedida.</div>`;
  document.getElementById('f2-log').innerHTML = (r.log || []).map(l =>
    `<div class="imp-log-linha imp-log-${l.tipo}">${l.tipo === 'erro' ? '❌' : '✅'} Linha ${l.linha} — ${l.mensagem}</div>`
  ).join('');
}

function f2ImportarOutra() {
  document.getElementById('f2-file-input').value = '';
  document.getElementById('f2-dropzone-texto').textContent = 'Clique ou arraste o arquivo aqui';
  _f2Arquivo = null; _f2Workbook = null; _f2Linhas = null;
  document.getElementById('f2-btn-pre').disabled = true;
  irParaPasso('f2', 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Console SQL
// ═══════════════════════════════════════════════════════════════════════════
function sqlMudarBanco() {
  const banco = document.getElementById('sql-banco-select').value;
  document.getElementById('sql-aviso-depop').style.display = banco === 'depop' ? 'block' : 'none';
}

function sqlLimpar() {
  document.getElementById('sql-editor').value = '';
  document.getElementById('sql-resultados').innerHTML = '';
}

async function sqlExecutar() {
  const banco = document.getElementById('sql-banco-select').value;
  const sql = document.getElementById('sql-editor').value.trim();
  if (!sql) { toast('Digite um SQL', 'error'); return; }
  const btn = document.getElementById('sql-btn-executar');
  btn.disabled = true;
  try {
    const res = await fetch('/api/pac/importacao/console-sql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ banco, sql }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Erro ao executar');
    sqlRenderResultados(r.resultados);
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function sqlRenderResultados(resultados) {
  document.getElementById('sql-resultados').innerHTML = resultados.map(r => {
    if (r.erro) return `<div class="pac-card"><div class="imp-banner imp-banner-vermelho">${r.erro}</div></div>`;
    if (r.ok) return `<div class="pac-card">✅ Executado com sucesso. ${r.changes} linha(s) afetada(s).</div>`;
    if (!r.linhas.length) return `<div class="pac-card">Nenhum resultado.</div>`;
    return `<div class="pac-card">
      <div class="table-wrap"><table>
        <thead><tr>${r.colunas.map(c => `<th>${c}</th>`).join('')}</tr></thead>
        <tbody>${r.linhas.map(l => `<tr>${l.map(v => `<td>${v === null ? '<em>NULL</em>' : v}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:6px;">${r.linhas.length} linha(s) retornada(s).</div>
    </div>`;
  }).join('');
}

// ── Ponte entre uma importação concluída e o Console SQL ──────────────────────
function abrirSqlNoConsole(resultado) {
  if (!resultado) return;
  document.getElementById('sql-banco-select').value = 'secop';
  sqlMudarBanco();
  document.getElementById('sql-editor').value = resultado.sql_gerado;
  mudarAbaTopo('console');
}

async function baixarSql(resultado, nomeArquivo) {
  if (!resultado) return;
  try {
    const res = await fetch('/api/pac/importacao/baixar-sql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql_gerado: resultado.sql_gerado, nome_arquivo: nomeArquivo }),
    });
    if (!res.ok) throw new Error('Erro ao gerar o arquivo');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nomeArquivo;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}
