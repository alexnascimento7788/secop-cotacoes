// ── Autocomplete a partir do histórico já digitado (via /api/autocomplete/:campo) ─
//
// Dois modos:
//  - initDatalistAutocomplete: para <input> de uma linha, usa <datalist> nativo.
//  - initSuggestAutocomplete:  para <textarea> (datalist não funciona em textarea),
//    mostra um painel de sugestões abaixo do campo — completando a PALAVRA que
//    está sendo digitada (prioridade, funciona mesmo com pouco histórico) e,
//    quando não há match de palavra, sugerindo frases inteiras já digitadas antes.

const _autocompleteCache = {};

async function _fetchJSON(url) {
  if (_autocompleteCache[url]) return _autocompleteCache[url];
  const promessa = (async () => {
    try {
      const res = await fetch(url);
      return res.ok ? await res.json() : [];
    } catch {
      return [];
    }
  })();
  _autocompleteCache[url] = promessa;
  return promessa;
}

function _fetchHistorico(campo) { return _fetchJSON(`/api/autocomplete/${campo}`); }
function _fetchPalavras(campo)  { return _fetchJSON(`/api/autocomplete/${campo}/palavras`); }

// Palavra (letras/números) que termina exatamente no cursor
function _palavraAtual(el) {
  const antes = el.value.slice(0, el.selectionStart);
  const m = antes.match(/[\p{L}\p{N}]+$/u);
  return m ? m[0] : '';
}

// Substitui a palavra em digitação (na posição do cursor) pela palavra completa escolhida
function _completarPalavra(el, palavra) {
  const pos    = el.selectionStart;
  const antes  = el.value.slice(0, pos);
  const depois = el.value.slice(pos);
  const m      = antes.match(/[\p{L}\p{N}]+$/u);
  const inicio = m ? pos - m[0].length : pos;
  el.value = el.value.slice(0, inicio) + palavra + ' ' + depois;
  const novaPos = inicio + palavra.length + 1;
  el.setSelectionRange(novaPos, novaPos);
}

async function initDatalistAutocomplete(inputId, campo) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const valores = await _fetchHistorico(campo);
  if (!valores.length) return;

  const listId = `dl-${inputId}`;
  let datalist = document.getElementById(listId);
  if (!datalist) {
    datalist = document.createElement('datalist');
    datalist.id = listId;
    document.body.appendChild(datalist);
    input.setAttribute('list', listId);
  }
  datalist.innerHTML = valores.map(v => `<option value="${String(v).replace(/"/g, '&quot;')}"></option>`).join('');
}

async function initSuggestAutocomplete(fieldId, campo) {
  const el = document.getElementById(fieldId);
  if (!el) return;
  const [frases, palavras] = await Promise.all([_fetchHistorico(campo), _fetchPalavras(campo)]);
  if (!frases.length && !palavras.length) return;

  let wrap = el.parentElement;
  if (!wrap.classList.contains('autocomplete-wrap')) {
    wrap = document.createElement('div');
    wrap.className = 'autocomplete-wrap';
    wrap.style.position = 'relative';
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);
    // Fora do wrapper, o campo herdava largura total por ser filho direto de um
    // flex container (.form-group) com stretch — precisa reafirmar isso aqui,
    // já que dentro do wrapper ele volta a ser um <textarea> comum (inline-block).
    el.style.display = 'block';
    el.style.width   = '100%';
    el.style.boxSizing = 'border-box';
  }

  const panel = document.createElement('div');
  panel.className = 'autocomplete-panel';
  wrap.appendChild(panel);

  let matches = []; // { tipo: 'palavra'|'frase', texto, prefixo? }
  let highlighted = -1;

  function render() {
    panel.innerHTML = matches.map((item, i) => {
      const cls = `autocomplete-item${i === highlighted ? ' highlighted' : ''}`;
      if (item.tipo === 'palavra') {
        const resto = item.texto.slice(item.prefixo.length);
        return `<div class="${cls}" data-i="${i}"><strong>${item.prefixo}</strong>${resto} <span class="autocomplete-tag">completar palavra</span></div>`;
      }
      const texto = item.texto.length > 140 ? item.texto.slice(0, 140) + '…' : item.texto;
      return `<div class="${cls}" data-i="${i}">${texto.replace(/</g, '&lt;')}</div>`;
    }).join('');
  }

  function abrir() {
    const prefixo = _palavraAtual(el).toLowerCase();
    const itensPalavra = prefixo.length >= 2
      ? palavras.filter(p => p.startsWith(prefixo) && p !== prefixo).slice(0, 5).map(p => ({ tipo: 'palavra', texto: p, prefixo }))
      : [];

    const termoCompleto = el.value.trim().toLowerCase();
    const restante = 6 - itensPalavra.length;
    const itensFrase = restante > 0
      ? (termoCompleto
          ? frases.filter(f => f.toLowerCase().includes(termoCompleto) && f.trim().toLowerCase() !== termoCompleto)
          : frases
        ).slice(0, restante).map(f => ({ tipo: 'frase', texto: f }))
      : [];

    matches = [...itensPalavra, ...itensFrase];
    highlighted = matches.length ? 0 : -1; // já vem com a 1ª sugestão pré-selecionada (Enter/Tab completa direto)
    if (!matches.length) { fechar(); return; }
    render();
    panel.classList.add('open');
  }

  function fechar() {
    panel.classList.remove('open');
    matches = [];
    highlighted = -1;
  }

  function escolher(i) {
    const item = matches[i];
    if (!item) return;
    if (item.tipo === 'palavra') {
      _completarPalavra(el, item.texto);
    } else {
      el.value = item.texto;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    fechar();
    el.focus();
  }

  el.addEventListener('input', abrir);
  el.addEventListener('focus', abrir);

  el.addEventListener('keydown', e => {
    if (!panel.classList.contains('open')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlighted = Math.min(highlighted + 1, matches.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlighted = Math.max(highlighted - 1, 0); render(); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && highlighted >= 0) { e.preventDefault(); escolher(highlighted); }
    else if (e.key === 'Escape') { fechar(); }
  });

  panel.addEventListener('mousedown', e => {
    const item = e.target.closest('.autocomplete-item');
    if (item) { e.preventDefault(); escolher(parseInt(item.dataset.i, 10)); }
  });

  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) fechar();
  });
}
