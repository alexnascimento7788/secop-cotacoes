// ── Autocomplete a partir do histórico já digitado (via /api/autocomplete/:campo) ─
//
// Dois modos:
//  - initDatalistAutocomplete: para <input> de uma linha, usa <datalist> nativo.
//  - initSuggestAutocomplete:  para <textarea> (datalist não funciona em textarea),
//    mostra um painel de sugestões abaixo do campo.

const _autocompleteCache = {};

async function _fetchHistorico(campo) {
  if (_autocompleteCache[campo]) return _autocompleteCache[campo];
  const promessa = (async () => {
    try {
      const res = await fetch(`/api/autocomplete/${campo}`);
      return res.ok ? await res.json() : [];
    } catch {
      return [];
    }
  })();
  _autocompleteCache[campo] = promessa;
  return promessa;
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
  const valores = await _fetchHistorico(campo);
  if (!valores.length) return;

  let wrap = el.parentElement;
  if (!wrap.classList.contains('autocomplete-wrap')) {
    wrap = document.createElement('div');
    wrap.className = 'autocomplete-wrap';
    wrap.style.position = 'relative';
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);
  }

  const panel = document.createElement('div');
  panel.className = 'autocomplete-panel';
  wrap.appendChild(panel);

  let matches = [];
  let highlighted = -1;

  function render() {
    panel.innerHTML = matches.map((v, i) => `
      <div class="autocomplete-item${i === highlighted ? ' highlighted' : ''}" data-i="${i}">${
        (v.length > 140 ? v.slice(0, 140) + '…' : v).replace(/</g, '&lt;')
      }</div>
    `).join('');
  }

  function abrir() {
    const termo = el.value.trim().toLowerCase();
    matches = (termo
      ? valores.filter(v => v.toLowerCase().includes(termo) && v.trim().toLowerCase() !== termo)
      : valores
    ).slice(0, 6);
    highlighted = -1;
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
    if (!matches[i]) return;
    el.value = matches[i];
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
    else if (e.key === 'Enter' && highlighted >= 0) { e.preventDefault(); escolher(highlighted); }
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
