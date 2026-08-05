// Módulo Depop — gate de 1º acesso (CPF + senha de assinatura).
// auth.js já garantiu que o módulo ativo é o Depop antes daqui.

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

// Máscara 000.000.000-00 enquanto digita
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

async function initDepop() {
  try {
    const res = await fetch('/api/depop/perfil');
    if (res.status === 401) { window.location.replace('/login.html'); return; }
    if (res.status === 403) { window.location.replace('/selecionar-modulo.html'); return; }
    const data = await res.json();
    _mostrar(data.cadastrado ? 'depop-content' : 'depop-setup');
  } catch {
    _mostrar('depop-content'); // falha transitória: não trava o usuário na tela de loading
  }
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
    msg.style.color = 'var(--verde)'; msg.textContent = 'Acesso configurado!';
    _mostrar('depop-content');
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Salvar e continuar';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const cpfInp = document.getElementById('dp-cpf');
  if (cpfInp) cpfInp.addEventListener('input', () => { cpfInp.value = mascararCpf(cpfInp.value); });
  initDepop();
});
