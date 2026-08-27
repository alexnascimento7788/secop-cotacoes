const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, setupDb, depopDb, setupDepop, depopFilePath, anexosDb, setupAnexos, anexosFilePath } = require('./database');
// Peças transversais (auth/sessão/log/gates genéricos) — extraídas pra
// middleware.js na modularização por módulo. Passo 1 do plano; as rotas em si
// ainda estão todas aqui neste arquivo, isso vem nos passos seguintes.
const {
  n, getCookie, getInatividadeMinutos, renovarSessao, SESSAO_SQL, requireAuth,
  resolverPerfilId, modulosDoUsuario, registrarLog, CONSULTA_POST_OK,
  requireAdminAny, requireAdminSistema, requireModulo, ROTINA_FLAGS_VALIDAS,
  requireRotina,
} = require('./middleware');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ambiente HOMOLOG: existe só onde há o arquivo-marcador `.homolog` (gitignored).
// Gateia a aba "Atualização na base de produção" (ferramenta interna do master p/
// acumular os comandos SQL a rodar manualmente na produção). Em produção o arquivo
// não existe → a aba nunca aparece, mesmo que o código chegue lá pelo git.
const IS_HOMOLOG = fs.existsSync(path.join(__dirname, '.homolog'));
const MIGRACOES_FILE = path.join(__dirname, 'migracoes-homolog.json');

// ── Auth helpers ──────────────────────────────────────────────────────────────
// (n / getCookie / getInatividadeMinutos / renovarSessao / SESSAO_SQL /
// requireAuth / resolverPerfilId / modulosDoUsuario / registrarLog / os gates
// de admin-rotina-módulo agora vêm de ./middleware — ver import no topo)

// Usado só por GET /api/admin/lixeira logo abaixo — definição "de verdade"
// já mora em routes/secop.js (junto de purgarLixeira); esta cópia é temporária,
// some quando a rota de lixeira for pra routes/admin.js no próximo passo.
function getLixeiraDias() {
  const row = db.prepare(`SELECT valor FROM config WHERE chave = 'lixeira_dias'`).get();
  const dias = parseInt(row?.valor, 10);
  return dias > 0 ? dias : 60;
}

// Protege todas as rotas /api/ exceto /api/auth/*
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  requireAuth(req, res, next);
});

// Somente leitura para o perfil "consulta" (CONSULTA_POST_OK vem de ./middleware)
app.use('/api', (req, res, next) => {
  if (!req.user || req.user.role !== 'consulta') return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (CONSULTA_POST_OK.some(re => re.test(req.path))) return next();
  return res.status(403).json({ error: 'Usuário de consulta: acesso somente leitura.' });
});

// requireAdminAny / requireAdminSistema vêm de ./middleware
app.use('/api/admin', requireAdminAny);

// requireModulo / requireRotina / ROTINA_FLAGS_VALIDAS vêm de ./middleware.
// O antigo gate do SECOP por lista de prefixos (SECOP_PREFIXOS) foi substituído
// pelo `requireModulo('secop')` explícito em cada rota de routes/secop.js.

// ── Endpoints de autenticação ─────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { username, senha } = req.body;
  if (!username || !senha) return res.status(400).json({ error: 'Dados incompletos' });

  const user = db.prepare("SELECT * FROM users WHERE username = ? AND ativo = 1").get(username);
  if (!user) return res.status(401).json({ error: 'Usuário ou senha inválidos' });

  const hash = crypto.pbkdf2Sync(senha, user.salt, 100000, 64, 'sha512').toString('hex');
  if (hash !== user.senha_hash) return res.status(401).json({ error: 'Usuário ou senha inválidos' });

  // Senha provisória (usuário recém-criado pelo admin, ou senha redefinida): cria
  // uma sessão sem módulo só pra permitir a troca e força trocar antes de entrar.
  if (user.senha_provisoria) {
    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + getInatividadeMinutos() * 60 * 1000).toISOString();
    db.prepare("INSERT INTO sessions (token, user_id, expires, modulo_ativo) VALUES (?, ?, ?, NULL)")
      .run(token, user.id, expires);
    registrarLog(req, 'AUTH', 'LOGIN', 'Login com senha provisória (troca obrigatória)', user.username, user.id);
    res.cookie('secop_sid', token, { httpOnly: true, sameSite: 'strict', maxAge: 24 * 60 * 60 * 1000 });
    return res.json({ ok: true, trocar_senha: true });
  }

  // Sem nenhum módulo liberado o usuário não entra — nem cria sessão. O admin
  // precisa conceder acesso na área de Módulos.
  const mods = modulosDoUsuario(user);
  if (!mods.length) {
    registrarLog(req, 'AUTH', 'BLOQUEADO', 'Login bloqueado: usuário sem módulo liberado', user.username, user.id);
    return res.status(403).json({ error: 'Você não tem nenhum módulo liberado. Procure o administrador do sistema.' });
  }

  // Um único módulo entra direto (já registra o módulo na sessão); vários (ou
  // master) escolhem antes de entrar — modulo_ativo fica NULL até a escolha.
  const escolher = mods.length > 1;
  const moduloInicial = escolher ? null : mods[0].slug;
  const perfilInicial = escolher ? null : resolverPerfilId(user.id, mods[0].id);

  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + getInatividadeMinutos() * 60 * 1000).toISOString();

  db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires < datetime('now')").run(user.id);
  db.prepare("INSERT INTO sessions (token, user_id, expires, modulo_ativo, perfil_id) VALUES (?, ?, ?, ?, ?)")
    .run(token, user.id, expires, moduloInicial, perfilInicial);

  registrarLog(req, 'AUTH', 'LOGIN', `Login realizado`, user.username, user.id);
  if (moduloInicial) registrarLog(req, 'MODULO', 'ENTROU', `Entrou no módulo "${mods[0].nome}"`, user.username, user.id);

  res.cookie('secop_sid', token, {
    // Cookie em si dura folgado — quem controla o timeout real é sessions.expires,
    // que rola a cada requisição autenticada (ver renovarSessao)
    httpOnly: true, sameSite: 'strict', maxAge: 24 * 60 * 60 * 1000
  });
  res.json({
    ok: true, username: user.username, role: user.role,
    escolher,
    home: escolher ? null : mods[0].home
  });
});

app.post('/api/auth/logout', (req, res) => {
  const token = getCookie(req, 'secop_sid');
  if (token) {
    const session = db.prepare(`
      SELECT s.user_id, u.username FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token = ?
    `).get(token);
    if (session) registrarLog(req, 'AUTH', 'LOGOUT', 'Logout realizado', session.username, session.user_id);
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }
  res.clearCookie('secop_sid');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = getCookie(req, 'secop_sid');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const session = db.prepare(SESSAO_SQL).get(token);
  if (!session) return res.status(401).json({ error: 'Não autenticado' });
  renovarSessao(token);
  let tem_foto = false;
  try { tem_foto = !!anexosDb.prepare(`SELECT 1 FROM user_foto WHERE user_id = ?`).get(session.user_id); } catch {}
  res.json({ ...session, id: session.user_id, tem_foto });
});

// Módulos que o usuário logado pode acessar + qual está ativo na sessão. Serve a
// tela de seleção de módulo e a montagem da sidebar (marca/accent) no auth.js.
// requireAuth explícito: rotas /api/auth/* são isentas do middleware global, mas
// estas precisam de req.user.
app.get('/api/auth/modulos', requireAuth, (req, res) => {
  const modulos = modulosDoUsuario(req.user);
  res.json({ modulos, modulo_ativo: req.user.modulo_ativo });
});

// Rotinas do módulo ATIVO na sessão + o que o Perfil do usuário libera em cada
// uma (ver/incluir/alterar/excluir). Usado pelo auth.js pra barrar/mostrar
// páginas de rotina dentro de um módulo (ex.: PAC Lançamento vs Gestão), um
// nível mais fundo que o módulo em si. Master e consulta veem tudo.
app.get('/api/auth/rotinas', requireAuth, (req, res) => {
  if (!req.user.modulo_ativo) return res.json({ rotinas: [] });
  const mod = db.prepare(`SELECT id FROM modulos WHERE slug = ?`).get(req.user.modulo_ativo);
  if (!mod) return res.json({ rotinas: [] });
  if (req.user.username === 'master' || req.user.role === 'consulta') {
    const rows = db.prepare(`SELECT slug, nome, ordem FROM rotinas WHERE modulo_id = ? AND ativo = 1 ORDER BY ordem`).all(mod.id);
    return res.json({ rotinas: rows.map(r => ({ ...r, ver: true, incluir: true, alterar: true, excluir: true })) });
  }
  const rows = db.prepare(`
    SELECT r.slug, r.nome, r.ordem,
           COALESCE(pr.ver, 0) AS ver, COALESCE(pr.incluir, 0) AS incluir,
           COALESCE(pr.alterar, 0) AS alterar, COALESCE(pr.excluir, 0) AS excluir
    FROM rotinas r LEFT JOIN perfil_rotinas pr ON pr.rotina_id = r.id AND pr.perfil_id = ?
    WHERE r.modulo_id = ? AND r.ativo = 1 ORDER BY r.ordem
  `).all(req.user.perfil_id, mod.id);
  res.json({ rotinas: rows });
});

// Registra o módulo escolhido na sessão. Valida que o usuário realmente tem
// acesso a ele (master pode qualquer módulo ativo).
app.post('/api/auth/selecionar-modulo', requireAuth, (req, res) => {
  const { slug } = req.body || {};
  if (!slug) return res.status(400).json({ error: 'Módulo não informado' });
  const permitido = modulosDoUsuario(req.user).find(m => m.slug === slug);
  if (!permitido) return res.status(403).json({ error: 'Você não tem acesso a este módulo' });
  const token = getCookie(req, 'secop_sid');
  const perfilId = resolverPerfilId(req.user.user_id, permitido.id);
  db.prepare(`UPDATE sessions SET modulo_ativo = ?, perfil_id = ? WHERE token = ?`).run(slug, perfilId, token);
  registrarLog(req, 'MODULO', 'ENTROU', `Entrou no módulo "${permitido.nome}"`);
  res.json({ ok: true, home: permitido.home });
});

// Reautenticação (step-up): confirma a senha do usuário JÁ logado antes de
// liberar o conteúdo de admin.html (Configurações/Lixeira) — não troca a
// sessão nem o cookie, só valida a senha de novo
app.post('/api/auth/confirmar-senha', (req, res) => {
  const token = getCookie(req, 'secop_sid');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const session = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires > datetime('now') AND u.ativo = 1
  `).get(token);
  if (!session) return res.status(401).json({ error: 'Não autenticado' });
  if (session.username !== 'master' && session.role !== 'admin_sistema' && session.role !== 'admin_operacional') {
    return res.status(403).json({ error: 'Acesso restrito' });
  }
  const { senha } = req.body;
  if (!senha) return res.status(400).json({ error: 'Informe a senha' });
  const hash = crypto.pbkdf2Sync(senha, session.salt, 100000, 64, 'sha512').toString('hex');
  if (hash !== session.senha_hash) return res.status(401).json({ error: 'Senha incorreta' });
  renovarSessao(token);
  res.json({ ok: true });
});

// Troca de senha provisória no 1º acesso (usuário JÁ logado com a sessão criada
// no login provisório). Ao trocar, limpa o flag senha_provisoria e o usuário
// segue pro fluxo normal (escolha de módulo / cadastro do SECAD).
app.post('/api/auth/trocar-senha', (req, res) => {
  const token = getCookie(req, 'secop_sid');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const session = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires > datetime('now') AND u.ativo = 1
  `).get(token);
  if (!session) return res.status(401).json({ error: 'Não autenticado' });

  const { senha_atual, nova_senha } = req.body || {};
  if (!nova_senha || String(nova_senha).length < 6) {
    return res.status(400).json({ error: 'A nova senha deve ter ao menos 6 caracteres.' });
  }
  // Se a senha atual for informada, confere (defesa a mais); não é obrigatória
  // porque o usuário acabou de autenticar com ela no login.
  if (senha_atual) {
    const hAtual = crypto.pbkdf2Sync(String(senha_atual), session.salt, 100000, 64, 'sha512').toString('hex');
    if (hAtual !== session.senha_hash) return res.status(401).json({ error: 'Senha atual incorreta.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(nova_senha), salt, 100000, 64, 'sha512').toString('hex');
  db.prepare("UPDATE users SET senha_hash = ?, salt = ?, senha_provisoria = 0 WHERE id = ?").run(hash, salt, session.id);
  renovarSessao(token);
  registrarLog(req, 'AUTH', 'SENHA', 'Trocou a senha provisória no 1º acesso', session.username, session.id);
  res.json({ ok: true });
});


// ── Lixeira (Configurações → Lixeira, restrito por requireAdminAny) ───────────

app.get('/api/admin/lixeira', (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.numero_processo, p.objeto, p.excluido_em, u.username AS criado_por_username,
      CAST(julianday(excluido_em, '+' || ? || ' days') - julianday('now') AS INTEGER) AS dias_restantes
    FROM processos p
    LEFT JOIN users u ON u.id = p.criado_por_id
    WHERE p.excluido_em IS NOT NULL
    ORDER BY p.excluido_em DESC
  `).all(getLixeiraDias());
  res.json(rows);
});

app.post('/api/admin/lixeira/:id/restaurar', (req, res) => {
  const proc = db.prepare(`SELECT numero_processo, objeto FROM processos WHERE id = ? AND excluido_em IS NOT NULL`).get(req.params.id);
  if (!proc) return res.status(404).json({ error: 'Não encontrado na lixeira' });
  db.prepare(`UPDATE processos SET excluido_em = NULL WHERE id = ?`).run(req.params.id);
  registrarLog(req, 'PROCESSO', 'RESTAUROU', `Restaurou processo ${proc.numero_processo}: ${proc.objeto} da lixeira`);
  res.json({ ok: true });
});

// ── SECAD: concessionários removidos da listagem (soft-remove, sem DELETE) ────
// O registro em ClienteConcessionario/AvaliacaoAreaRenovacao nunca é apagado —
// só marcado aqui (secop.db, ligado por `codigo`) e ignorado por
// dashboard/listagem/comunicados (ver codigosRemovidos() em routes/secad.js).

app.get('/api/admin/concessionarios-removidos', (req, res) => {
  const rows = db.prepare(`
    SELECT r.codigo, r.motivo, r.removido_em, u.username AS removido_por_username
    FROM concessionario_removido r
    LEFT JOIN users u ON u.id = r.removido_por
    ORDER BY r.removido_em DESC
  `).all();
  const clientes = new Map(depopDb.prepare(`SELECT codigo, cliente FROM ClienteConcessionario`).all().map(c => [c.codigo, c.cliente]));
  res.json(rows.map(r => ({ ...r, cliente: clientes.get(r.codigo) || null })));
});

app.post('/api/admin/concessionarios-removidos', (req, res) => {
  const codigo = parseInt(req.body.codigo, 10);
  if (!codigo) return res.status(400).json({ error: 'Informe o código do concessionário.' });
  const cliente = depopDb.prepare(`SELECT codigo, cliente FROM ClienteConcessionario WHERE codigo = ?`).get(codigo);
  if (!cliente) return res.status(404).json({ error: 'Código não encontrado em ClienteConcessionario.' });
  db.prepare(`
    INSERT INTO concessionario_removido (codigo, motivo, removido_por) VALUES (?, ?, ?)
    ON CONFLICT(codigo) DO UPDATE SET motivo = excluded.motivo, removido_em = datetime('now'), removido_por = excluded.removido_por
  `).run(codigo, req.body.motivo || null, req.user.user_id);
  registrarLog(req, 'SECAD', 'CONCESSIONARIO_REMOVEU', `Removeu concessionário ${codigo} (${cliente.cliente}) da listagem`);
  res.json({ ok: true });
});

app.post('/api/admin/concessionarios-removidos/:codigo/restaurar', (req, res) => {
  const codigo = parseInt(req.params.codigo, 10);
  const row = db.prepare(`SELECT codigo FROM concessionario_removido WHERE codigo = ?`).get(codigo);
  if (!row) return res.status(404).json({ error: 'Não está removido.' });
  db.prepare(`DELETE FROM concessionario_removido WHERE codigo = ?`).run(codigo);
  registrarLog(req, 'SECAD', 'CONCESSIONARIO_RESTAUROU', `Restaurou concessionário ${codigo} na listagem`);
  res.json({ ok: true });
});



// ── Configurações (parâmetros do sistema) ─────────────────────────────────────

// Chaves de config que NUNCA podem ir pro frontend (segredos). Este endpoint é
// consumido por qualquer usuário logado (auth.js), então segredos ficam de fora.
const CONFIG_SECRETA = new Set(['cpfhub_api_key']);

app.get('/api/config', (req, res) => {
  const rows = db.prepare(`SELECT chave, valor FROM config`).all();
  const cfg = {};
  rows.forEach(r => { if (!CONFIG_SECRETA.has(r.chave)) cfg[r.chave] = r.valor; });
  res.json(cfg);
});

app.put('/api/admin/config', (req, res) => {
  const entries = Object.entries(req.body || {});
  if (!entries.length) return res.status(400).json({ error: 'Nenhum parâmetro informado' });
  const upsert = db.prepare(`INSERT INTO config (chave, valor) VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`);
  entries.forEach(([chave, valor]) => upsert.run(chave, String(valor)));
  // Redige segredos (ex.: cpfhub_api_key) no log — nunca gravar o valor em claro.
  const resumo = entries.map(([c, v]) => `${c}=${CONFIG_SECRETA.has(c) ? '***' : v}`).join(', ');
  registrarLog(req, 'CONFIG', 'ALTEROU', `Parâmetros atualizados: ${resumo}`);
  res.json({ ok: true });
});


// ── Tipos de contratação ─────────────────────────────────────────────────────

app.get('/api/tipos-contratacao', (req, res) => {
  res.json(db.prepare(`SELECT * FROM tipos_contratacao ORDER BY ordem`).all());
});

app.post('/api/tipos-contratacao', requireAdminSistema, (req, res) => {
  const { nome, ordem } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  try {
    const info = db.prepare(`INSERT INTO tipos_contratacao (nome, ordem) VALUES (?, ?)`).run(nome, n(ordem) ?? 0);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Tipo já existe' });
  }
});

app.put('/api/tipos-contratacao/:id', requireAdminSistema, (req, res) => {
  const { nome, ordem } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  db.prepare(`UPDATE tipos_contratacao SET nome=?, ordem=? WHERE id=?`).run(nome, n(ordem) ?? 0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/tipos-contratacao/:id', requireAdminSistema, (req, res) => {
  db.prepare(`DELETE FROM tipos_contratacao WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Tipos de itens extras (unidade + descrição sempre amarrados) ──────────────

app.get('/api/tipos-extra', (req, res) => {
  res.json(db.prepare(`SELECT * FROM tipos_extra ORDER BY ordem`).all());
});

app.post('/api/tipos-extra', requireAdminSistema, (req, res) => {
  const { unidade, descricao, ordem, sinal, tipo_valor, conta_no_total } = req.body;
  if (!unidade || !descricao) return res.status(400).json({ error: 'Unidade e descrição são obrigatórias' });
  const sinalVal = sinal === 'negativo' ? 'negativo' : 'positivo';
  const tipoValorVal = tipo_valor === 'percentual' ? 'percentual' : 'fixo';
  const contaNoTotalVal = conta_no_total === false || conta_no_total === 0 || conta_no_total === '0' ? 0 : 1;
  try {
    const info = db.prepare(`INSERT INTO tipos_extra (unidade, descricao, ordem, sinal, tipo_valor, conta_no_total) VALUES (?, ?, ?, ?, ?, ?)`).run(unidade, descricao, n(ordem) ?? 0, sinalVal, tipoValorVal, contaNoTotalVal);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Unidade já existe' });
  }
});

app.put('/api/tipos-extra/:id', requireAdminSistema, (req, res) => {
  const { unidade, descricao, ordem, sinal, tipo_valor, conta_no_total } = req.body;
  if (!unidade || !descricao) return res.status(400).json({ error: 'Unidade e descrição são obrigatórias' });
  const sinalVal = sinal === 'negativo' ? 'negativo' : 'positivo';
  const tipoValorVal = tipo_valor === 'percentual' ? 'percentual' : 'fixo';
  const contaNoTotalVal = conta_no_total === false || conta_no_total === 0 || conta_no_total === '0' ? 0 : 1;
  db.prepare(`UPDATE tipos_extra SET unidade=?, descricao=?, ordem=?, sinal=?, tipo_valor=?, conta_no_total=? WHERE id=?`).run(unidade, descricao, n(ordem) ?? 0, sinalVal, tipoValorVal, contaNoTotalVal, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/tipos-extra/:id', requireAdminSistema, (req, res) => {
  db.prepare(`DELETE FROM tipos_extra WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});


// ── Admin: usuários ───────────────────────────────────────────────────────────

app.get('/api/admin/users', (req, res) => {
  const souOperacional = req.user.role === 'admin_operacional' && req.user.username !== 'master';
  const base = `
    SELECT u.id, u.username, u.email, u.nome_completo, u.telefone, u.role, u.ativo,
           u.acesso_avancado, u.senha_provisoria, u.criado_em, u.departamento_id,
           dep.nome AS departamento_nome
    FROM users u LEFT JOIN departamentos dep ON dep.id = u.departamento_id
    WHERE u.username != 'master'`;
  const rows = souOperacional
    ? db.prepare(`${base} AND u.departamento_id = ? ORDER BY u.id`).all(req.user.departamento_id)
    : db.prepare(`${base} ORDER BY u.id`).all();
  res.json(rows);
});

app.post('/api/admin/users', (req, res) => {
  const { username, senha, email, role, acesso_avancado, nome_completo, telefone } = req.body;
  if (!username || !senha) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });

  let roleFinal = role || 'usuario';
  let deptFinal = req.body.departamento_id != null ? Number(req.body.departamento_id) : null;
  const souOperacional = req.user.role === 'admin_operacional' && req.user.username !== 'master';
  if (souOperacional) {
    // Escopo restrito: nunca cria administrador de nenhum tipo, e o usuário
    // criado sempre nasce no MESMO departamento de quem está criando.
    if (['admin_sistema', 'admin_operacional'].includes(roleFinal)) {
      return res.status(403).json({ error: 'Você não pode criar administradores.' });
    }
    deptFinal = req.user.departamento_id;
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(senha, salt, 100000, 64, 'sha512').toString('hex');
  const acessoVal = acesso_avancado ? 1 : 0;
  try {
    // senha_provisoria = 1: o admin define uma senha inicial e o usuário é
    // obrigado a trocá-la no 1º login.
    const info = db.prepare(
      "INSERT INTO users (username, senha_hash, salt, role, ativo, acesso_avancado, email, senha_provisoria, nome_completo, telefone, departamento_id) VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, ?, ?)"
    ).run(username, hash, salt, roleFinal, acessoVal, email ? String(email).trim() : null,
          nome_completo ? String(nome_completo).trim() : null, telefone ? String(telefone).trim() : null, deptFinal);
    registrarLog(req, 'USUARIO', 'CRIOU', `Criou usuário "${username}"`);
    // Acesso padrão ao SECOP (com o perfil "Acesso Total") pro novo usuário não
    // nascer bloqueado nem sem permissão de escrita — o admin ajusta depois.
    try {
      const secop = db.prepare(`SELECT id FROM modulos WHERE slug = 'secop'`).get();
      if (secop) {
        const perfilPadrao = db.prepare(`SELECT id FROM perfis WHERE modulo_id = ? AND nome = 'Acesso Total'`).get(secop.id);
        db.prepare(`INSERT OR IGNORE INTO user_modulos (user_id, modulo_id, perfil_id) VALUES (?, ?, ?)`)
          .run(info.lastInsertRowid, secop.id, perfilPadrao ? perfilPadrao.id : null);
      }
    } catch {}
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Usuário já existe' });
  }
});

app.patch('/api/admin/users/:id', (req, res) => {
  const { ativo, senha, email, role, acesso_avancado, nome_completo, telefone, departamento_id } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Não encontrado' });

  const souOperacional = req.user.role === 'admin_operacional' && req.user.username !== 'master';
  if (souOperacional && user.departamento_id !== req.user.departamento_id) {
    return res.status(403).json({ error: 'Este usuário não pertence ao seu departamento.' });
  }

  if (email !== undefined) {
    db.prepare("UPDATE users SET email = ? WHERE id = ?").run(email ? String(email).trim() : null, req.params.id);
    registrarLog(req, 'USUARIO', 'EMAIL', `Alterou o email do usuário "${user.username}"`);
  }
  if (nome_completo !== undefined) {
    db.prepare("UPDATE users SET nome_completo = ? WHERE id = ?").run(nome_completo ? String(nome_completo).trim() : null, req.params.id);
    registrarLog(req, 'USUARIO', 'PERFIL_USUARIO', `Alterou o nome completo de "${user.username}"`);
  }
  if (telefone !== undefined) {
    db.prepare("UPDATE users SET telefone = ? WHERE id = ?").run(telefone ? String(telefone).trim() : null, req.params.id);
    registrarLog(req, 'USUARIO', 'PERFIL_USUARIO', `Alterou o telefone de "${user.username}"`);
  }
  if (departamento_id !== undefined) {
    if (souOperacional) return res.status(403).json({ error: 'Você não pode alterar o departamento de um usuário.' });
    db.prepare("UPDATE users SET departamento_id = ? WHERE id = ?").run(departamento_id || null, req.params.id);
    registrarLog(req, 'USUARIO', 'DEPARTAMENTO', `Alterou o departamento do usuário "${user.username}"`);
  }
  if (ativo !== undefined) {
    if (user.username === 'master') return res.status(400).json({ error: 'Não é possível desativar o master' });
    db.prepare("UPDATE users SET ativo = ? WHERE id = ?").run(ativo ? 1 : 0, req.params.id);
    registrarLog(req, 'USUARIO', ativo ? 'ATIVOU' : 'DESATIVOU', `${ativo ? 'Ativou' : 'Desativou'} usuário "${user.username}"`);
  }
  if (senha) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(senha, salt, 100000, 64, 'sha512').toString('hex');
    // Redefinir a senha pelo admin também vira provisória: força o usuário a
    // trocá-la no próximo login.
    db.prepare("UPDATE users SET senha_hash = ?, salt = ?, senha_provisoria = 1 WHERE id = ?").run(hash, salt, req.params.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(req.params.id);
    registrarLog(req, 'USUARIO', 'SENHA', `Alterou senha do usuário "${user.username}" (provisória)`);
  }
  if (role !== undefined) {
    if (user.username === 'master') return res.status(400).json({ error: 'Não é possível alterar o perfil do master' });
    if (souOperacional) return res.status(403).json({ error: 'Você não pode alterar o nível de acesso de um usuário.' });
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, req.params.id);
    registrarLog(req, 'USUARIO', 'PERFIL', `Alterou perfil do usuário "${user.username}" para "${role}"`);
  }
  if (acesso_avancado !== undefined) {
    if (user.username === 'master') return res.status(400).json({ error: 'O master já tem acesso completo' });
    db.prepare("UPDATE users SET acesso_avancado = ? WHERE id = ?").run(acesso_avancado ? 1 : 0, req.params.id);
    registrarLog(req, 'USUARIO', 'ACESSO_AVANCADO', `${acesso_avancado ? 'Concedeu' : 'Revogou'} acesso avançado (Configurações/Lixeira) a "${user.username}"`);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', (req, res) => {
  const user = db.prepare("SELECT username, departamento_id FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Não encontrado' });
  if (user.username === 'master') return res.status(400).json({ error: 'Não é possível excluir o master' });
  if (req.user.role === 'admin_operacional' && req.user.username !== 'master' && user.departamento_id !== req.user.departamento_id) {
    return res.status(403).json({ error: 'Este usuário não pertence ao seu departamento.' });
  }
  // As cotações do usuário excluído permanecem no sistema, apenas ficam sem dono (só admin edita)
  db.prepare("UPDATE processos SET criado_por_id = NULL WHERE criado_por_id = ?").run(req.params.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  registrarLog(req, 'USUARIO', 'EXCLUIU', `Excluiu usuário "${user.username}"`);
  res.json({ ok: true });
});

// ── Admin: foto de perfil do usuário (BLOB em anexos.db — mesmo mecanismo do
// comprovante de entrega do SECAD; não existe upload-pra-disco neste projeto) ──
const FOTO_MIMES = ['image/jpeg', 'image/png'];
const FOTO_MAX = 3 * 1024 * 1024;
app.post('/api/admin/users/:id/foto', express.raw({ type: '*/*', limit: '4mb' }), (req, res) => {
  const user = db.prepare(`SELECT username, departamento_id FROM users WHERE id = ?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (req.user.role === 'admin_operacional' && req.user.username !== 'master' && user.departamento_id !== req.user.departamento_id) {
    return res.status(403).json({ error: 'Este usuário não pertence ao seu departamento.' });
  }
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Arquivo vazio.' });
  if (!FOTO_MIMES.includes(mime)) return res.status(415).json({ error: 'Envie uma imagem JPG ou PNG.' });
  if (req.body.length > FOTO_MAX) return res.status(413).json({ error: 'Imagem muito grande (máx. 3 MB).' });
  anexosDb.prepare(`
    INSERT INTO user_foto (user_id, mime, tamanho, conteudo, atualizado_em) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, tamanho = excluded.tamanho, conteudo = excluded.conteudo, atualizado_em = excluded.atualizado_em
  `).run(req.params.id, mime, req.body.length, req.body);
  registrarLog(req, 'USUARIO', 'FOTO', `Atualizou a foto de "${user.username}"`);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id/foto', (req, res) => {
  const user = db.prepare(`SELECT username, departamento_id FROM users WHERE id = ?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (req.user.role === 'admin_operacional' && req.user.username !== 'master' && user.departamento_id !== req.user.departamento_id) {
    return res.status(403).json({ error: 'Este usuário não pertence ao seu departamento.' });
  }
  anexosDb.prepare(`DELETE FROM user_foto WHERE user_id = ?`).run(req.params.id);
  registrarLog(req, 'USUARIO', 'FOTO', `Removeu a foto de "${user.username}"`);
  res.json({ ok: true });
});

// ── Admin: departamentos (só admin_sistema) ───────────────────────────────────

app.get('/api/admin/departamentos', requireAdminSistema, (req, res) => {
  res.json(db.prepare(`SELECT id, slug, nome, ordem, ativo FROM departamentos ORDER BY ordem`).all());
});

app.patch('/api/admin/departamentos/:id', requireAdminSistema, (req, res) => {
  const { nome, ativo } = req.body;
  const dep = db.prepare(`SELECT nome FROM departamentos WHERE id = ?`).get(req.params.id);
  if (!dep) return res.status(404).json({ error: 'Departamento não encontrado' });
  if (nome !== undefined) db.prepare(`UPDATE departamentos SET nome = ? WHERE id = ?`).run(String(nome).trim(), req.params.id);
  if (ativo !== undefined) db.prepare(`UPDATE departamentos SET ativo = ? WHERE id = ?`).run(ativo ? 1 : 0, req.params.id);
  registrarLog(req, 'DEPARTAMENTO', 'EDITOU', `Editou o departamento "${dep.nome}"`);
  res.json({ ok: true });
});

// ── Admin: rotinas (catálogo semeado — só ativo/flags_aplicaveis são editáveis,
// não dá pra criar/excluir rotina pelo admin) ─────────────────────────────────

app.get('/api/admin/rotinas', requireAdminSistema, (req, res) => {
  res.json(db.prepare(`
    SELECT r.id, r.modulo_id, m.nome AS modulo_nome, r.slug, r.nome, r.ordem, r.ativo, r.flags_aplicaveis
    FROM rotinas r JOIN modulos m ON m.id = r.modulo_id
    ORDER BY m.ordem, r.ordem`).all());
});

app.patch('/api/admin/rotinas/:id', requireAdminSistema, (req, res) => {
  const { ativo, flags_aplicaveis } = req.body;
  const rot = db.prepare(`SELECT nome FROM rotinas WHERE id = ?`).get(req.params.id);
  if (!rot) return res.status(404).json({ error: 'Rotina não encontrada' });
  if (ativo !== undefined) db.prepare(`UPDATE rotinas SET ativo = ? WHERE id = ?`).run(ativo ? 1 : 0, req.params.id);
  if (flags_aplicaveis !== undefined) db.prepare(`UPDATE rotinas SET flags_aplicaveis = ? WHERE id = ?`).run(String(flags_aplicaveis), req.params.id);
  registrarLog(req, 'PERFIL', 'ROTINA_EDITOU', `Editou a rotina "${rot.nome}"`);
  res.json({ ok: true });
});

// ── Admin: perfis (CRUD só admin_sistema; leitura liberada pro admin_operacional
// também — ele precisa VER quais perfis existem pra atribuir um já pronto) ────

app.get('/api/admin/perfis', (req, res) => {
  const { modulo_id } = req.query;
  const rows = modulo_id
    ? db.prepare(`SELECT id, modulo_id, nome, descricao FROM perfis WHERE modulo_id = ? ORDER BY nome`).all(modulo_id)
    : db.prepare(`SELECT id, modulo_id, nome, descricao FROM perfis ORDER BY modulo_id, nome`).all();
  res.json(rows);
});

app.post('/api/admin/perfis', requireAdminSistema, (req, res) => {
  const { modulo_id, nome, descricao } = req.body;
  if (!modulo_id || !nome) return res.status(400).json({ error: 'Módulo e nome são obrigatórios' });
  try {
    const info = db.prepare(`INSERT INTO perfis (modulo_id, nome, descricao) VALUES (?, ?, ?)`)
      .run(modulo_id, String(nome).trim(), descricao ? String(descricao).trim() : null);
    registrarLog(req, 'PERFIL', 'CRIOU', `Criou o perfil "${nome}"`);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch {
    res.status(400).json({ error: 'Já existe um perfil com esse nome neste módulo' });
  }
});

app.patch('/api/admin/perfis/:id', requireAdminSistema, (req, res) => {
  const { nome, descricao } = req.body;
  const perfil = db.prepare(`SELECT nome FROM perfis WHERE id = ?`).get(req.params.id);
  if (!perfil) return res.status(404).json({ error: 'Perfil não encontrado' });
  if (nome !== undefined) db.prepare(`UPDATE perfis SET nome = ? WHERE id = ?`).run(String(nome).trim(), req.params.id);
  if (descricao !== undefined) db.prepare(`UPDATE perfis SET descricao = ? WHERE id = ?`).run(descricao ? String(descricao).trim() : null, req.params.id);
  registrarLog(req, 'PERFIL', 'EDITOU', `Editou o perfil "${perfil.nome}"`);
  res.json({ ok: true });
});

app.delete('/api/admin/perfis/:id', requireAdminSistema, (req, res) => {
  const perfil = db.prepare(`SELECT nome FROM perfis WHERE id = ?`).get(req.params.id);
  if (!perfil) return res.status(404).json({ error: 'Perfil não encontrado' });
  try {
    db.prepare(`DELETE FROM perfis WHERE id = ?`).run(req.params.id);
    registrarLog(req, 'PERFIL', 'EXCLUIU', `Excluiu o perfil "${perfil.nome}"`);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Este perfil está em uso por um ou mais usuários — remova as atribuições antes de excluir.' });
  }
});

// Grid ver/incluir/alterar/excluir de um perfil — leitura liberada pro
// admin_operacional (ele precisa ver o que cada perfil concede antes de
// atribuir), escrita só admin_sistema.
app.get('/api/admin/perfis/:id/rotinas', (req, res) => {
  const perfil = db.prepare(`SELECT id, modulo_id FROM perfis WHERE id = ?`).get(req.params.id);
  if (!perfil) return res.status(404).json({ error: 'Perfil não encontrado' });
  const rows = db.prepare(`
    SELECT r.id, r.slug, r.nome, r.flags_aplicaveis,
           COALESCE(pr.ver, 0) AS ver, COALESCE(pr.incluir, 0) AS incluir,
           COALESCE(pr.alterar, 0) AS alterar, COALESCE(pr.excluir, 0) AS excluir
    FROM rotinas r LEFT JOIN perfil_rotinas pr ON pr.rotina_id = r.id AND pr.perfil_id = ?
    WHERE r.modulo_id = ? AND r.ativo = 1 ORDER BY r.ordem
  `).all(req.params.id, perfil.modulo_id);
  res.json(rows);
});

app.put('/api/admin/perfis/:id/rotinas', requireAdminSistema, (req, res) => {
  const { rotina_id, flag, valor } = req.body || {};
  if (!ROTINA_FLAGS_VALIDAS.has(flag)) return res.status(400).json({ error: 'Flag inválida' });
  const perfil = db.prepare(`SELECT id FROM perfis WHERE id = ?`).get(req.params.id);
  const rotina = db.prepare(`SELECT id, nome FROM rotinas WHERE id = ?`).get(rotina_id);
  if (!perfil || !rotina) return res.status(404).json({ error: 'Perfil ou rotina não encontrados' });
  db.prepare(`
    INSERT INTO perfil_rotinas (perfil_id, rotina_id, ${flag}) VALUES (?, ?, ?)
    ON CONFLICT(perfil_id, rotina_id) DO UPDATE SET ${flag} = excluded.${flag}
  `).run(req.params.id, rotina_id, valor ? 1 : 0);
  registrarLog(req, 'PERFIL', 'ROTINA_FLAG', `Ajustou "${flag}" da rotina "${rotina.nome}" no perfil #${req.params.id}`);
  res.json({ ok: true });
});

// ── Admin: módulos (catálogo, só admin_sistema + matriz de acesso por usuário,
// leitura/escrita liberada pro admin_operacional dentro do próprio departamento) ─

app.get('/api/admin/modulos', requireAdminSistema, (req, res) => {
  res.json(db.prepare(`SELECT id, slug, nome, cor, home, ordem, ativo, departamento_id FROM modulos ORDER BY ordem`).all());
});

// Matriz para a aba Módulos: todos os módulos + cada usuário (exceto master, que
// já enxerga tudo) com o perfil que possui em cada um. admin_operacional só
// enxerga/mexe no que é do próprio departamento.
app.get('/api/admin/modulos/acessos', (req, res) => {
  const souOperacional = req.user.role === 'admin_operacional' && req.user.username !== 'master';
  const modulos = souOperacional
    ? db.prepare(`SELECT id, slug, nome, cor, ativo, departamento_id FROM modulos WHERE departamento_id = ? ORDER BY ordem`).all(req.user.departamento_id)
    : db.prepare(`SELECT id, slug, nome, cor, ativo, departamento_id FROM modulos ORDER BY ordem`).all();
  const usuarios = souOperacional
    ? db.prepare(`SELECT id, username, role FROM users WHERE username != 'master' AND departamento_id = ? ORDER BY id`).all(req.user.departamento_id)
    : db.prepare(`SELECT id, username, role FROM users WHERE username != 'master' ORDER BY id`).all();
  const pares   = db.prepare(`SELECT user_id, modulo_id, perfil_id FROM user_modulos`).all();
  const porUser = {};
  pares.forEach(p => { (porUser[p.user_id] = porUser[p.user_id] || {})[p.modulo_id] = p.perfil_id; });
  usuarios.forEach(u => {
    u.modulo_perfis = porUser[u.id] || {};
    u.modulo_ids = Object.keys(u.modulo_perfis).map(Number);
  });
  const perfis = db.prepare(`SELECT id, modulo_id, nome FROM perfis ORDER BY modulo_id, nome`).all();
  res.json({ modulos, usuarios, perfis });
});

app.put('/api/admin/modulos/acessos', (req, res) => {
  const { user_id, modulo_id, concedido } = req.body || {};
  if (user_id == null || modulo_id == null) return res.status(400).json({ error: 'Dados incompletos' });
  const user   = db.prepare(`SELECT username, departamento_id FROM users WHERE id = ?`).get(user_id);
  const modulo = db.prepare(`SELECT nome, departamento_id FROM modulos WHERE id = ?`).get(modulo_id);
  if (!user || !modulo) return res.status(404).json({ error: 'Usuário ou módulo não encontrado' });
  if (user.username === 'master') return res.status(400).json({ error: 'O master já acessa todos os módulos' });
  if (req.user.role === 'admin_operacional' && req.user.username !== 'master' &&
      (user.departamento_id !== req.user.departamento_id || modulo.departamento_id !== req.user.departamento_id)) {
    return res.status(403).json({ error: 'Fora do seu departamento.' });
  }
  if (concedido) {
    db.prepare(`INSERT OR IGNORE INTO user_modulos (user_id, modulo_id) VALUES (?, ?)`).run(user_id, modulo_id);
    registrarLog(req, 'MODULO', 'CONCEDEU', `Concedeu o módulo "${modulo.nome}" a "${user.username}"`);
  } else {
    db.prepare(`DELETE FROM user_modulos WHERE user_id = ? AND modulo_id = ?`).run(user_id, modulo_id);
    registrarLog(req, 'MODULO', 'REVOGOU', `Revogou o módulo "${modulo.nome}" de "${user.username}"`);
  }
  res.json({ ok: true });
});

// Atribui/troca o perfil de um usuário num módulo que ele já tem (não concede o
// módulo em si, isso é o PUT acima). admin_operacional só escolhe entre perfis
// JÁ EXISTENTES daquele módulo — nunca cria perfil na hora.
app.patch('/api/admin/modulos/acessos', (req, res) => {
  const { user_id, modulo_id, perfil_id } = req.body || {};
  if (user_id == null || modulo_id == null) return res.status(400).json({ error: 'Dados incompletos' });
  const user   = db.prepare(`SELECT username, departamento_id FROM users WHERE id = ?`).get(user_id);
  const modulo = db.prepare(`SELECT nome, departamento_id FROM modulos WHERE id = ?`).get(modulo_id);
  if (!user || !modulo) return res.status(404).json({ error: 'Usuário ou módulo não encontrado' });
  if (user.username === 'master') return res.status(400).json({ error: 'O master já acessa tudo' });
  if (req.user.role === 'admin_operacional' && req.user.username !== 'master' &&
      (user.departamento_id !== req.user.departamento_id || modulo.departamento_id !== req.user.departamento_id)) {
    return res.status(403).json({ error: 'Fora do seu departamento.' });
  }
  if (perfil_id != null) {
    const perfil = db.prepare(`SELECT id FROM perfis WHERE id = ? AND modulo_id = ?`).get(perfil_id, modulo_id);
    if (!perfil) return res.status(400).json({ error: 'Perfil não pertence a este módulo.' });
  }
  const info = db.prepare(`UPDATE user_modulos SET perfil_id = ? WHERE user_id = ? AND modulo_id = ?`).run(perfil_id || null, user_id, modulo_id);
  if (info.changes === 0) return res.status(404).json({ error: 'Este usuário ainda não tem esse módulo — conceda o módulo primeiro.' });
  registrarLog(req, 'MODULO', 'PERFIL', `Definiu o perfil de "${user.username}" em "${modulo.nome}"`);
  res.json({ ok: true });
});

// Precisa vir DEPOIS das rotas /api/admin/modulos/acessos acima — Express casa
// rotas na ordem de registro, e ":id" bateria com o literal "acessos" primeiro
// (era exatamente esse bug: PATCH /modulos/acessos caía aqui, buscava um módulo
// de id="acessos", não achava, e devolvia "Módulo não encontrado").
app.patch('/api/admin/modulos/:id', requireAdminSistema, (req, res) => {
  const { ativo, departamento_id } = req.body;
  const modulo = db.prepare(`SELECT nome FROM modulos WHERE id = ?`).get(req.params.id);
  if (!modulo) return res.status(404).json({ error: 'Módulo não encontrado' });
  if (ativo !== undefined) {
    db.prepare(`UPDATE modulos SET ativo = ? WHERE id = ?`).run(ativo ? 1 : 0, req.params.id);
    registrarLog(req, 'MODULO', ativo ? 'ATIVOU' : 'DESATIVOU', `${ativo ? 'Ativou' : 'Desativou'} o módulo "${modulo.nome}"`);
  }
  if (departamento_id !== undefined) {
    db.prepare(`UPDATE modulos SET departamento_id = ? WHERE id = ?`).run(departamento_id || null, req.params.id);
    registrarLog(req, 'MODULO', 'DEPARTAMENTO', `Alterou o departamento do módulo "${modulo.nome}"`);
  }
  res.json({ ok: true });
});

// Qualquer usuário autenticado pode ver a foto de outro (é só avatar de
// sidebar, não é dado sensível) — mesmo padrão de exposição do comprovante.
app.get('/api/usuarios/:id/foto', (req, res) => {
  const row = anexosDb.prepare(`SELECT mime, conteudo FROM user_foto WHERE user_id = ?`).get(req.params.id);
  if (!row) return res.status(404).end();
  res.set('Content-Type', row.mime);
  res.set('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(row.conteudo));
});

// ── Admin: export / import banco ─────────────────────────────────────────────

app.get('/api/admin/export-db', (req, res) => {
  registrarLog(req, 'BANCO', 'EXPORTOU', 'Exportou banco de dados');
  try { db.exec('PRAGMA wal_checkpoint(FULL)'); } catch {}
  res.download(path.join(__dirname, 'data', 'secop.db'), 'secop.db');
});

app.post('/api/admin/import-db',
  express.raw({ type: 'application/octet-stream', limit: '100mb' }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      return res.status(400).json({ error: 'Arquivo inválido' });

    registrarLog(req, 'BANCO', 'IMPORTOU', 'Importou banco de dados');

    const dbPath = path.join(__dirname, 'data', 'secop.db');
    try { db.close(); } catch {}
    fs.writeFileSync(dbPath, req.body);
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    setupDb();

    res.json({ ok: true });
  }
);

// ── Admin: export / import da base do Depop (arquivo separado depop.db) ───────
// Mesma mecânica do secop.db, mas no arquivo depop.db — é por aqui que a base de
// renovações vai do dev pra produção sem tocar no secop.db.

app.get('/api/admin/export-depop-db', (req, res) => {
  if (!fs.existsSync(depopFilePath)) {
    return res.status(404).json({ error: 'Base do Depop ainda não existe. Gere-a com o conversor primeiro.' });
  }
  registrarLog(req, 'DEPOP', 'EXPORTOU', 'Exportou a base de dados do Depop');
  try { depopDb.exec('PRAGMA wal_checkpoint(FULL)'); } catch {}
  res.download(depopFilePath, 'depop.db');
});

app.post('/api/admin/import-depop-db',
  express.raw({ type: 'application/octet-stream', limit: '100mb' }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      return res.status(400).json({ error: 'Arquivo inválido' });

    registrarLog(req, 'DEPOP', 'IMPORTOU', 'Importou a base de dados do Depop');

    try { depopDb.close(); } catch {}
    fs.writeFileSync(depopFilePath, req.body);
    try { fs.unlinkSync(depopFilePath + '-shm'); } catch {}
    try { fs.unlinkSync(depopFilePath + '-wal'); } catch {}
    setupDepop();

    res.json({ ok: true });
  }
);

// ── Admin: export / import dos anexos (arquivo separado anexos.db) ────────────
// Comprovantes de entrega dos comunicados (BLOBs). Mesma mecânica do depop.db.
// O import roda setupAnexos() de novo → garante a tabela em cima do arquivo novo.

app.get('/api/admin/export-anexos-db', (req, res) => {
  if (!fs.existsSync(anexosFilePath)) return res.status(404).json({ error: 'Ainda não há anexos.' });
  registrarLog(req, 'DEPOP', 'EXPORTOU', 'Exportou os anexos (comprovantes)');
  try { anexosDb.exec('PRAGMA wal_checkpoint(FULL)'); } catch {}
  res.download(anexosFilePath, 'anexos.db');
});

app.post('/api/admin/import-anexos-db',
  express.raw({ type: 'application/octet-stream', limit: '200mb' }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      return res.status(400).json({ error: 'Arquivo inválido' });

    registrarLog(req, 'DEPOP', 'IMPORTOU', 'Importou os anexos (comprovantes)');

    try { anexosDb.close(); } catch {}
    fs.writeFileSync(anexosFilePath, req.body);
    try { fs.unlinkSync(anexosFilePath + '-shm'); } catch {}
    try { fs.unlinkSync(anexosFilePath + '-wal'); } catch {}
    setupAnexos();

    res.json({ ok: true });
  }
);

// ── Admin: logs ───────────────────────────────────────────────────────────────

app.get('/api/admin/logs', (req, res) => {
  const { data_de, data_ate, username, tipo } = req.query;
  let sql = `SELECT * FROM logs WHERE 1=1`;
  const params = [];
  if (data_de)  { sql += ` AND date(criado_em) >= ?`; params.push(data_de); }
  if (data_ate) { sql += ` AND date(criado_em) <= ?`; params.push(data_ate); }
  if (username) { sql += ` AND username = ?`; params.push(username); }
  if (tipo)     { sql += ` AND tipo = ?`; params.push(tipo); }
  sql += ` ORDER BY id DESC LIMIT 500`;
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/admin/logs/usuarios', (req, res) => {
  const rows = db.prepare(`SELECT DISTINCT username FROM logs WHERE username IS NOT NULL ORDER BY username`).all();
  res.json(rows.map(r => r.username));
});

app.delete('/api/admin/logs', (req, res) => {
  db.prepare('DELETE FROM logs').run();
  registrarLog(req, 'SISTEMA', 'LIMPOU', 'Histórico de logs limpo');
  res.json({ ok: true });
});

// Status da chave (pro admin saber se está configurada, sem expor o valor).
app.get('/api/admin/cpfhub', (req, res) => {
  const row = db.prepare(`SELECT valor FROM config WHERE chave = 'cpfhub_api_key'`).get();
  const v = row && row.valor ? String(row.valor).trim() : '';
  res.json({ configurada: !!v, mascara: v ? (v.slice(0, 4) + '••••••' + v.slice(-2)) : '' });
});

// Rotas do SECOP (cotações) — ver routes/secop.js
app.use(require('./routes/secop'));

// Rotas do SECAD (ex-Depop) — ver routes/secad.js
app.use(require('./routes/secad'));

// Rotas do PAC/DEPLA (DFD) — ver routes/pac.js
app.use(require('./routes/pac'));

// ── Versão ───────────────────────────────────────────────────────────────────
// Precisa vir ANTES do catch-all "Serve SPA" abaixo — senão o catch-all intercepta
// /api/version primeiro (Express casa rotas na ordem de registro), o `if` dele só
// trata caminhos fora de /api e não chama next() nem responde, e a requisição
// fica pendurada pra sempre (foi isso que deixava o indicador de versão nunca
// aparecer: o fetch('/api/version') do front nunca resolvia).
app.get('/api/version', (_req, res) => {
  const { version } = require('./package.json');
  res.json({ version, homolog: IS_HOMOLOG });
});

// ── Homolog: migrações a rodar manualmente na produção (DBeaver) ──────────────
// Ferramenta interna do master, SÓ em homolog. Lê a lista local de comandos SQL
// (migracoes-homolog.json, gitignored — mora só aqui). Em produção o marcador
// .homolog não existe → 404, a aba nunca aparece.
app.get('/api/admin/migracoes-homolog', (req, res) => {
  if (!IS_HOMOLOG) return res.status(404).json({ error: 'Indisponível fora do homolog.' });
  if (req.user.username !== 'master') return res.status(403).json({ error: 'Restrito ao master.' });
  res.set('Cache-Control', 'no-store');
  let dados = { migracoes: [] };
  try { if (fs.existsSync(MIGRACOES_FILE)) dados = JSON.parse(fs.readFileSync(MIGRACOES_FILE, 'utf8')); } catch (e) {
    return res.status(500).json({ error: 'Falha ao ler a lista de migrações: ' + e.message });
  }
  res.json({ migracoes: dados.migracoes || [] });
});

// ── Serve SPA ─────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// purgarLixeira() + setInterval agora rodam dentro de routes/secop.js
// (autoexecuta ao carregar o módulo, já acontece via o require acima).

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const { version } = require('./package.json');
  console.log(`SECOP Cotações v${version} rodando em http://localhost:${PORT}`);
});
