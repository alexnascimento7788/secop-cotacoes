// Seletor de telefone brasileiro: bandeira do Brasil (fixa, tooltip "+55") +
// bandeira do estado (clicável, lista as 27) + DDD (filtrado pelo estado
// escolhido) + o número, que continua num <input> comum como sempre foi.
// Componente reutilizável — hoje plugado só no cadastro de fornecedor
// (Telefone/Celular), pensado pra entrar em outros campos de telefone do
// sistema depois sem precisar reescrever nada disso.
//
// Bandeiras: Wikimedia Commons, domínio público (símbolos oficiais de
// governo) — baixadas uma vez para public/img/flags/, não é dependência
// nem link externo (funciona offline, cacheável pelo Service Worker).

const TELEFONE_BR_ESTADOS = [
  { uf: 'AC', nome: 'Acre',                 ddds: ['68'] },
  { uf: 'AL', nome: 'Alagoas',              ddds: ['82'] },
  { uf: 'AP', nome: 'Amapá',                ddds: ['96'] },
  { uf: 'AM', nome: 'Amazonas',             ddds: ['92', '97'] },
  { uf: 'BA', nome: 'Bahia',                ddds: ['71', '73', '74', '75', '77'] },
  { uf: 'CE', nome: 'Ceará',                ddds: ['85', '88'] },
  { uf: 'DF', nome: 'Distrito Federal',     ddds: ['61'] },
  { uf: 'ES', nome: 'Espírito Santo',       ddds: ['27', '28'] },
  { uf: 'GO', nome: 'Goiás',                ddds: ['62', '64'] },
  { uf: 'MA', nome: 'Maranhão',             ddds: ['98', '99'] },
  { uf: 'MT', nome: 'Mato Grosso',          ddds: ['65', '66'] },
  { uf: 'MS', nome: 'Mato Grosso do Sul',   ddds: ['67'] },
  { uf: 'MG', nome: 'Minas Gerais',         ddds: ['31', '32', '33', '34', '35', '37', '38'] },
  { uf: 'PA', nome: 'Pará',                 ddds: ['91', '93', '94'] },
  { uf: 'PB', nome: 'Paraíba',              ddds: ['83'] },
  { uf: 'PR', nome: 'Paraná',               ddds: ['41', '42', '43', '44', '45', '46'] },
  { uf: 'PE', nome: 'Pernambuco',           ddds: ['81', '87'] },
  { uf: 'PI', nome: 'Piauí',                ddds: ['86', '89'] },
  { uf: 'RJ', nome: 'Rio de Janeiro',       ddds: ['21', '22', '24'] },
  { uf: 'RN', nome: 'Rio Grande do Norte',  ddds: ['84'] },
  { uf: 'RS', nome: 'Rio Grande do Sul',    ddds: ['51', '53', '54', '55'] },
  { uf: 'RO', nome: 'Rondônia',             ddds: ['69'] },
  { uf: 'RR', nome: 'Roraima',              ddds: ['95'] },
  { uf: 'SC', nome: 'Santa Catarina',       ddds: ['47', '48', '49'] },
  { uf: 'SP', nome: 'São Paulo',            ddds: ['11', '12', '13', '14', '15', '16', '17', '18', '19'] },
  { uf: 'SE', nome: 'Sergipe',              ddds: ['79'] },
  { uf: 'TO', nome: 'Tocantins',            ddds: ['63'] },
];

const TELEFONE_BR_DDD_PARA_UF = {};
TELEFONE_BR_ESTADOS.forEach(e => e.ddds.forEach(d => { TELEFONE_BR_DDD_PARA_UF[d] = e.uf; }));

function _telBrEstado(uf) {
  return TELEFONE_BR_ESTADOS.find(e => e.uf === uf) || TELEFONE_BR_ESTADOS.find(e => e.uf === 'MG');
}

let _telBrPainelAberto = null; // só 1 dropdown de estado aberto por vez na página

function _telBrFecharPainel() {
  if (_telBrPainelAberto) { _telBrPainelAberto.remove(); _telBrPainelAberto = null; }
}
document.addEventListener('click', _telBrFecharPainel);

/**
 * Transforma um <input> comum de telefone num campo com bandeira BR fixa +
 * bandeira do estado (clicável) + DDD, mantendo o próprio <input> pro número
 * (mesmo id, mesmo jeito de ler/escrever .value que já existia).
 * @param {HTMLInputElement} inputEl
 * @param {{ufPadrao?:string, dddPadrao?:string, ddd?:string}} opts
 * @returns {{getDDD:()=>string|null, setDDD:(ddd:string|null)=>void}}
 */
function iniciarTelefoneBR(inputEl, opts = {}) {
  const ufPadrao = opts.ufPadrao || 'MG';
  const dddPadrao = opts.dddPadrao || '31';

  const wrap = document.createElement('div');
  wrap.className = 'tel-br-wrap';

  const brFlag = document.createElement('img');
  brFlag.src = '/img/flags/brasil.svg';
  brFlag.alt = 'Brasil';
  brFlag.title = '+55';
  brFlag.className = 'tel-br-flag tel-br-flag-brasil';

  const estadoBtn = document.createElement('button');
  estadoBtn.type = 'button';
  estadoBtn.className = 'tel-br-flag-estado-btn';
  const estadoImg = document.createElement('img');
  estadoImg.className = 'tel-br-flag';
  estadoBtn.appendChild(estadoImg);

  const dddSelect = document.createElement('select');
  dddSelect.className = 'tel-br-ddd';

  wrap.appendChild(brFlag);
  wrap.appendChild(estadoBtn);
  wrap.appendChild(dddSelect);
  inputEl.parentNode.insertBefore(wrap, inputEl);
  wrap.appendChild(inputEl);
  inputEl.classList.add('tel-br-numero');

  let ufAtual = ufPadrao;

  function preencherDdds() {
    const estado = _telBrEstado(ufAtual);
    dddSelect.innerHTML = estado.ddds.map(d => `<option value="${d}">${d}</option>`).join('');
  }

  function render() {
    const estado = _telBrEstado(ufAtual);
    estadoImg.src = `/img/flags/estados/${estado.uf.toLowerCase()}.svg`;
    estadoImg.alt = estado.uf;
    estadoBtn.title = estado.nome;
    preencherDdds();
  }

  function abrirPainelEstados() {
    _telBrFecharPainel();
    const painel = document.createElement('div');
    painel.className = 'tel-br-painel-estados';
    painel.innerHTML = TELEFONE_BR_ESTADOS.map(e => `
      <button type="button" class="tel-br-painel-item" data-uf="${e.uf}" title="${e.nome}">
        <img src="/img/flags/estados/${e.uf.toLowerCase()}.svg" alt="${e.uf}" />
        <span>${e.uf}</span>
      </button>
    `).join('');
    painel.addEventListener('click', e => {
      const item = e.target.closest('.tel-br-painel-item');
      if (!item) return;
      ufAtual = item.dataset.uf;
      const estado = _telBrEstado(ufAtual);
      render();
      dddSelect.value = estado.ddds[0];
      _telBrFecharPainel();
    });
    // impede o listener global (que fecha ao clicar em qualquer lugar) de
    // fechar o painel ao clicar dentro dele mesmo
    painel.addEventListener('click', e => e.stopPropagation());
    wrap.appendChild(painel);
    _telBrPainelAberto = painel;
  }

  estadoBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (_telBrPainelAberto && _telBrPainelAberto.parentElement === wrap) { _telBrFecharPainel(); return; }
    abrirPainelEstados();
  });

  ufAtual = opts.ddd && TELEFONE_BR_DDD_PARA_UF[opts.ddd] ? TELEFONE_BR_DDD_PARA_UF[opts.ddd] : ufPadrao;
  render();
  dddSelect.value = opts.ddd || dddPadrao;

  return {
    getDDD() { return dddSelect.value || null; },
    setDDD(ddd) {
      ufAtual = ddd && TELEFONE_BR_DDD_PARA_UF[ddd] ? TELEFONE_BR_DDD_PARA_UF[ddd] : ufPadrao;
      render();
      dddSelect.value = ddd || dddPadrao;
    },
  };
}
