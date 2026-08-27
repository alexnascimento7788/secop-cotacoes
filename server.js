const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { db, anexosDb } = require('./database');
// Peças transversais de sessão/auth usadas pelas rotas /api/auth/* abaixo —
// o resto (registrarLog, gates de admin/módulo/rotina) só é usado dentro dos
// arquivos de rotas por módulo agora (routes/secop|secad|pac|admin.js).
const {
  getCookie, getInatividadeMinutos, renovarSessao, SESSAO_SQL, requireAuth,
  resolverPerfilId, modulosDoUsuario, registrarLog, CONSULTA_POST_OK,
} = require('./middleware');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// requireModulo / requireRotina / ROTINA_FLAGS_VALIDAS vêm de ./middleware.
// O antigo gate do SECOP por lista de prefixos (SECOP_PREFIXOS) foi substituído
// pelo `requireModulo('secop')` explícito em cada rota de routes/secop.js. O
// antigo `app.use('/api/admin', requireAdminAny)` blanket saiu daqui também —
// cada rota de routes/admin.js já leva o gate explícito (mesma decisão).

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



// Rotas do SECOP (cotações) — ver routes/secop.js
app.use(require('./routes/secop'));

// Rotas do SECAD (ex-Depop) — ver routes/secad.js
app.use(require('./routes/secad'));

// Rotas do PAC/DEPLA (DFD) — ver routes/pac.js
app.use(require('./routes/pac'));

// Rotas de Admin (usuários/departamentos/rotinas/perfis/módulos/backup/logs +
// catálogos transversais) — ver routes/admin.js. Exporta IS_HOMOLOG também
// (só esse arquivo precisa saber se está em homolog, mas /api/version — logo
// abaixo — usa o mesmo valor no corpo da resposta).
const { router: adminRouter, IS_HOMOLOG } = require('./routes/admin');
app.use(adminRouter);

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

// ── Serve SPA ─────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// Rede de segurança: qualquer exceção não tratada em QUALQUER rota (não só
// PAC) cai aqui em vez de virar a página HTML de erro padrão do Express —
// o frontend sempre espera `res.json()`, então uma resposta HTML nesse caso
// vira um "Erro ao X" genérico e o motivo real se perde. Precisa dos 4
// argumentos (err primeiro) pra o Express reconhecer como error handler;
// precisa vir por último, depois de toda rota/middleware normal.
app.use((err, req, res, _next) => {
  console.error('Erro não tratado:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Erro interno no servidor.' });
});

// purgarLixeira() + setInterval agora rodam dentro de routes/secop.js
// (autoexecuta ao carregar o módulo, já acontece via o require acima).

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const { version } = require('./package.json');
  console.log(`SECOP Cotações v${version} rodando em http://localhost:${PORT}`);
});
