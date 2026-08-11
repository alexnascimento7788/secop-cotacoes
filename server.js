const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, setupDb, gerarNumeroProcesso, depopDb, setupDepop, depopFilePath, anexosDb, setupAnexos, anexosFilePath } = require('./database');

// Dicionário geral de português (já vem ordenado por frequência de uso do idioma)
// — recorte das mais comuns, serve de apoio ao autocomplete quando o histórico
// real da cotação ainda não tem a palavra digitada.
const DICIONARIO_PT = require('an-array-of-portuguese-words')
  .filter(w => w.length >= 3)
  .slice(0, 30000);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ambiente HOMOLOG: existe só onde há o arquivo-marcador `.homolog` (gitignored).
// Gateia a aba "Atualização na base de produção" (ferramenta interna do master p/
// acumular os comandos SQL a rodar manualmente na produção). Em produção o arquivo
// não existe → a aba nunca aparece, mesmo que o código chegue lá pelo git.
const IS_HOMOLOG = fs.existsSync(path.join(__dirname, '.homolog'));
const MIGRACOES_FILE = path.join(__dirname, 'migracoes-homolog.json');

// node:sqlite rejects undefined — coerce to null
const n = v => (v === undefined ? null : v);

// ── Auth helpers ──────────────────────────────────────────────────────────────

function getCookie(req, name) {
  const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function getInatividadeMinutos() {
  const row = db.prepare(`SELECT valor FROM config WHERE chave = 'inatividade_minutos'`).get();
  const min = parseInt(row?.valor, 10);
  return min > 0 ? min : 30;
}

function getLixeiraDias() {
  const row = db.prepare(`SELECT valor FROM config WHERE chave = 'lixeira_dias'`).get();
  const dias = parseInt(row?.valor, 10);
  return dias > 0 ? dias : 60;
}

// Purga definitiva de processos que já passaram do prazo na Lixeira — não existe
// "excluir" manual na Lixeira, só esta purga por tempo (ver /api/admin/lixeira)
function purgarLixeira() {
  try {
    db.prepare(`DELETE FROM processos WHERE excluido_em IS NOT NULL AND excluido_em < datetime('now', '-' || ? || ' days')`)
      .run(getLixeiraDias());
  } catch {}
}

// Empurra o vencimento da sessão pra frente a cada requisição autenticada —
// o cookie em si dura bastante (ver /api/auth/login), quem controla o timeout
// de verdade é sessions.expires, rolando conforme uso real
function renovarSessao(token) {
  db.prepare(`UPDATE sessions SET expires = datetime('now', '+' || ? || ' minutes') WHERE token = ?`)
    .run(getInatividadeMinutos(), token);
}

function requireAuth(req, res, next) {
  const token = getCookie(req, 'secop_sid');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const session = db.prepare(`
    SELECT s.user_id, s.modulo_ativo, u.username, u.role, u.acesso_avancado
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires > datetime('now') AND u.ativo = 1
  `).get(token);
  if (!session) return res.status(401).json({ error: 'Sessão expirada' });
  renovarSessao(token);
  req.user = session;
  next();
}

// ── Módulos (plataforma CEASA CONECTA) ────────────────────────────────────────
// Módulos ativos que o usuário pode acessar. O master sempre enxerga todos os
// módulos ativos; os demais, só os que têm em user_modulos. Sempre filtra ativo=1
// para que desligar um módulo o esconda de todos de uma vez.
function modulosDoUsuario(user) {
  // master e usuário de consulta (somente leitura) enxergam todos os módulos ativos.
  if (user.username === 'master' || user.role === 'consulta') {
    return db.prepare(`SELECT id, slug, nome, cor, home, ordem FROM modulos WHERE ativo = 1 ORDER BY ordem`).all();
  }
  return db.prepare(`
    SELECT m.id, m.slug, m.nome, m.cor, m.home, m.ordem
    FROM modulos m JOIN user_modulos um ON um.modulo_id = m.id
    WHERE um.user_id = ? AND m.ativo = 1 ORDER BY m.ordem
  `).all(user.user_id ?? user.id);
}

// ── Log helper ────────────────────────────────────────────────────────────────

function registrarLog(req, tipo, acao, descricao, _username, _userId) {
  const username = _username ?? (req.user ? req.user.username : null);
  const user_id  = _userId  ?? (req.user ? req.user.user_id  : null);
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  try {
    db.prepare('INSERT INTO logs (user_id, username, tipo, acao, descricao, ip) VALUES (?,?,?,?,?,?)')
      .run(n(user_id), n(username), tipo, acao, n(descricao), n(ip));
  } catch {}
}

// Protege todas as rotas /api/ exceto /api/auth/*
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  requireAuth(req, res, next);
});

// Somente leitura para o perfil "consulta": nega qualquer método que não seja
// leitura. É a garantia real (o cliente também avisa, mas isto é o que protege).
// Poucos POSTs de VISUALIZAÇÃO passam: abrir/ping/fechar o preview de um contrato
// no Depop apenas montam a tela e mexem numa trava efêmera — nunca alteram dado.
const CONSULTA_POST_OK = [
  /^\/depop\/contratos\/\d+\/(abrir|ping|fechar)$/,
];
app.use('/api', (req, res, next) => {
  if (!req.user || req.user.role !== 'consulta') return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (CONSULTA_POST_OK.some(re => re.test(req.path))) return next();
  return res.status(403).json({ error: 'Usuário de consulta: acesso somente leitura.' });
});

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores' });
  // Segunda camada: dentro de "admin" só quem tem acesso_avancado (ou é o
  // usuário "master") entra em Configurações/Lixeira — todo o admin.html e
  // suas rotas (mesmo as que não vivem sob /api/admin, ex. tipos-extra,
  // tipos-contratacao, status) passam por aqui
  if (req.user.username !== 'master' && !req.user.acesso_avancado) {
    return res.status(403).json({ error: 'Acesso restrito' });
  }
  next();
}
app.use('/api/admin', requireAdmin);

// ── Trava por módulo ativo ────────────────────────────────────────────────────
// As rotas de dados do SECOP só respondem quando o módulo ativo da sessão é o
// SECOP. Rotas transversais (/auth, /config, /version, /admin) e de outros
// módulos passam livres — a trava só barra quem tenta usar dados do SECOP com
// outro módulo ativo (ex.: master dentro do Depop). Enforcement no servidor,
// além do redirecionamento no auth.js. `req.path` aqui é relativo ao mount /api.
const SECOP_PREFIXOS = ['/processos', '/fornecedores', '/itens', '/precos', '/dashboard',
  '/status', '/tipos-contratacao', '/tipos-extra', '/autocomplete', '/dicionario-pt', '/setores'];
app.use('/api', (req, res, next) => {
  if (!req.user) return next(); // /auth/* não tem req.user — segue pro handler próprio
  const ehSecop = SECOP_PREFIXOS.some(p => req.path === p || req.path.startsWith(p + '/'));
  if (ehSecop && req.user.modulo_ativo !== 'secop') {
    return res.status(403).json({ error: 'O módulo SECOP não está ativo nesta sessão.' });
  }
  next();
});

// Exige que o módulo indicado seja o ativo na sessão. Usado para montar as rotas
// próprias de um módulo (ex.: `/api/depop/*`), espelhando a trava do SECOP acima.
function requireModulo(slug) {
  return (req, res, next) => {
    if (req.user.modulo_ativo !== slug) {
      return res.status(403).json({ error: `O módulo não está ativo nesta sessão.` });
    }
    next();
  };
}

// ── Permissões de cotação (dono ou admin) ──────────────────────────────────────

function podeEditarProcesso(user, processoId) {
  if (user.role === 'admin') return true;
  const proc = db.prepare('SELECT criado_por_id FROM processos WHERE id = ?').get(processoId);
  return !!proc && proc.criado_por_id === user.user_id;
}

function requireEditProcesso(resolveId) {
  return (req, res, next) => {
    const id = resolveId(req);
    if (id == null) return res.status(404).json({ error: 'Não encontrado' });
    if (!podeEditarProcesso(req.user, id)) {
      return res.status(403).json({ error: 'Você não tem permissão para editar esta cotação' });
    }
    next();
  };
}

function processoIdDoFornecedor(fornecedorId) {
  const row = db.prepare('SELECT processo_id FROM fornecedores WHERE id = ?').get(fornecedorId);
  return row ? row.processo_id : null;
}

function processoIdDoItem(itemId) {
  const row = db.prepare('SELECT processo_id FROM itens WHERE id = ?').get(itemId);
  return row ? row.processo_id : null;
}

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

  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + getInatividadeMinutos() * 60 * 1000).toISOString();

  db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires < datetime('now')").run(user.id);
  db.prepare("INSERT INTO sessions (token, user_id, expires, modulo_ativo) VALUES (?, ?, ?, ?)")
    .run(token, user.id, expires, moduloInicial);

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
  const session = db.prepare(`
    SELECT s.user_id AS id, s.modulo_ativo, u.username, u.role, u.acesso_avancado
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires > datetime('now') AND u.ativo = 1
  `).get(token);
  if (!session) return res.status(401).json({ error: 'Não autenticado' });
  renovarSessao(token);
  res.json(session);
});

// Módulos que o usuário logado pode acessar + qual está ativo na sessão. Serve a
// tela de seleção de módulo e a montagem da sidebar (marca/accent) no auth.js.
// requireAuth explícito: rotas /api/auth/* são isentas do middleware global, mas
// estas precisam de req.user.
app.get('/api/auth/modulos', requireAuth, (req, res) => {
  const modulos = modulosDoUsuario(req.user);
  res.json({ modulos, modulo_ativo: req.user.modulo_ativo });
});

// Registra o módulo escolhido na sessão. Valida que o usuário realmente tem
// acesso a ele (master pode qualquer módulo ativo).
app.post('/api/auth/selecionar-modulo', requireAuth, (req, res) => {
  const { slug } = req.body || {};
  if (!slug) return res.status(400).json({ error: 'Módulo não informado' });
  const permitido = modulosDoUsuario(req.user).find(m => m.slug === slug);
  if (!permitido) return res.status(403).json({ error: 'Você não tem acesso a este módulo' });
  const token = getCookie(req, 'secop_sid');
  db.prepare(`UPDATE sessions SET modulo_ativo = ? WHERE token = ?`).run(slug, token);
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
  if (session.username !== 'master' && !session.acesso_avancado) {
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
// segue pro fluxo normal (escolha de módulo / cadastro do Depop).
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

// ── Processos ─────────────────────────────────────────────────────────────────

app.get('/api/processos', (req, res) => {
  const { status, setor, busca } = req.query;
  let sql = `
    SELECT p.*, u.username AS criado_por_username,
      CAST((julianday('now') - julianday(p.criado_em)) AS INTEGER) AS dias_em_aberto
    FROM processos p
    LEFT JOIN users u ON u.id = p.criado_por_id
    WHERE p.excluido_em IS NULL
  `;
  const params = [];

  if (status) { sql += ` AND p.status = ?`; params.push(status); }
  if (setor)  { sql += ` AND p.setor_solicitante = ?`; params.push(setor); }
  if (busca)  { sql += ` AND (p.objeto LIKE ? OR p.numero_processo LIKE ? OR p.responsavel LIKE ?)`; params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`); }

  sql += ` ORDER BY p.id DESC`;
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/processos', (req, res) => {
  const { objeto, setor_solicitante, tipo_contratacao, responsavel, descricao,
          previsao_inicio, previsao_termino, observacoes, observacoes2, data_abertura } = req.body;

  if (!objeto) return res.status(400).json({ error: 'Objeto é obrigatório' });

  const numero_processo = gerarNumeroProcesso();
  const info = db.prepare(`
    INSERT INTO processos (numero_processo, objeto, setor_solicitante, tipo_contratacao,
      responsavel, descricao, previsao_inicio, previsao_termino, observacoes, observacoes2, data_abertura, criado_por_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(numero_processo, n(objeto), n(setor_solicitante), n(tipo_contratacao), n(responsavel),
         n(descricao), n(previsao_inicio), n(previsao_termino), n(observacoes), n(observacoes2), n(data_abertura),
         req.user.user_id);

  registrarLog(req, 'PROCESSO', 'CRIOU', `Criou processo ${numero_processo}: ${objeto}`);

  res.status(201).json({ id: info.lastInsertRowid, numero_processo });
});

app.get('/api/processos/:id', (req, res) => {
  const processo = db.prepare(`
    SELECT p.*, u.username AS criado_por_username,
      CAST((julianday('now') - julianday(p.criado_em)) AS INTEGER) AS dias_em_aberto
    FROM processos p
    LEFT JOIN users u ON u.id = p.criado_por_id
    WHERE p.id = ? AND p.excluido_em IS NULL
  `).get(req.params.id);
  if (!processo) return res.status(404).json({ error: 'Não encontrado' });

  const fornecedores = db.prepare(`SELECT * FROM fornecedores WHERE processo_id = ? ORDER BY ordem`).all(req.params.id);
  const itens = db.prepare(`SELECT * FROM itens WHERE processo_id = ? ORDER BY item_num`).all(req.params.id);
  const precos = db.prepare(`
    SELECT p.*, i.processo_id FROM precos p
    JOIN itens i ON i.id = p.item_id
    WHERE i.processo_id = ?
  `).all(req.params.id);

  res.json({ ...processo, fornecedores, itens, precos });
});

// Duplica cabeçalho + itens + fornecedores (sem preços/proposta) num processo novo,
// pra facilitar cotações recorrentes — qualquer usuário autenticado pode duplicar
// (não exige dono/admin do original, só leitura, que já é livre pra todos)
app.post('/api/processos/:id/duplicar', (req, res) => {
  const original = db.prepare(`SELECT * FROM processos WHERE id = ? AND excluido_em IS NULL`).get(req.params.id);
  if (!original) return res.status(404).json({ error: 'Não encontrado' });

  const numero_processo = gerarNumeroProcesso();
  const info = db.prepare(`
    INSERT INTO processos (numero_processo, objeto, setor_solicitante, tipo_contratacao,
      responsavel, descricao, previsao_inicio, previsao_termino, observacoes, observacoes2,
      mostrar_menor_preco, criado_por_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(numero_processo, original.objeto, original.setor_solicitante, original.tipo_contratacao,
         original.responsavel, original.descricao, original.previsao_inicio, original.previsao_termino,
         original.observacoes, original.observacoes2, original.mostrar_menor_preco, req.user.user_id);
  const novoId = info.lastInsertRowid;

  const itens = db.prepare(`SELECT * FROM itens WHERE processo_id = ? ORDER BY item_num`).all(req.params.id);
  const insertItem = db.prepare(`INSERT INTO itens (processo_id, item_num, quantidade, unidade, descricao, extra) VALUES (?, ?, ?, ?, ?, ?)`);
  itens.forEach(i => insertItem.run(novoId, i.item_num, i.quantidade, i.unidade, i.descricao, i.extra));

  const fornecedores = db.prepare(`SELECT * FROM fornecedores WHERE processo_id = ? ORDER BY ordem`).all(req.params.id);
  const insertForn = db.prepare(`
    INSERT INTO fornecedores (processo_id, ordem, nome, contato, telefone, celular, email,
      prazo_pagamento, prazo_entrega, prazo_garantia, frete, frete_termo,
      pesquisa_internet, pesquisa_compra_publica, declinio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  fornecedores.forEach(f => insertForn.run(novoId, f.ordem, f.nome, f.contato, f.telefone, f.celular, f.email,
    f.prazo_pagamento, f.prazo_entrega, f.prazo_garantia, f.frete, f.frete_termo,
    f.pesquisa_internet, f.pesquisa_compra_publica, f.declinio));

  registrarLog(req, 'PROCESSO', 'DUPLICOU', `Duplicou processo ${original.numero_processo} (${original.objeto}) em ${numero_processo}`);

  res.status(201).json({ id: novoId, numero_processo });
});

app.put('/api/processos/:id', requireEditProcesso(req => req.params.id), (req, res) => {
  const { objeto, setor_solicitante, tipo_contratacao, responsavel, descricao,
          previsao_inicio, previsao_termino, status, observacoes, observacoes2, data_abertura } = req.body;

  const existe = db.prepare(`SELECT id, numero_processo FROM processos WHERE id = ?`).get(req.params.id);
  if (!existe) return res.status(404).json({ error: 'Não encontrado' });

  db.prepare(`
    UPDATE processos SET objeto=?, setor_solicitante=?, tipo_contratacao=?, responsavel=?,
      descricao=?, previsao_inicio=?, previsao_termino=?, status=?, observacoes=?,
      observacoes2=?, data_abertura=?, atualizado_em=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(n(objeto), n(setor_solicitante), n(tipo_contratacao), n(responsavel), n(descricao),
         n(previsao_inicio), n(previsao_termino), n(status), n(observacoes),
         n(observacoes2), n(data_abertura), req.params.id);

  registrarLog(req, 'PROCESSO', 'EDITOU', `Editou processo ${existe.numero_processo}`);

  res.json({ ok: true });
});

app.delete('/api/processos/:id', requireEditProcesso(req => req.params.id), (req, res) => {
  const proc = db.prepare(`SELECT numero_processo, objeto FROM processos WHERE id = ?`).get(req.params.id);
  // Soft-delete: vai pra Lixeira (Configurações), não some de vez — só quem tem
  // acesso_avancado/master enxerga e pode restaurar; purga automática depois de
  // config.lixeira_dias (ver purgarLixeira)
  db.prepare(`UPDATE processos SET excluido_em = datetime('now') WHERE id = ?`).run(req.params.id);
  if (proc) registrarLog(req, 'PROCESSO', 'EXCLUIU', `Excluiu processo ${proc.numero_processo}: ${proc.objeto} (movido para lixeira)`);
  res.json({ ok: true });
});

// ── Lixeira (Configurações → Lixeira, restrito por requireAdmin) ───────────────

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

// ── Fornecedores ──────────────────────────────────────────────────────────────

app.get('/api/processos/:id/fornecedores', (req, res) => {
  res.json(db.prepare(`SELECT * FROM fornecedores WHERE processo_id = ? ORDER BY ordem`).all(req.params.id));
});

app.get('/api/fornecedores/:id', (req, res) => {
  const f = db.prepare(`SELECT * FROM fornecedores WHERE id = ?`).get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Não encontrado' });
  const precos = db.prepare(`SELECT * FROM precos WHERE fornecedor_id = ?`).all(req.params.id);
  res.json({ ...f, precos });
});

app.post('/api/processos/:id/fornecedores', requireEditProcesso(req => req.params.id), (req, res) => {
  const { nome, contato, telefone, celular, email, data_proposta,
          prazo_pagamento, prazo_entrega, prazo_garantia, frete, frete_termo,
          proposta_inicial, proposta_final, observacoes, pesquisa_internet, pesquisa_compra_publica, declinio } = req.body;

  const countRow = db.prepare(`SELECT COUNT(*) AS c FROM fornecedores WHERE processo_id = ?`).get(req.params.id);
  const ordem = (countRow.c || 0) + 1;

  const info = db.prepare(`
    INSERT INTO fornecedores (processo_id, ordem, nome, contato, telefone, celular, email,
      data_proposta, prazo_pagamento, prazo_entrega, prazo_garantia, frete, frete_termo,
      proposta_inicial, proposta_final, observacoes, pesquisa_internet, pesquisa_compra_publica, declinio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, ordem, n(nome), n(contato), n(telefone), n(celular), n(email),
         n(data_proposta), n(prazo_pagamento), n(prazo_entrega), n(prazo_garantia), n(frete), n(frete_termo),
         n(proposta_inicial), n(proposta_final), n(observacoes), pesquisa_internet ? 1 : 0, pesquisa_compra_publica ? 1 : 0, declinio ? 1 : 0);

  const proc = db.prepare(`SELECT numero_processo FROM processos WHERE id = ?`).get(req.params.id);
  registrarLog(req, 'FORNECEDOR', 'CRIOU', `Adicionou fornecedor "${nome}" ao processo ${proc?.numero_processo || req.params.id}`);

  res.status(201).json({ id: info.lastInsertRowid });
});

app.put('/api/fornecedores/:id', requireEditProcesso(req => processoIdDoFornecedor(req.params.id)), (req, res) => {
  const { nome, contato, telefone, celular, email, data_proposta,
          prazo_pagamento, prazo_entrega, prazo_garantia, frete, frete_termo,
          proposta_inicial, proposta_final, observacoes, pesquisa_internet, pesquisa_compra_publica, declinio } = req.body;

  db.prepare(`
    UPDATE fornecedores SET nome=?, contato=?, telefone=?, celular=?, email=?,
      data_proposta=?, prazo_pagamento=?, prazo_entrega=?, prazo_garantia=?, frete=?, frete_termo=?,
      proposta_inicial=?, proposta_final=?, observacoes=?, pesquisa_internet=?, pesquisa_compra_publica=?, declinio=?
    WHERE id=?
  `).run(n(nome), n(contato), n(telefone), n(celular), n(email), n(data_proposta), n(prazo_pagamento),
         n(prazo_entrega), n(prazo_garantia), n(frete), n(frete_termo), n(proposta_inicial), n(proposta_final), n(observacoes),
         pesquisa_internet ? 1 : 0, pesquisa_compra_publica ? 1 : 0, declinio ? 1 : 0, req.params.id);

  res.json({ ok: true });
});

app.delete('/api/fornecedores/:id', requireEditProcesso(req => processoIdDoFornecedor(req.params.id)), (req, res) => {
  const f = db.prepare(`SELECT nome, processo_id FROM fornecedores WHERE id = ?`).get(req.params.id);
  db.prepare(`DELETE FROM fornecedores WHERE id = ?`).run(req.params.id);
  if (f) {
    const proc = db.prepare(`SELECT numero_processo FROM processos WHERE id = ?`).get(f.processo_id);
    registrarLog(req, 'FORNECEDOR', 'EXCLUIU', `Removeu fornecedor "${f.nome}" do processo ${proc?.numero_processo || f.processo_id}`);
  }
  res.json({ ok: true });
});

// ── Itens ─────────────────────────────────────────────────────────────────────

app.get('/api/processos/:id/itens', (req, res) => {
  const itens = db.prepare(`SELECT * FROM itens WHERE processo_id = ? ORDER BY item_num`).all(req.params.id);
  const result = itens.map(item => {
    const precos = db.prepare(`SELECT * FROM precos WHERE item_id = ?`).all(item.id);
    return { ...item, precos };
  });
  res.json(result);
});

app.post('/api/processos/:id/itens', requireEditProcesso(req => req.params.id), (req, res) => {
  const { item_num, quantidade, unidade, descricao, extra } = req.body;
  const info = db.prepare(`
    INSERT INTO itens (processo_id, item_num, quantidade, unidade, descricao, extra)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.params.id, n(item_num), n(quantidade), n(unidade), n(descricao), extra ? 1 : 0);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.put('/api/itens/:id', requireEditProcesso(req => processoIdDoItem(req.params.id)), (req, res) => {
  const { item_num, quantidade, unidade, descricao } = req.body;
  db.prepare(`UPDATE itens SET item_num=?, quantidade=?, unidade=?, descricao=? WHERE id=?`)
    .run(n(item_num), n(quantidade), n(unidade), n(descricao), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/itens/:id', requireEditProcesso(req => processoIdDoItem(req.params.id)), (req, res) => {
  db.prepare(`DELETE FROM itens WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Preços ────────────────────────────────────────────────────────────────────

app.post('/api/precos', requireEditProcesso(req => processoIdDoItem(req.body.item_id)), (req, res) => {
  const { item_id, fornecedor_id, preco_unitario_mes, preco_total_ano } = req.body;
  db.prepare(`
    INSERT INTO precos (item_id, fornecedor_id, preco_unitario_mes, preco_total_ano)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(item_id, fornecedor_id) DO UPDATE SET
      preco_unitario_mes=excluded.preco_unitario_mes,
      preco_total_ano=excluded.preco_total_ano
  `).run(n(item_id), n(fornecedor_id), n(preco_unitario_mes), n(preco_total_ano));
  res.json({ ok: true });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

app.get('/api/dashboard/resumo', (req, res) => {
  const em_cotacao   = db.prepare(`SELECT COUNT(*) AS c FROM processos WHERE (status='Em cotação' OR status IS NULL) AND excluido_em IS NULL`).get().c;
  const ag_aprovacao = db.prepare(`SELECT COUNT(*) AS c FROM processos WHERE status='Ag. aprovação' AND excluido_em IS NULL`).get().c;
  const concluidos_mes = db.prepare(`
    SELECT COUNT(*) AS c FROM processos
    WHERE status='Concluído' AND excluido_em IS NULL
      AND strftime('%Y-%m', atualizado_em) = strftime('%Y-%m', 'now')
  `).get().c;
  const parados = db.prepare(`SELECT COUNT(*) AS c FROM processos WHERE status='Parado' AND excluido_em IS NULL`).get().c;

  const alertas = db.prepare(`
    SELECT id, numero_processo, objeto, setor_solicitante, status,
      CAST((julianday('now') - julianday(criado_em)) AS INTEGER) AS dias_em_aberto
    FROM processos
    WHERE excluido_em IS NULL
      AND (status = 'Parado'
       OR (status NOT IN ('Concluído', 'Cancelado') AND CAST((julianday('now') - julianday(atualizado_em)) AS INTEGER) > 15))
    ORDER BY dias_em_aberto DESC
    LIMIT 20
  `).all();

  const ultimos_processos = db.prepare(`
    SELECT id, numero_processo, objeto, setor_solicitante, status, criado_em,
      CAST((julianday('now') - julianday(criado_em)) AS INTEGER) AS dias_em_aberto
    FROM processos WHERE excluido_em IS NULL ORDER BY criado_em DESC LIMIT 5
  `).all();

  const por_setor = db.prepare(`
    SELECT setor_solicitante AS setor, COUNT(*) AS total
    FROM processos
    WHERE excluido_em IS NULL AND setor_solicitante IS NOT NULL AND setor_solicitante != ''
    GROUP BY setor_solicitante ORDER BY total DESC
  `).all();

  res.json({ em_cotacao, ag_aprovacao, concluidos_mes, parados, alertas, ultimos_processos, por_setor });
});

// ── Vencedor ──────────────────────────────────────────────────────────────────

app.put('/api/processos/:id/vencedor/:fornecedor_id', requireEditProcesso(req => req.params.id), (req, res) => {
  db.prepare(`UPDATE processos SET proposta_vencedora_id=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`)
    .run(req.params.fornecedor_id, req.params.id);
  res.json({ ok: true });
});

// ── Menor preço ───────────────────────────────────────────────────────────────

app.patch('/api/processos/:id/mostrar-menor-preco', requireEditProcesso(req => req.params.id), (req, res) => {
  const { mostrar } = req.body;
  db.prepare(`UPDATE processos SET mostrar_menor_preco=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`)
    .run(mostrar ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ── Status rápido ─────────────────────────────────────────────────────────────

app.patch('/api/processos/:id/status', requireEditProcesso(req => req.params.id), (req, res) => {
  const { status } = req.body;
  const atual = db.prepare(`SELECT status, numero_processo FROM processos WHERE id=?`).get(req.params.id);
  if (!atual) return res.status(404).json({ error: 'Não encontrado' });
  db.prepare(`UPDATE processos SET status=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status, req.params.id);
  db.prepare(`INSERT INTO status_historico (processo_id, status_de, status_para) VALUES (?,?,?)`)
    .run(req.params.id, atual.status, status);
  registrarLog(req, 'PROCESSO', 'STATUS', `Processo ${atual.numero_processo}: "${atual.status || 'Em cotação'}" → "${status}"`);
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

// ── Status ────────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json(db.prepare(`SELECT * FROM status ORDER BY ordem`).all());
});

app.post('/api/status', (req, res) => {
  const { nome, ordem } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  const info = db.prepare(`INSERT INTO status (nome, ordem) VALUES (?, ?)`).run(nome, n(ordem) ?? 0);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.put('/api/status/:id', (req, res) => {
  const { nome, ordem } = req.body;
  db.prepare(`UPDATE status SET nome=?, ordem=? WHERE id=?`).run(nome, n(ordem) ?? 0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/status/:id', (req, res) => {
  db.prepare(`DELETE FROM status WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Tipos de contratação ─────────────────────────────────────────────────────

app.get('/api/tipos-contratacao', (req, res) => {
  res.json(db.prepare(`SELECT * FROM tipos_contratacao ORDER BY ordem`).all());
});

app.post('/api/tipos-contratacao', requireAdmin, (req, res) => {
  const { nome, ordem } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  try {
    const info = db.prepare(`INSERT INTO tipos_contratacao (nome, ordem) VALUES (?, ?)`).run(nome, n(ordem) ?? 0);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Tipo já existe' });
  }
});

app.put('/api/tipos-contratacao/:id', requireAdmin, (req, res) => {
  const { nome, ordem } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  db.prepare(`UPDATE tipos_contratacao SET nome=?, ordem=? WHERE id=?`).run(nome, n(ordem) ?? 0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/tipos-contratacao/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM tipos_contratacao WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Tipos de itens extras (unidade + descrição sempre amarrados) ──────────────

app.get('/api/tipos-extra', (req, res) => {
  res.json(db.prepare(`SELECT * FROM tipos_extra ORDER BY ordem`).all());
});

app.post('/api/tipos-extra', requireAdmin, (req, res) => {
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

app.put('/api/tipos-extra/:id', requireAdmin, (req, res) => {
  const { unidade, descricao, ordem, sinal, tipo_valor, conta_no_total } = req.body;
  if (!unidade || !descricao) return res.status(400).json({ error: 'Unidade e descrição são obrigatórias' });
  const sinalVal = sinal === 'negativo' ? 'negativo' : 'positivo';
  const tipoValorVal = tipo_valor === 'percentual' ? 'percentual' : 'fixo';
  const contaNoTotalVal = conta_no_total === false || conta_no_total === 0 || conta_no_total === '0' ? 0 : 1;
  db.prepare(`UPDATE tipos_extra SET unidade=?, descricao=?, ordem=?, sinal=?, tipo_valor=?, conta_no_total=? WHERE id=?`).run(unidade, descricao, n(ordem) ?? 0, sinalVal, tipoValorVal, contaNoTotalVal, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/tipos-extra/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM tipos_extra WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Autocomplete (histórico de valores já digitados) ───────────────────────────

const AUTOCOMPLETE_FIELDS = {
  objeto:                 { table: 'processos',    col: 'objeto' },
  descricao:              { table: 'processos',    col: 'descricao' },
  setor_solicitante:      { table: 'processos',    col: 'setor_solicitante' },
  responsavel:            { table: 'processos',    col: 'responsavel' },
  observacoes:            { table: 'processos',    col: 'observacoes' },
  observacoes2:           { table: 'processos',    col: 'observacoes2' },
  fornecedor_nome:        { table: 'fornecedores', col: 'nome' },
  fornecedor_contato:     { table: 'fornecedores', col: 'contato' },
  fornecedor_observacoes: { table: 'fornecedores', col: 'observacoes' },
  prazo_entrega:          { table: 'fornecedores', col: 'prazo_entrega' },
  prazo_pagamento:        { table: 'fornecedores', col: 'prazo_pagamento' },
  prazo_garantia:         { table: 'fornecedores', col: 'prazo_garantia' },
};

app.get('/api/autocomplete/:campo', (req, res) => {
  const def = AUTOCOMPLETE_FIELDS[req.params.campo];
  if (!def) return res.status(404).json({ error: 'Campo desconhecido' });
  const rows = db.prepare(`
    SELECT ${def.col} AS v, COUNT(*) AS n FROM ${def.table}
    WHERE ${def.col} IS NOT NULL AND TRIM(${def.col}) != ''
    GROUP BY ${def.col} ORDER BY n DESC, ${def.col} ASC LIMIT 200
  `).all();
  res.json(rows.map(r => r.v));
});

// Frequência de palavras (não de frases inteiras) — permite prever/completar a
// palavra em digitação mesmo quando ainda há pouco histórico de frases completas.
const PALAVRA_RE = /[\p{L}\p{N}]+/gu;

app.get('/api/autocomplete/:campo/palavras', (req, res) => {
  const def = AUTOCOMPLETE_FIELDS[req.params.campo];
  if (!def) return res.status(404).json({ error: 'Campo desconhecido' });
  const rows = db.prepare(`
    SELECT ${def.col} AS v FROM ${def.table}
    WHERE ${def.col} IS NOT NULL AND TRIM(${def.col}) != ''
  `).all();

  const freq = new Map();
  for (const row of rows) {
    const vistas = new Set(); // conta no máx. 1x por registro, pra 1 observação longa não dominar o ranking
    for (const m of String(row.v).matchAll(PALAVRA_RE)) {
      const palavra = m[0].toLowerCase();
      if (palavra.length < 3 || vistas.has(palavra)) continue;
      vistas.add(palavra);
      freq.set(palavra, (freq.get(palavra) || 0) + 1);
    }
  }

  const palavras = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 500)
    .map(([palavra]) => palavra);

  res.json(palavras);
});

app.get('/api/dicionario-pt', (req, res) => {
  res.json(DICIONARIO_PT);
});

// ── Setores (lista única para filtros) ────────────────────────────────────────

app.get('/api/setores', (req, res) => {
  const rows = db.prepare(`SELECT DISTINCT setor_solicitante FROM processos WHERE setor_solicitante IS NOT NULL AND excluido_em IS NULL ORDER BY setor_solicitante`).all();
  res.json(rows.map(r => r.setor_solicitante));
});

// ── Admin: usuários ───────────────────────────────────────────────────────────

app.get('/api/admin/users', (req, res) => {
  // Capacidades do Depop (valida / comunicados) vêm por LEFT JOIN: sem linha em
  // depop_acesso = padrão (valida=1, comunicados=0).
  res.json(db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.ativo, u.acesso_avancado, u.senha_provisoria, u.criado_em,
           COALESCE(da.valida, 1) AS depop_valida, COALESCE(da.comunicados, 0) AS depop_comunicados
    FROM users u LEFT JOIN depop_acesso da ON da.user_id = u.id
    WHERE u.username != 'master' ORDER BY u.id`).all());
});

app.post('/api/admin/users', (req, res) => {
  const { username, senha, email, role, acesso_avancado } = req.body;
  if (!username || !senha) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(senha, salt, 100000, 64, 'sha512').toString('hex');
  const acessoVal = acesso_avancado ? 1 : 0;
  try {
    // senha_provisoria = 1: o admin define uma senha inicial e o usuário é
    // obrigado a trocá-la no 1º login.
    const info = db.prepare(
      "INSERT INTO users (username, senha_hash, salt, role, ativo, acesso_avancado, email, senha_provisoria) VALUES (?, ?, ?, ?, 1, ?, ?, 1)"
    ).run(username, hash, salt, role || 'usuario', acessoVal, email ? String(email).trim() : null);
    registrarLog(req, 'USUARIO', 'CRIOU', `Criou usuário "${username}"`);
    // Acesso padrão ao SECOP para o novo usuário não nascer bloqueado — o admin
    // ajusta (concede outros / revoga) na aba Módulos.
    try {
      const secop = db.prepare(`SELECT id FROM modulos WHERE slug = 'secop'`).get();
      if (secop) db.prepare(`INSERT OR IGNORE INTO user_modulos (user_id, modulo_id) VALUES (?, ?)`)
        .run(info.lastInsertRowid, secop.id);
    } catch {}
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Usuário já existe' });
  }
});

app.patch('/api/admin/users/:id', (req, res) => {
  const { ativo, senha, email, role, acesso_avancado } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Não encontrado' });

  if (email !== undefined) {
    db.prepare("UPDATE users SET email = ? WHERE id = ?").run(email ? String(email).trim() : null, req.params.id);
    registrarLog(req, 'USUARIO', 'EMAIL', `Alterou o email do usuário "${user.username}"`);
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
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, req.params.id);
    registrarLog(req, 'USUARIO', 'PERFIL', `Alterou perfil do usuário "${user.username}" para "${role}"`);
  }
  if (acesso_avancado !== undefined) {
    if (user.username === 'master') return res.status(400).json({ error: 'O master já tem acesso completo' });
    db.prepare("UPDATE users SET acesso_avancado = ? WHERE id = ?").run(acesso_avancado ? 1 : 0, req.params.id);
    registrarLog(req, 'USUARIO', 'ACESSO_AVANCADO', `${acesso_avancado ? 'Concedeu' : 'Revogou'} acesso avançado (Configurações/Lixeira) a "${user.username}"`);
  }
  // Capacidades dentro do módulo Depop: validar contratos e/ou gerar comunicados.
  // Só grava o flag enviado; mantém o outro. O acesso ao MÓDULO em si é na aba Módulos.
  if (req.body.depop_valida !== undefined || req.body.depop_comunicados !== undefined) {
    if (user.username === 'master') return res.status(400).json({ error: 'O master já usa todo o Depop' });
    const cur = db.prepare("SELECT valida, comunicados FROM depop_acesso WHERE user_id = ?").get(req.params.id) || { valida: 1, comunicados: 0 };
    const valida      = req.body.depop_valida      !== undefined ? (req.body.depop_valida ? 1 : 0)      : cur.valida;
    const comunicados = req.body.depop_comunicados !== undefined ? (req.body.depop_comunicados ? 1 : 0) : cur.comunicados;
    db.prepare(`INSERT INTO depop_acesso (user_id, valida, comunicados) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET valida = excluded.valida, comunicados = excluded.comunicados`)
      .run(req.params.id, valida, comunicados);
    registrarLog(req, 'USUARIO', 'DEPOP_ACESSO', `Depop de "${user.username}": validação=${valida ? 'sim' : 'não'}, comunicados=${comunicados ? 'sim' : 'não'}`);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', (req, res) => {
  const user = db.prepare("SELECT username FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Não encontrado' });
  if (user.username === 'master') return res.status(400).json({ error: 'Não é possível excluir o master' });
  // As cotações do usuário excluído permanecem no sistema, apenas ficam sem dono (só admin edita)
  db.prepare("UPDATE processos SET criado_por_id = NULL WHERE criado_por_id = ?").run(req.params.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  registrarLog(req, 'USUARIO', 'EXCLUIU', `Excluiu usuário "${user.username}"`);
  res.json({ ok: true });
});

// ── Admin: módulos (catálogo + matriz de acesso por usuário) ──────────────────

app.get('/api/admin/modulos', (req, res) => {
  res.json(db.prepare(`SELECT id, slug, nome, cor, home, ordem, ativo FROM modulos ORDER BY ordem`).all());
});

app.patch('/api/admin/modulos/:id', (req, res) => {
  const { ativo } = req.body;
  const modulo = db.prepare(`SELECT nome FROM modulos WHERE id = ?`).get(req.params.id);
  if (!modulo) return res.status(404).json({ error: 'Módulo não encontrado' });
  if (ativo !== undefined) {
    db.prepare(`UPDATE modulos SET ativo = ? WHERE id = ?`).run(ativo ? 1 : 0, req.params.id);
    registrarLog(req, 'MODULO', ativo ? 'ATIVOU' : 'DESATIVOU', `${ativo ? 'Ativou' : 'Desativou'} o módulo "${modulo.nome}"`);
  }
  res.json({ ok: true });
});

// Matriz para a aba Módulos: todos os módulos + cada usuário (exceto master, que
// já enxerga tudo) com a lista de módulos que possui.
app.get('/api/admin/modulos/acessos', (req, res) => {
  const modulos  = db.prepare(`SELECT id, slug, nome, cor, ativo FROM modulos ORDER BY ordem`).all();
  const usuarios = db.prepare(`SELECT id, username, role FROM users WHERE username != 'master' ORDER BY id`).all();
  const pares    = db.prepare(`SELECT user_id, modulo_id FROM user_modulos`).all();
  const porUser  = {};
  pares.forEach(p => { (porUser[p.user_id] = porUser[p.user_id] || []).push(p.modulo_id); });
  usuarios.forEach(u => { u.modulo_ids = porUser[u.id] || []; });
  res.json({ modulos, usuarios });
});

app.put('/api/admin/modulos/acessos', (req, res) => {
  const { user_id, modulo_id, concedido } = req.body || {};
  if (user_id == null || modulo_id == null) return res.status(400).json({ error: 'Dados incompletos' });
  const user   = db.prepare(`SELECT username FROM users WHERE id = ?`).get(user_id);
  const modulo = db.prepare(`SELECT nome FROM modulos WHERE id = ?`).get(modulo_id);
  if (!user || !modulo) return res.status(404).json({ error: 'Usuário ou módulo não encontrado' });
  if (user.username === 'master') return res.status(400).json({ error: 'O master já acessa todos os módulos' });
  if (concedido) {
    db.prepare(`INSERT OR IGNORE INTO user_modulos (user_id, modulo_id) VALUES (?, ?)`).run(user_id, modulo_id);
    registrarLog(req, 'MODULO', 'CONCEDEU', `Concedeu o módulo "${modulo.nome}" a "${user.username}"`);
  } else {
    db.prepare(`DELETE FROM user_modulos WHERE user_id = ? AND modulo_id = ?`).run(user_id, modulo_id);
    registrarLog(req, 'MODULO', 'REVOGOU', `Revogou o módulo "${modulo.nome}" de "${user.username}"`);
  }
  res.json({ ok: true });
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

// ── Depop: perfil de assinatura (CPF + par de chaves) ─────────────────────────

// Validação de CPF pelo algoritmo dos dígitos verificadores (mesma regra da
// Receita) — offline, sem consulta externa. Rejeita tamanho errado e as
// sequências repetidas (000..., 111...) que passam na conta mas são inválidas.
function cpfValido(cpf) {
  cpf = String(cpf || '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const dv = (fatorInicial) => {
    let soma = 0;
    for (let i = 0; i < fatorInicial - 1; i++) soma += parseInt(cpf[i], 10) * (fatorInicial - i);
    const resto = 11 - (soma % 11);
    return resto >= 10 ? 0 : resto;
  };
  return dv(10) === parseInt(cpf[9], 10) && dv(11) === parseInt(cpf[10], 10);
}

// (Assinatura por par de chaves EC removida: a validação passou a ser confirmada
// pela senha de LOGIN do próprio usuário + timbre SHA-256 verificável — uma senha
// só. Ver POST /api/depop/contratos/:id/validar. As colunas chave_* de
// depop_perfil viram legado, gravadas vazias.)

// ── Consulta de CPF na API externa (cpfhub.io) ────────────────────────────────
// A chave fica no config (chave 'cpfhub_api_key', gerenciada nos Parâmetros do
// admin) e NUNCA vai pro frontend (ver CONFIG_SECRETA). Fallback: variável de
// ambiente CPFHUB_API_KEY.
function getCpfHubKey() {
  const row = db.prepare(`SELECT valor FROM config WHERE chave = 'cpfhub_api_key'`).get();
  const v = row && row.valor ? String(row.valor).trim() : '';
  return v || process.env.CPFHUB_API_KEY || '';
}

// Cache curto das consultas — o plano grátis é só ~50 consultas, então evitamos
// bater 2x (uma ao digitar o CPF, outra ao salvar o perfil). Chave = CPF limpo.
const _cpfCache = new Map(); // cpf -> { fonte, existe, nome, ts }
const CPF_CACHE_TTL = 15 * 60 * 1000;

// Consulta o CPF na cpfhub.io. Retorna { fonte:'api'|'offline', existe, nome }.
// fonte 'offline' = não deu pra confirmar (sem chave / API fora / cota estourada)
// → o chamador aceita com base nos dígitos. fonte 'api' + existe:false = a API
// respondeu que o CPF não existe (aí bloqueia).
async function consultarCpfApi(cpfLimpo) {
  const cache = _cpfCache.get(cpfLimpo);
  if (cache && (Date.now() - cache.ts) < CPF_CACHE_TTL) return cache;

  const key = getCpfHubKey();
  let out;
  if (!key) {
    out = { fonte: 'offline', existe: null, nome: null };
  } else {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(`https://api.cpfhub.io/cpf/${cpfLimpo}`, {
        headers: { 'x-api-key': key, 'Accept': 'application/json' },
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (!r.ok) {
        out = { fonte: 'offline', existe: null, nome: null }; // 401/429/5xx → cai pra offline
      } else {
        const j = await r.json().catch(() => null);
        if (j && j.success && j.data) {
          out = { fonte: 'api', existe: true, nome: j.data.name || j.data.nome || null };
        } else {
          out = { fonte: 'api', existe: false, nome: null };
        }
      }
    } catch {
      out = { fonte: 'offline', existe: null, nome: null };
    }
  }
  out.ts = Date.now();
  _cpfCache.set(cpfLimpo, out);
  return out;
}

// Status da chave (pro admin saber se está configurada, sem expor o valor).
app.get('/api/admin/cpfhub', (req, res) => {
  const row = db.prepare(`SELECT valor FROM config WHERE chave = 'cpfhub_api_key'`).get();
  const v = row && row.valor ? String(row.valor).trim() : '';
  res.json({ configurada: !!v, mascara: v ? (v.slice(0, 4) + '••••••' + v.slice(-2)) : '' });
});

// Todas as rotas /api/depop/* exigem o módulo Depop ativo na sessão.
app.use('/api/depop', requireModulo('depop'));

// Consulta um CPF: valida dígitos offline e, se passar, confirma na API e
// devolve o nome (pra tela mostrar antes de salvar). Não grava nada.
app.post('/api/depop/consultar-cpf', async (req, res) => {
  const cpfLimpo = String((req.body && req.body.cpf) || '').replace(/\D/g, '');
  if (!cpfValido(cpfLimpo)) return res.json({ valido: false, motivo: 'digitos', error: 'CPF inválido.' });
  const r = await consultarCpfApi(cpfLimpo);
  if (r.fonte === 'api' && r.existe === false) {
    return res.json({ valido: false, motivo: 'nao_encontrado', error: 'CPF não encontrado na base da Receita.' });
  }
  res.json({ valido: true, nome: r.nome || null, fonte: r.fonte });
});

// Situação do perfil do usuário logado (o front decide se mostra o cadastro de
// 1º acesso ou o conteúdo). Nunca devolve chave privada; CPF vem mascarado.
app.get('/api/depop/perfil', (req, res) => {
  const ferramenta = perfilFerramenta(req); // 'master' | 'validador'
  const caps = depopCaps(req);
  const perfil = db.prepare(`SELECT cpf, nome, criado_em FROM depop_perfil WHERE user_id = ?`).get(req.user.user_id);
  const cadastrado = !!perfil;
  // Só passa pelo cadastro de 1º acesso (CPF) quem vai VALIDAR: master (supervisor),
  // usuário só-comunicados e consulta (só leitura) não assinam, então não precisam.
  const precisa_setup = !caps.is_master && !caps.is_consulta && caps.pode_validar && !cadastrado;
  const cpfMasc = perfil ? perfil.cpf.replace(/^(\d{3})\d{6}(\d{2})$/, '$1.***.**-$2') : null;
  res.json({ cadastrado, precisa_setup, perfil: ferramenta, caps, nome: req.user.username,
             nome_titular: perfil ? perfil.nome : null,
             cpf_mascarado: cpfMasc, criado_em: perfil ? perfil.criado_em : null });
});

// Cadastro de 1º acesso: CPF (validado) + senha de assinatura → gera e guarda o
// par de chaves. Só uma vez por usuário; CPF é único no módulo.
app.post('/api/depop/perfil', async (req, res) => {
  const { cpf } = req.body || {};
  const ja = db.prepare(`SELECT 1 FROM depop_perfil WHERE user_id = ?`).get(req.user.user_id);
  if (ja) return res.status(400).json({ error: 'Perfil já configurado' });
  const cpfLimpo = String(cpf || '').replace(/\D/g, '');
  if (!cpfValido(cpfLimpo)) return res.status(400).json({ error: 'CPF inválido' });
  const donoCpf = db.prepare(`SELECT user_id FROM depop_perfil WHERE cpf = ?`).get(cpfLimpo);
  if (donoCpf) return res.status(400).json({ error: 'Este CPF já está cadastrado por outro usuário' });

  // Confirma o CPF na API e captura o nome (cai pra offline se a API não responder).
  const info = await consultarCpfApi(cpfLimpo);
  if (info.fonte === 'api' && info.existe === false) {
    return res.status(400).json({ error: 'CPF não encontrado na base da Receita.' });
  }
  const nome = info.nome || null;

  // Sem par de chaves: a assinatura da validação usa a senha de login + timbre.
  // As colunas chave_* (NOT NULL, legado) ficam vazias.
  db.prepare(`INSERT INTO depop_perfil (user_id, cpf, chave_publica, chave_privada_pem, nome) VALUES (?, ?, '', '', ?)`)
    .run(req.user.user_id, cpfLimpo, nome);
  registrarLog(req, 'DEPOP', 'PERFIL', `Cadastrou CPF no Depop${info.fonte === 'offline' ? ' (validado offline)' : ''}`);
  res.status(201).json({ ok: true, nome });
});

// ── Depop: ferramenta de validação de contratos ───────────────────────────────
// Confere, contrato a contrato, os dados vindos das planilhas (carregados no
// depop.db, só leitura). Cada validação fica assinada; o registro vive no
// secop.db (validacao_contrato). Concorrência: um contrato aberto por um
// validador trava os demais (validacao_lock, com heartbeat).

const LOCK_TTL_SEG = 120; // trava sem ping por mais que isso = abandonada (libera)

// Supervisor (o usuário 'master' da plataforma): só lê e exporta PDF, nunca
// assina nem marca erro. Todos os demais usuários do Depop são validadores.
function perfilFerramenta(req) {
  return req.user.username === 'master' ? 'master' : 'validador';
}

// Capacidades do usuário DENTRO do módulo Depop (o acesso ao módulo em si é por
// user_modulos). master = tudo. Sem linha em depop_acesso = padrão histórico
// (valida contratos, sem comunicados) — não quebra quem já usava a validação.
function depopCaps(req) {
  if (req.user.username === 'master') return { is_master: true, is_consulta: false, pode_validar: true, pode_comunicados: true };
  // Consulta (somente leitura) enxerga as duas seções, mas as ações são barradas
  // pela guarda global de leitura — aqui só liberamos a VISUALIZAÇÃO.
  if (req.user.role === 'consulta') return { is_master: false, is_consulta: true, pode_validar: true, pode_comunicados: true };
  const row = db.prepare(`SELECT valida, comunicados FROM depop_acesso WHERE user_id = ?`).get(req.user.user_id);
  return { is_master: false, is_consulta: false, pode_validar: row ? !!row.valida : true, pode_comunicados: row ? !!row.comunicados : false };
}

// Guarda de rota por capacidade ('valida' | 'comunicados'). O master e o consulta
// passam sempre (consulta só lê; as escritas caem na guarda global de leitura).
function requireCap(cap) {
  const chave = cap === 'valida' ? 'pode_validar' : 'pode_comunicados';
  return (req, res, next) => {
    if (req.user.role === 'consulta') return next();
    const c = depopCaps(req);
    if (c.is_master || c[chave]) return next();
    return res.status(403).json({ error: 'Você não tem essa permissão no Depop.' });
  };
}

// Trava ativa (com ping recente) de um contrato, ou null se livre/abandonada.
function travaAtiva(idAvaliacao) {
  const l = db.prepare(`
    SELECT id_avaliacao, user_id, nome,
           CAST((julianday('now') - julianday(ultimo_ping)) * 86400 AS INTEGER) AS idade
    FROM validacao_lock WHERE id_avaliacao = ?`).get(idAvaliacao);
  if (!l || l.idade > LOCK_TTL_SEG) return null;
  return l;
}

// Detalhe completo de um contrato: resumo (do concessionário) + linhas de tarifa
// + estado de validação. Lê o depop.db (referência) e o secop.db (validação).
function montarDetalhe(idAvaliacao) {
  const a = depopDb.prepare(`
    SELECT a.id, a.id_contrato, a.codigo, a.concessionaria, a.numero_ccu,
           a.data_vencimento, a.valor_ponto, a.valor_30_ceasa, a.Status,
           cli.cliente, cli.endereco AS endereco, cli.cpf_cnpj, cli.insc_estadual,
           cli.bairro, cli.cep, c.descricao AS cidade
    FROM AvaliacaoAreaRenovacao a
    LEFT JOIN ClienteConcessionario cli ON cli.codigo = a.codigo
    LEFT JOIN Cidade c ON c.id = a.id_cidade
    WHERE a.id = ?`).get(idAvaliacao);
  if (!a) return null;
  const linhas = depopDb.prepare(`
    SELECT sequencial, concessionario, endereco, area_m2, atual_tarifa_uso, nova_tarifa_uso
    FROM TarifaContrato20Anos WHERE id_contrato = ? ORDER BY sequencial`).all(a.id_contrato);
  const v = db.prepare(`
    SELECT vc.status, vc.observacao, vc.dt_validacao, vc.hash_assinatura,
           COALESCE(dp.nome, u.username) AS validador
    FROM validacao_contrato vc
    LEFT JOIN users u ON u.id = vc.id_usuario_validador
    LEFT JOIN depop_perfil dp ON dp.user_id = vc.id_usuario_validador
    WHERE vc.id_avaliacao = ?`).get(idAvaliacao);
  return {
    id: a.id, id_contrato: a.id_contrato, codigo: a.codigo,
    concessionario: a.cliente || a.concessionaria, endereco: a.endereco,
    cpf_cnpj: a.cpf_cnpj, insc_estadual: a.insc_estadual, bairro: a.bairro, cep: a.cep,
    cidade: a.cidade, numero_ccu: a.numero_ccu, data_vencimento: a.data_vencimento,
    valor_ponto: a.valor_ponto, valor_30_ceasa: a.valor_30_ceasa, reg_status: a.Status,
    linhas,
    validacao: v || { status: 'pendente' }
  };
}

// String canônica que é de fato assinada — decimais fixados em 2 casas pra ser
// estável entre execuções (base do não-repúdio: o que o validador conferiu).
function payloadContrato(det, cpf, iso) {
  return JSON.stringify({
    id_contrato: det.id_contrato,
    valor_ponto: Number(det.valor_ponto || 0).toFixed(2),
    valor_30_ceasa: Number(det.valor_30_ceasa || 0).toFixed(2),
    linhas: det.linhas.map(l => ({
      seq: l.sequencial,
      area: Number(l.area_m2 || 0).toFixed(2),
      atual: Number(l.atual_tarifa_uso || 0).toFixed(2),
      nova: Number(l.nova_tarifa_uso || 0).toFixed(2)
    })),
    cpf, dt: iso
  });
}

// Indicadores da tela inicial.
app.get('/api/depop/dashboard', (req, res) => {
  const totalContratos = depopDb.prepare(`SELECT COUNT(*) c FROM AvaliacaoAreaRenovacao`).get().c;
  const totalConcess   = depopDb.prepare(`SELECT COUNT(DISTINCT codigo) c FROM AvaliacaoAreaRenovacao`).get().c;
  const linhasAgg = depopDb.prepare(`
    SELECT COUNT(*) total, COALESCE(SUM(area_m2),0) area,
           COALESCE(AVG(atual_tarifa_uso),0) ma, COALESCE(AVG(nova_tarifa_uso),0) mn
    FROM TarifaContrato20Anos`).get();
  const semLinha = depopDb.prepare(`
    SELECT COUNT(*) c FROM AvaliacaoAreaRenovacao a
    WHERE NOT EXISTS (SELECT 1 FROM TarifaContrato20Anos t WHERE t.id_contrato = a.id_contrato)`).get().c;

  const sc = { validado: 0, errado: 0 };
  for (const r of db.prepare(`SELECT status, COUNT(*) c FROM validacao_contrato GROUP BY status`).all()) {
    if (r.status in sc) sc[r.status] = r.c;
  }
  const validados = sc.validado, errados = sc.errado;
  const emAberto = totalContratos - validados - errados;
  const pct = totalContratos ? Math.round((validados / totalContratos) * 1000) / 10 : 0;

  const cidades = depopDb.prepare(`
    SELECT c.id, c.descricao AS cidade, COUNT(*) contratos, COUNT(DISTINCT a.codigo) concessionarios
    FROM AvaliacaoAreaRenovacao a JOIN Cidade c ON c.id = a.id_cidade
    GROUP BY c.id, c.descricao ORDER BY contratos DESC`).all();

  // % de validação por cidade (cruzando cidade do depop.db com status do secop.db)
  const avalCidade = depopDb.prepare(`SELECT id, id_cidade FROM AvaliacaoAreaRenovacao`).all();
  const vmap = new Map(db.prepare(`SELECT id_avaliacao, status FROM validacao_contrato`).all().map(r => [r.id_avaliacao, r.status]));
  const porCid = new Map();
  for (const a of avalCidade) {
    const o = porCid.get(a.id_cidade) || { total: 0, val: 0 };
    o.total++;
    if (vmap.get(a.id) === 'validado') o.val++;
    porCid.set(a.id_cidade, o);
  }
  const ranking = cidades.map(c => {
    const o = porCid.get(c.id) || { total: 0, val: 0 };
    return { cidade: c.cidade, pct: o.total ? Math.round((o.val / o.total) * 1000) / 10 : 0 };
  }).sort((x, y) => x.pct - y.pct).slice(0, 3);

  res.json({
    total_contratos: totalContratos, total_concessionarios: totalConcess,
    validados, errados, em_aberto: emAberto, pct_validacao: pct,
    total_linhas: linhasAgg.total, metragem_total: linhasAgg.area,
    media_tarifa_atual: linhasAgg.ma, media_tarifa_nova: linhasAgg.mn,
    sem_linha: semLinha,
    media_linhas_por_contrato: totalContratos ? Math.round((linhasAgg.total / totalContratos) * 10) / 10 : 0,
    por_cidade: cidades, ranking_pior: ranking
  });
});

// Lista completa (o front filtra por aba/cidade/busca e agrupa por concessionário).
app.get('/api/depop/contratos', (req, res) => {
  const avals = depopDb.prepare(`
    SELECT a.id, a.id_contrato, a.codigo, a.numero_ccu, a.valor_ponto, a.valor_30_ceasa,
           a.Status AS reg_status, a.concessionaria, cli.cliente, c.descricao AS cidade
    FROM AvaliacaoAreaRenovacao a
    LEFT JOIN ClienteConcessionario cli ON cli.codigo = a.codigo
    LEFT JOIN Cidade c ON c.id = a.id_cidade
    ORDER BY c.descricao, cli.cliente, a.id_contrato`).all();

  const vmap = new Map(db.prepare(`SELECT id_avaliacao, status FROM validacao_contrato`).all().map(r => [r.id_avaliacao, r.status]));
  const lockMap = new Map();
  for (const l of db.prepare(`
    SELECT id_avaliacao, user_id, nome,
           CAST((julianday('now') - julianday(ultimo_ping)) * 86400 AS INTEGER) AS idade
    FROM validacao_lock`).all()) {
    if (l.idade <= LOCK_TTL_SEG) lockMap.set(l.id_avaliacao, l);
  }

  const contratos = avals.map(a => {
    const lk = lockMap.get(a.id);
    return {
      id: a.id, id_contrato: a.id_contrato, codigo: a.codigo,
      concessionario: a.cliente || a.concessionaria || '—', cidade: a.cidade || '—',
      numero_ccu: a.numero_ccu, valor_ponto: a.valor_ponto, valor_30_ceasa: a.valor_30_ceasa,
      reg_status: a.reg_status,
      status: vmap.get(a.id) || 'pendente',
      lock: lk ? { nome: lk.nome, por_mim: lk.user_id === req.user.user_id } : null
    };
  });
  res.json({ perfil: perfilFerramenta(req), contratos });
});

// Abre o preview de um contrato. Validador toma a trava (ou 409 se estiver com
// outro); supervisor só visualiza, sem travar e sem ser travado.
app.post('/api/depop/contratos/:id/abrir', requireCap('valida'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const det = montarDetalhe(id);
  if (!det) return res.status(404).json({ error: 'Contrato não encontrado' });

  // Contrato já validado é final: abre só em leitura, sem travar (nem pra quem
  // for validador) — não dá mais pra assinar nem marcar erro.
  if (det.validacao && det.validacao.status === 'validado') {
    return res.json({ perfil: perfilFerramenta(req), detalhe: det, lock: null });
  }
  // Consulta (só leitura) e supervisor (master): abrem em leitura, sem travar.
  if (req.user.role === 'consulta') {
    return res.json({ perfil: 'consulta', detalhe: det, lock: null });
  }
  if (perfilFerramenta(req) === 'master') {
    return res.json({ perfil: 'master', detalhe: det, lock: null });
  }
  const trava = travaAtiva(id);
  if (trava && trava.user_id !== req.user.user_id) {
    return res.status(409).json({ error: `Contrato em uso por ${trava.nome || 'outro validador'}.`, em_uso_por: trava.nome });
  }
  db.prepare(`
    INSERT INTO validacao_lock (id_avaliacao, user_id, nome, aberto_em, ultimo_ping)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id_avaliacao) DO UPDATE SET
      user_id = excluded.user_id, nome = excluded.nome, ultimo_ping = datetime('now')`)
    .run(id, req.user.user_id, req.user.username);
  res.json({ perfil: 'validador', detalhe: det, lock: { por_mim: true } });
});

// Heartbeat da trava enquanto o preview está aberto.
app.post('/api/depop/contratos/:id/ping', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const info = db.prepare(`UPDATE validacao_lock SET ultimo_ping = datetime('now') WHERE id_avaliacao = ? AND user_id = ?`)
    .run(id, req.user.user_id);
  res.json({ ok: info.changes > 0 });
});

// Libera a trava ao fechar o preview.
app.post('/api/depop/contratos/:id/fechar', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare(`DELETE FROM validacao_lock WHERE id_avaliacao = ? AND user_id = ?`).run(id, req.user.user_id);
  res.json({ ok: true });
});

// Confirmar e assinar: assina o payload canônico com a chave do validador
// (destravada pela senha de assinatura) e grava status 'validado' + timbre.
app.post('/api/depop/contratos/:id/validar', requireCap('valida'), (req, res) => {
  if (perfilFerramenta(req) === 'master') return res.status(403).json({ error: 'O supervisor não assina validações.' });
  const id = parseInt(req.params.id, 10);
  const { senha } = req.body || {};

  const trava = travaAtiva(id);
  if (trava && trava.user_id !== req.user.user_id) {
    return res.status(409).json({ error: `Contrato em uso por ${trava.nome || 'outro validador'}.` });
  }
  const det = montarDetalhe(id);
  if (!det) return res.status(404).json({ error: 'Contrato não encontrado' });
  if (det.validacao && det.validacao.status === 'validado') {
    return res.status(409).json({ error: 'Este contrato já foi validado e não pode ser assinado novamente.' });
  }

  const perfil = db.prepare(`SELECT cpf, nome FROM depop_perfil WHERE user_id = ?`).get(req.user.user_id);
  if (!perfil) return res.status(400).json({ error: 'Cadastre seu CPF antes de validar.' });
  if (!senha) return res.status(400).json({ error: 'Informe sua senha para assinar.' });

  // Confirma com a senha de LOGIN do próprio usuário (uma senha só no sistema).
  const u = db.prepare(`SELECT senha_hash, salt FROM users WHERE id = ?`).get(req.user.user_id);
  const h = crypto.pbkdf2Sync(String(senha), u.salt, 100000, 64, 'sha512').toString('hex');
  if (h !== u.senha_hash) return res.status(401).json({ error: 'Senha incorreta.' });

  const iso = new Date().toISOString();
  const nome = perfil.nome || req.user.username;
  // Timbre verificável: hash dos valores conferidos (payload canônico) + a
  // identidade de quem assinou + o instante. Recalculável para conferência.
  const timbre = crypto.createHash('sha256')
    .update(`${payloadContrato(det, perfil.cpf, iso)}|${nome}|${req.user.username}`)
    .digest('hex');

  db.prepare(`
    INSERT INTO validacao_contrato (id_avaliacao, status, observacao, id_usuario_validador, dt_validacao, hash_assinatura, assinatura_b64)
    VALUES (?, 'validado', NULL, ?, ?, ?, NULL)
    ON CONFLICT(id_avaliacao) DO UPDATE SET
      status = 'validado', observacao = NULL, id_usuario_validador = excluded.id_usuario_validador,
      dt_validacao = excluded.dt_validacao, hash_assinatura = excluded.hash_assinatura,
      assinatura_b64 = NULL`)
    .run(id, req.user.user_id, iso, timbre);
  db.prepare(`DELETE FROM validacao_lock WHERE id_avaliacao = ?`).run(id);
  registrarLog(req, 'DEPOP', 'VALIDOU', `Validou contrato CCU ${det.numero_ccu || det.id_contrato}`);
  res.json({ ok: true, timbre: timbre.slice(0, 12), dt_validacao: iso, validador: nome });
});

// Marcar como errado: grava o motivo (observação) e status 'errado'.
app.post('/api/depop/contratos/:id/errado', requireCap('valida'), (req, res) => {
  if (perfilFerramenta(req) === 'master') return res.status(403).json({ error: 'O supervisor não marca erros.' });
  const id = parseInt(req.params.id, 10);
  const obs = String((req.body && req.body.observacao) || '').trim();
  if (!obs) return res.status(400).json({ error: 'Descreva o motivo do erro.' });

  const trava = travaAtiva(id);
  if (trava && trava.user_id !== req.user.user_id) {
    return res.status(409).json({ error: `Contrato em uso por ${trava.nome || 'outro validador'}.` });
  }
  const det = montarDetalhe(id);
  if (!det) return res.status(404).json({ error: 'Contrato não encontrado' });
  if (det.validacao && det.validacao.status === 'validado') {
    return res.status(409).json({ error: 'Este contrato já foi validado — não pode ser marcado como errado.' });
  }

  const iso = new Date().toISOString();
  db.prepare(`
    INSERT INTO validacao_contrato (id_avaliacao, status, observacao, id_usuario_validador, dt_validacao, hash_assinatura, assinatura_b64)
    VALUES (?, 'errado', ?, ?, ?, NULL, NULL)
    ON CONFLICT(id_avaliacao) DO UPDATE SET
      status = 'errado', observacao = excluded.observacao, id_usuario_validador = excluded.id_usuario_validador,
      dt_validacao = excluded.dt_validacao, hash_assinatura = NULL, assinatura_b64 = NULL`)
    .run(id, obs, req.user.user_id, iso);
  db.prepare(`DELETE FROM validacao_lock WHERE id_avaliacao = ?`).run(id);
  registrarLog(req, 'DEPOP', 'ERRO', `Marcou erro no contrato CCU ${det.numero_ccu || det.id_contrato}: ${obs.slice(0, 120)}`);
  res.json({ ok: true });
});

// Cancelar assinatura (só supervisor/master): desfaz uma validação já assinada e
// devolve o contrato para 'pendente', permitindo nova conferência/assinatura. É
// uma ação sensível sobre um registro assinado — exige a senha de login do master
// e um motivo, e fica registrada no log. Se já havia comunicado gerado, avisa.
app.post('/api/depop/contratos/:id/cancelar-validacao', requireCap('valida'), (req, res) => {
  if (perfilFerramenta(req) !== 'master') return res.status(403).json({ error: 'Apenas o supervisor pode cancelar uma assinatura.' });
  const id = parseInt(req.params.id, 10);
  const { senha, motivo } = req.body || {};
  const just = String(motivo || '').trim();
  if (!senha) return res.status(400).json({ error: 'Informe sua senha para cancelar a assinatura.' });
  if (!just) return res.status(400).json({ error: 'Descreva o motivo do cancelamento.' });

  const v = db.prepare(`SELECT status FROM validacao_contrato WHERE id_avaliacao = ?`).get(id);
  if (!v || v.status !== 'validado') return res.status(409).json({ error: 'Este contrato não está assinado.' });

  // Confirma com a senha de LOGIN do próprio master (mesma regra da assinatura).
  const u = db.prepare(`SELECT senha_hash, salt FROM users WHERE id = ?`).get(req.user.user_id);
  const h = crypto.pbkdf2Sync(String(senha), u.salt, 100000, 64, 'sha512').toString('hex');
  if (h !== u.senha_hash) return res.status(401).json({ error: 'Senha incorreta.' });

  const det = montarDetalhe(id);
  const com = db.prepare(`SELECT geracoes FROM comunicado_gerado WHERE id_avaliacao = ?`).get(id);
  const alerta = !!(com && com.geracoes > 0);

  // Remove a validação → volta para 'pendente'; solta qualquer trava pendente.
  db.prepare(`DELETE FROM validacao_contrato WHERE id_avaliacao = ?`).run(id);
  db.prepare(`DELETE FROM validacao_lock WHERE id_avaliacao = ?`).run(id);

  const ref = det ? (det.numero_ccu || det.id_contrato) : id;
  registrarLog(req, 'DEPOP', 'CANCELOU_VALIDACAO', `Cancelou assinatura do contrato CCU ${ref}: ${just.slice(0, 160)}${alerta ? ' [ATENÇÃO: comunicado já havia sido gerado]' : ''}`);
  res.json({ ok: true, comunicado_alerta: alerta });
});

// Exportação em massa (supervisor): devolve os detalhes de todos os contratos do
// filtro para o front montar um PDF único (impressão do navegador).
app.get('/api/depop/exportar', (req, res) => {
  if (perfilFerramenta(req) !== 'master') return res.status(403).json({ error: 'Exportação em massa restrita ao supervisor.' });
  const { status, cidade } = req.query;
  const avals = depopDb.prepare(`
    SELECT a.id, c.descricao AS cidade FROM AvaliacaoAreaRenovacao a
    LEFT JOIN Cidade c ON c.id = a.id_cidade ORDER BY c.descricao, a.id_contrato`).all();
  const vmap = new Map(db.prepare(`SELECT id_avaliacao, status FROM validacao_contrato`).all().map(r => [r.id_avaliacao, r.status]));
  const ids = avals.filter(a => {
    if (cidade && String(a.cidade || '') !== cidade) return false;
    if (status && (vmap.get(a.id) || 'pendente') !== status) return false;
    return true;
  }).map(a => a.id);
  const detalhes = ids.map(id => montarDetalhe(id)).filter(Boolean);
  registrarLog(req, 'DEPOP', 'EXPORTOU', `Exportou ${detalhes.length} contrato(s) em PDF`);
  res.json({ detalhes });
});

// ── Comunicados oficiais (Setor de Cadastro / Depto de Operações) ─────────────
// Notifica cada concessionário elegível da prorrogação antecipada, com as
// credenciais de acesso à plataforma de adesão. Um comunicado por CONTRATO
// (login/senha se repetem entre contratos do mesmo concessionário; CCU, área e
// vencimento são de cada contrato). Perfil por capacidade: requireCap('comunicados').

// Prazo final de adesão pela regra do TCC/edital, pelo ano de vencimento. Fora do
// intervalo previsto (2027–2032) → não gera (retorna null; o chamador bloqueia).
function prazoFinalAdesao(ano) {
  if (ano === 2027) return '30/10/2026';
  if (ano >= 2028 && ano <= 2032) return '18/12/2026';
  return null;
}
const DATA_INICIO_ADESAO = '17/08/2026'; // fixa pra todos (consta no próprio modelo)

function paramSistema(chave, padrao) {
  const r = db.prepare(`SELECT valor FROM parametro_sistema WHERE chave = ?`).get(chave);
  return r && r.valor != null ? r.valor : padrao;
}

// Monta os dados de UM comunicado (um contrato). {ok:false, motivo} quando não
// pode gerar (ano fora do intervalo, ou sem credencial) — nunca gera carta sem
// login/senha. A URL vem SEMPRE do parametro_sistema (nunca fixa no código).
function montarComunicado(idAvaliacao) {
  const a = depopDb.prepare(`
    SELECT a.id, a.codigo, a.numero_ccu, a.data_vencimento, a.endereco AS area,
           cli.cliente, cli.endereco AS endereco,
           x.login, x.name AS acess_name, x.codeaccess
    FROM AvaliacaoAreaRenovacao a
    LEFT JOIN ClienteConcessionario cli ON cli.codigo = a.codigo
    LEFT JOIN concessionario_acess x ON x.codigo = a.codigo
    WHERE a.id = ?`).get(idAvaliacao);
  if (!a) return { ok: false, id: idAvaliacao, motivo: 'nao_encontrado', label: 'Contrato não encontrado' };
  const ano = parseInt(String(a.data_vencimento || '').slice(0, 4), 10);
  const prazo = prazoFinalAdesao(ano);
  const base = { id: a.id, ccu: a.numero_ccu, concessionario: a.cliente };
  if (!prazo) return { ...base, ok: false, motivo: 'ano_fora',
                       label: `Ano de vencimento ${ano || '?'} fora do intervalo previsto (2027–2032) — verificar dado antes de gerar` };
  if (!a.login || !a.codeaccess) return { ...base, ok: false, motivo: 'sem_credencial',
                       label: 'Concessionário sem credencial de acesso — não é possível gerar' };
  // Só gera comunicado de contrato JÁ VALIDADO (assinado na ferramenta de
  // validação). O comunicado carrega credenciais oficiais — não sai antes de a
  // conferência estar concluída.
  const v = db.prepare(`SELECT status FROM validacao_contrato WHERE id_avaliacao = ?`).get(idAvaliacao);
  if (!v || v.status !== 'validado') return { ...base, ok: false, motivo: 'nao_validado',
                       label: 'Contrato ainda não foi validado — valide antes de gerar o comunicado' };
  return { ok: true, comunicado: {
    id: a.id, codigo: a.codigo,
    numero_comunicado: paramSistema('numero_comunicado', '01/2026'),
    // Nº do protocolo = código do concessionário / CCU do contrato. Vem direto do
    // contrato (código+CCU é único, 443/443), então é sempre estável — sem contador.
    protocolo_numero: `${a.codigo}/${a.numero_ccu || '—'}`,
    empresa: a.cliente || a.acess_name || '—',
    cnpj: a.login,
    endereco: a.endereco || '—',
    numero_ccu: a.numero_ccu || '—',
    area: a.area || '—',
    ano_vencimento: ano,
    data_inicio: DATA_INICIO_ADESAO,
    prazo_final: prazo,
    url_acesso: paramSistema('url_plataforma_acesso', 'A DEFINIR'),
    login: a.login,
    senha: a.codeaccess
  } };
}

// Lista para a tela: todos os contratos com elegibilidade + contador de gerações
// e status de entrega. O front agrupa por cidade → concessionário.
app.get('/api/depop/comunicados/lista', requireCap('comunicados'), (req, res) => {
  const avals = depopDb.prepare(`
    SELECT a.id, a.codigo, a.numero_ccu, a.data_vencimento, a.endereco AS area,
           cli.cliente, c.descricao AS cidade,
           CASE WHEN x.codigo IS NULL THEN 0 ELSE 1 END AS tem_credencial
    FROM AvaliacaoAreaRenovacao a
    LEFT JOIN ClienteConcessionario cli ON cli.codigo = a.codigo
    LEFT JOIN Cidade c ON c.id = a.id_cidade
    LEFT JOIN concessionario_acess x ON x.codigo = a.codigo
    ORDER BY c.descricao, cli.cliente, a.numero_ccu`).all();
  const gmap = new Map(db.prepare(`SELECT id_avaliacao, geracoes, ultima_geracao, enviado, dt_envio FROM comunicado_gerado`)
    .all().map(r => [r.id_avaliacao, r]));
  const vmap = new Map(db.prepare(`SELECT id_avaliacao, status FROM validacao_contrato`)
    .all().map(r => [r.id_avaliacao, r.status]));
  const cmap = new Map(anexosDb.prepare(`SELECT id_avaliacao, COUNT(*) n FROM comprovante_entrega GROUP BY id_avaliacao`)
    .all().map(r => [r.id_avaliacao, r.n]));
  const contratos = avals.map(a => {
    const ano = parseInt(String(a.data_vencimento || '').slice(0, 4), 10);
    const prazo = prazoFinalAdesao(ano);
    const g = gmap.get(a.id) || {};
    const validado = vmap.get(a.id) === 'validado';
    const entregue = !!g.enviado;
    // Gerável só quando: ano no intervalo E tem credencial E já validado E ainda
    // NÃO entregue. Motivo por prioridade: dado errado > falta credencial > falta
    // validar > já entregue (entrega finaliza; só o master reabre).
    // `viewable` = é um comunicado válido (dá pra ver na tela), mesmo se entregue.
    const viewable = !!prazo && !!a.tem_credencial && validado;
    let elegivel = true, motivo = null;
    if (!prazo) { elegivel = false; motivo = 'ano_fora'; }
    else if (!a.tem_credencial) { elegivel = false; motivo = 'sem_credencial'; }
    else if (!validado) { elegivel = false; motivo = 'nao_validado'; }
    else if (entregue) { elegivel = false; motivo = 'entregue'; }
    return {
      id: a.id, codigo: a.codigo, concessionario: a.cliente || '—', cidade: a.cidade || '—',
      numero_ccu: a.numero_ccu || '—', area: a.area || '—', ano_vencimento: ano || null,
      prazo_final: prazo, no_intervalo: !!prazo, tem_credencial: !!a.tem_credencial,
      validado, elegivel, viewable, motivo,
      geracoes: g.geracoes || 0, ultima_geracao: g.ultima_geracao || null,
      enviado: !!g.enviado, dt_envio: g.dt_envio || null,
      comprovantes: cmap.get(a.id) || 0
    };
  });
  const cidades = [...new Set(contratos.map(c => c.cidade))].sort();
  res.json({ caps: depopCaps(req), url_definida: paramSistema('url_plataforma_acesso', 'A DEFINIR') !== 'A DEFINIR',
             contratos, cidades });
});

// Geração: resolve o conjunto de contratos (por cidade, por concessionário, ou
// seleção múltipla), monta os comunicados elegíveis e registra a geração
// (incrementa o contador). Contratos fora do intervalo/sem credencial voltam em
// `pulados` (nunca falha em silêncio).
app.post('/api/depop/comunicados/gerar', requireCap('comunicados'), (req, res) => {
  const { cidade, codigo, codigos } = req.query;
  let rows;
  if (codigo) {
    rows = depopDb.prepare(`SELECT id FROM AvaliacaoAreaRenovacao WHERE codigo = ? ORDER BY numero_ccu`).all(parseInt(codigo, 10));
  } else if (codigos) {
    const lista = String(codigos).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
    if (!lista.length) return res.status(400).json({ error: 'Nenhum concessionário selecionado.' });
    const ph = lista.map(() => '?').join(',');
    rows = depopDb.prepare(`SELECT id FROM AvaliacaoAreaRenovacao WHERE codigo IN (${ph}) ORDER BY codigo, numero_ccu`).all(...lista);
  } else if (cidade) {
    rows = depopDb.prepare(`SELECT a.id FROM AvaliacaoAreaRenovacao a LEFT JOIN Cidade c ON c.id = a.id_cidade
                            WHERE c.descricao = ? ORDER BY a.numero_ccu`).all(String(cidade));
  } else {
    return res.status(400).json({ error: 'Informe cidade, concessionário ou seleção.' });
  }

  // Entrega finalizada trava a geração: comunicado entregue não sai de novo.
  // Só o master libera (cancelar-entrega). Fica em `pulados` com motivo 'entregue'.
  const entregues = new Set(
    db.prepare(`SELECT id_avaliacao FROM comunicado_gerado WHERE enviado = 1`).all().map(r => r.id_avaliacao)
  );
  const comunicados = [], pulados = [];
  for (const r of rows) {
    const m = montarComunicado(r.id);
    if (!m.ok) { pulados.push({ id: m.id, ccu: m.ccu, concessionario: m.concessionario, motivo: m.motivo, label: m.label }); continue; }
    if (entregues.has(m.comunicado.id)) {
      pulados.push({ id: m.comunicado.id, ccu: m.comunicado.numero_ccu, concessionario: m.comunicado.empresa,
        motivo: 'entregue', label: 'Entrega já finalizada — cancele a entrega (supervisor) para gerar novamente' });
      continue;
    }
    comunicados.push(m.comunicado);
  }

  // Separa 1ª geração de REGERAÇÃO (2ª via em diante): quem já tinha geracoes>0
  // antes deste POST é regeração. Serve pra mensagem no front e pro log distinto.
  const jaGerados = new Set(
    db.prepare(`SELECT id_avaliacao FROM comunicado_gerado WHERE geracoes > 0`).all().map(r => r.id_avaliacao)
  );
  const novos = comunicados.filter(c => !jaGerados.has(c.id));
  const regerados = comunicados.filter(c => jaGerados.has(c.id));

  // Contador de gerações + timestamps, por contrato efetivamente gerado.
  const iso = new Date().toISOString();
  const up = db.prepare(`
    INSERT INTO comunicado_gerado (id_avaliacao, geracoes, primeira_geracao, ultima_geracao, gerado_por)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(id_avaliacao) DO UPDATE SET
      geracoes = geracoes + 1, ultima_geracao = excluded.ultima_geracao, gerado_por = excluded.gerado_por`);
  for (const c of comunicados) up.run(c.id, iso, iso, req.user.user_id);

  if (novos.length) {
    registrarLog(req, 'DEPOP', 'COMUNICADO_GEROU',
      `Gerou ${novos.length} comunicado(s) (1ª via)${pulados.length ? ` — ${pulados.length} pulado(s)` : ''}`);
  }
  if (regerados.length) {
    registrarLog(req, 'DEPOP', 'COMUNICADO_REGEROU',
      `Regerou ${regerados.length} comunicado(s) (2ª via+): CCU ${regerados.map(c => c.numero_ccu).filter(Boolean).join(', ').slice(0, 200)}`);
  }
  res.json({ comunicados, pulados, novos: novos.length, regerados: regerados.length });
});

// Controle de entrega (manual, separado da geração). Só marca quem já foi gerado.
app.post('/api/depop/comunicados/:id/enviado', requireCap('comunicados'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const enviado = !!(req.body && req.body.enviado);
  const row = db.prepare(`SELECT geracoes FROM comunicado_gerado WHERE id_avaliacao = ?`).get(id);
  if (!row || !row.geracoes) return res.status(400).json({ error: 'Gere o comunicado antes de marcar a entrega.' });
  const iso = enviado ? new Date().toISOString() : null;
  db.prepare(`UPDATE comunicado_gerado SET enviado = ?, dt_envio = ? WHERE id_avaliacao = ?`).run(enviado ? 1 : 0, iso, id);
  registrarLog(req, 'DEPOP', 'COMUNICADO_ENTREGA', `Comunicado ${id} marcado como ${enviado ? 'enviado' : 'não enviado'}`);
  res.json({ ok: true, enviado, dt_envio: iso });
});

// Cancelar a entrega (só supervisor/master): desfaz a entrega finalizada,
// removendo os comprovantes e liberando o comunicado para gerar/imprimir de novo.
// Igual ao cancelar assinatura — exige a senha de login do master e um motivo.
app.post('/api/depop/comunicados/:id/cancelar-entrega', requireCap('comunicados'), (req, res) => {
  if (perfilFerramenta(req) !== 'master') return res.status(403).json({ error: 'Apenas o supervisor pode cancelar a entrega.' });
  const id = parseInt(req.params.id, 10);
  const { senha, motivo } = req.body || {};
  const just = String(motivo || '').trim();
  if (!senha) return res.status(400).json({ error: 'Informe sua senha para cancelar a entrega.' });
  if (!just) return res.status(400).json({ error: 'Descreva o motivo do cancelamento.' });

  const row = db.prepare(`SELECT enviado FROM comunicado_gerado WHERE id_avaliacao = ?`).get(id);
  if (!row || !row.enviado) return res.status(409).json({ error: 'Este comunicado não está com a entrega finalizada.' });

  // Confirma com a senha de LOGIN do próprio master (mesma regra da assinatura).
  const u = db.prepare(`SELECT senha_hash, salt FROM users WHERE id = ?`).get(req.user.user_id);
  const h = crypto.pbkdf2Sync(String(senha), u.salt, 100000, 64, 'sha512').toString('hex');
  if (h !== u.senha_hash) return res.status(401).json({ error: 'Senha incorreta.' });

  const nCompr = anexosDb.prepare(`SELECT COUNT(*) c FROM comprovante_entrega WHERE id_avaliacao = ?`).get(id).c;
  anexosDb.prepare(`DELETE FROM comprovante_entrega WHERE id_avaliacao = ?`).run(id);
  db.prepare(`UPDATE comunicado_gerado SET enviado = 0, dt_envio = NULL WHERE id_avaliacao = ?`).run(id);
  registrarLog(req, 'DEPOP', 'ENTREGA_CANCELOU', `Cancelou a entrega do comunicado do contrato ${id} (removeu ${nCompr} comprovante(s)): ${just.slice(0, 160)}`);
  res.json({ ok: true });
});

// Dados de UM comunicado (para reimprimir o comunicado ou o protocolo de entrega
// de um contrato específico, fora do fluxo de geração em massa). Devolve o mesmo
// objeto de montarComunicado (ok:false + motivo quando não é gerável).
app.get('/api/depop/comunicados/:id/dados', requireCap('comunicados'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.json(montarComunicado(id));
});

// ── Comprovantes de entrega (anexos.db) ──────────────────────────────────────
// A cópia assinada do comunicado que volta como prova de entrega. Guardada como
// BLOB no anexos.db. Imagens já chegam comprimidas do navegador; PDFs entram com
// teto de tamanho. Anexar marca o comunicado como entregue (enviado=1).
const COMPROVANTE_MIMES = ['image/jpeg', 'image/png', 'application/pdf'];
const COMPROVANTE_MAX = 10 * 1024 * 1024; // 10 MB por anexo (pós-compressão no cliente)

app.post('/api/depop/comunicados/:id/comprovante',
  requireCap('comunicados'),
  express.raw({ type: '*/*', limit: '12mb' }),
  (req, res) => {
    const id = parseInt(req.params.id, 10);
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const nome = String(req.query.nome || req.headers['x-file-name'] || 'comprovante').slice(0, 180);

    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      return res.status(400).json({ error: 'Arquivo vazio.' });
    if (!COMPROVANTE_MIMES.includes(mime))
      return res.status(415).json({ error: 'Formato não aceito. Envie imagem (JPG/PNG) ou PDF.' });
    if (req.body.length > COMPROVANTE_MAX)
      return res.status(413).json({ error: 'Arquivo muito grande (máx. 10 MB).' });

    const row = db.prepare(`SELECT geracoes FROM comunicado_gerado WHERE id_avaliacao = ?`).get(id);
    if (!row || !row.geracoes)
      return res.status(400).json({ error: 'Gere o comunicado antes de anexar o comprovante.' });

    const perfil = db.prepare(`SELECT nome FROM depop_perfil WHERE user_id = ?`).get(req.user.user_id);
    const nomeUsuario = (perfil && perfil.nome) || req.user.username;
    anexosDb.prepare(`
      INSERT INTO comprovante_entrega (id_avaliacao, nome_arquivo, mime, tamanho, conteudo, enviado_por, enviado_por_nome)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, nome, mime, req.body.length, req.body, req.user.user_id, nomeUsuario);

    // Anexar prova = entregue.
    const iso = new Date().toISOString();
    db.prepare(`UPDATE comunicado_gerado SET enviado = 1, dt_envio = ? WHERE id_avaliacao = ?`).run(iso, id);
    registrarLog(req, 'DEPOP', 'COMPROVANTE_ANEXOU', `Anexou comprovante de entrega ao comunicado do contrato ${id} (${nome})`);
    res.json({ ok: true });
  }
);

// Lista os comprovantes de um contrato (metadados, sem o BLOB).
app.get('/api/depop/comunicados/:id/comprovantes', requireCap('comunicados'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = anexosDb.prepare(`
    SELECT id, nome_arquivo, mime, tamanho, enviado_por_nome, criado_em
    FROM comprovante_entrega WHERE id_avaliacao = ? ORDER BY criado_em DESC, id DESC`).all(id);
  res.json({ comprovantes: rows });
});

// Baixa/visualiza um comprovante (o BLOB). GET → consulta também pode ver.
app.get('/api/depop/comprovante/:cid', requireCap('comunicados'), (req, res) => {
  const cid = parseInt(req.params.cid, 10);
  const row = anexosDb.prepare(`SELECT nome_arquivo, mime, conteudo FROM comprovante_entrega WHERE id = ?`).get(cid);
  if (!row) return res.status(404).json({ error: 'Comprovante não encontrado.' });
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.nome_arquivo || 'comprovante')}"`);
  res.send(Buffer.from(row.conteudo));
});

// Remove um comprovante. Se sobrar nenhum no contrato, desmarca a entrega.
// Entrega finalizada (enviado=1) só o master mexe — o comum usa o supervisor.
app.delete('/api/depop/comprovante/:cid', requireCap('comunicados'), (req, res) => {
  const cid = parseInt(req.params.cid, 10);
  const row = anexosDb.prepare(`SELECT id_avaliacao, nome_arquivo FROM comprovante_entrega WHERE id = ?`).get(cid);
  if (!row) return res.status(404).json({ error: 'Comprovante não encontrado.' });
  const g = db.prepare(`SELECT enviado FROM comunicado_gerado WHERE id_avaliacao = ?`).get(row.id_avaliacao);
  if (g && g.enviado && perfilFerramenta(req) !== 'master')
    return res.status(403).json({ error: 'Entrega finalizada — só o supervisor pode cancelar a entrega.' });
  anexosDb.prepare(`DELETE FROM comprovante_entrega WHERE id = ?`).run(cid);
  const restantes = anexosDb.prepare(`SELECT COUNT(*) c FROM comprovante_entrega WHERE id_avaliacao = ?`).get(row.id_avaliacao).c;
  if (restantes === 0) db.prepare(`UPDATE comunicado_gerado SET enviado = 0, dt_envio = NULL WHERE id_avaliacao = ?`).run(row.id_avaliacao);
  registrarLog(req, 'DEPOP', 'COMPROVANTE_REMOVEU', `Removeu comprovante do contrato ${row.id_avaliacao} (${row.nome_arquivo || ''})`);
  res.json({ ok: true, entregue: restantes > 0 });
});

// Parâmetros do sistema (parametro_sistema) — leitura/edição só do master.
app.get('/api/depop/parametros', (req, res) => {
  if (req.user.username !== 'master') return res.status(403).json({ error: 'Restrito ao master.' });
  const p = {};
  db.prepare(`SELECT chave, valor FROM parametro_sistema`).all().forEach(r => { p[r.chave] = r.valor; });
  res.json(p);
});
app.put('/api/depop/parametros', (req, res) => {
  if (req.user.username !== 'master') return res.status(403).json({ error: 'Restrito ao master.' });
  const entries = Object.entries(req.body || {});
  if (!entries.length) return res.status(400).json({ error: 'Nada para salvar.' });
  const up = db.prepare(`INSERT INTO parametro_sistema (chave, valor) VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`);
  entries.forEach(([k, v]) => up.run(k, String(v)));
  registrarLog(req, 'CONFIG', 'PARAM_SISTEMA', `Parâmetros do sistema: ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  res.json({ ok: true });
});

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

purgarLixeira();
setInterval(purgarLixeira, 60 * 60 * 1000); // checa a cada hora

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const { version } = require('./package.json');
  console.log(`SECOP Cotações v${version} rodando em http://localhost:${PORT}`);
});
