const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, setupDb, gerarNumeroProcesso, depopDb, setupDepop, depopFilePath } = require('./database');

// Dicionário geral de português (já vem ordenado por frequência de uso do idioma)
// — recorte das mais comuns, serve de apoio ao autocomplete quando o histórico
// real da cotação ainda não tem a palavra digitada.
const DICIONARIO_PT = require('an-array-of-portuguese-words')
  .filter(w => w.length >= 3)
  .slice(0, 30000);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  if (user.username === 'master') {
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

app.get('/api/config', (req, res) => {
  const rows = db.prepare(`SELECT chave, valor FROM config`).all();
  const cfg = {};
  rows.forEach(r => { cfg[r.chave] = r.valor; });
  res.json(cfg);
});

app.put('/api/admin/config', (req, res) => {
  const entries = Object.entries(req.body || {});
  if (!entries.length) return res.status(400).json({ error: 'Nenhum parâmetro informado' });
  const upsert = db.prepare(`INSERT INTO config (chave, valor) VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`);
  entries.forEach(([chave, valor]) => upsert.run(chave, String(valor)));
  registrarLog(req, 'CONFIG', 'ALTEROU', `Parâmetros atualizados: ${entries.map(([c, v]) => `${c}=${v}`).join(', ')}`);
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
  res.json(db.prepare("SELECT id, username, role, ativo, acesso_avancado, criado_em FROM users WHERE username != 'master' ORDER BY id").all());
});

app.post('/api/admin/users', (req, res) => {
  const { username, senha, role, acesso_avancado } = req.body;
  if (!username || !senha) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(senha, salt, 100000, 64, 'sha512').toString('hex');
  const acessoVal = acesso_avancado ? 1 : 0;
  try {
    const info = db.prepare(
      "INSERT INTO users (username, senha_hash, salt, role, ativo, acesso_avancado) VALUES (?, ?, ?, ?, 1, ?)"
    ).run(username, hash, salt, role || 'usuario', acessoVal);
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
  const { ativo, senha, role, acesso_avancado } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Não encontrado' });

  if (ativo !== undefined) {
    if (user.username === 'master') return res.status(400).json({ error: 'Não é possível desativar o master' });
    db.prepare("UPDATE users SET ativo = ? WHERE id = ?").run(ativo ? 1 : 0, req.params.id);
    registrarLog(req, 'USUARIO', ativo ? 'ATIVOU' : 'DESATIVOU', `${ativo ? 'Ativou' : 'Desativou'} usuário "${user.username}"`);
  }
  if (senha) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(senha, salt, 100000, 64, 'sha512').toString('hex');
    db.prepare("UPDATE users SET senha_hash = ?, salt = ? WHERE id = ?").run(hash, salt, req.params.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(req.params.id);
    registrarLog(req, 'USUARIO', 'SENHA', `Alterou senha do usuário "${user.username}"`);
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

// Par de chaves EC P-256; a privada sai em PEM PKCS8 já cifrada pela senha de
// assinatura (nunca guardamos a senha nem a chave em claro).
function gerarParDeChaves(senhaAssinatura) {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: senhaAssinatura }
  });
}

// Assina um payload canônico com a chave privada do perfil (destravada pela
// senha). Lança se a senha estiver errada — quem chama traduz pra "senha
// incorreta". Devolve a assinatura em base64. (Usado na validação de contrato,
// quando as tabelas do Depop existirem.)
function assinarPayload(perfil, senhaAssinatura, payload) {
  const s = crypto.createSign('SHA256');
  s.update(payload);
  s.end();
  return s.sign({ key: perfil.chave_privada_pem, passphrase: senhaAssinatura }, 'base64');
}

function verificarAssinatura(perfil, payload, assinaturaB64) {
  const v = crypto.createVerify('SHA256');
  v.update(payload);
  v.end();
  return v.verify(perfil.chave_publica, assinaturaB64, 'base64');
}

// Todas as rotas /api/depop/* exigem o módulo Depop ativo na sessão.
app.use('/api/depop', requireModulo('depop'));

// Situação do perfil do usuário logado (o front decide se mostra o cadastro de
// 1º acesso ou o conteúdo). Nunca devolve chave privada; CPF vem mascarado.
app.get('/api/depop/perfil', (req, res) => {
  const perfil = db.prepare(`SELECT cpf, criado_em FROM depop_perfil WHERE user_id = ?`).get(req.user.user_id);
  if (!perfil) return res.json({ cadastrado: false });
  const cpfMasc = perfil.cpf.replace(/^(\d{3})\d{6}(\d{2})$/, '$1.***.**-$2');
  res.json({ cadastrado: true, cpf_mascarado: cpfMasc, criado_em: perfil.criado_em });
});

// Cadastro de 1º acesso: CPF (validado) + senha de assinatura → gera e guarda o
// par de chaves. Só uma vez por usuário; CPF é único no módulo.
app.post('/api/depop/perfil', (req, res) => {
  const { cpf, senha_assinatura } = req.body || {};
  const ja = db.prepare(`SELECT 1 FROM depop_perfil WHERE user_id = ?`).get(req.user.user_id);
  if (ja) return res.status(400).json({ error: 'Perfil já configurado' });
  const cpfLimpo = String(cpf || '').replace(/\D/g, '');
  if (!cpfValido(cpfLimpo)) return res.status(400).json({ error: 'CPF inválido' });
  if (!senha_assinatura || String(senha_assinatura).length < 6) {
    return res.status(400).json({ error: 'A senha de assinatura deve ter ao menos 6 caracteres' });
  }
  const donoCpf = db.prepare(`SELECT user_id FROM depop_perfil WHERE cpf = ?`).get(cpfLimpo);
  if (donoCpf) return res.status(400).json({ error: 'Este CPF já está cadastrado por outro usuário' });

  const { publicKey, privateKey } = gerarParDeChaves(String(senha_assinatura));
  db.prepare(`INSERT INTO depop_perfil (user_id, cpf, chave_publica, chave_privada_pem) VALUES (?, ?, ?, ?)`)
    .run(req.user.user_id, cpfLimpo, publicKey, privateKey);
  registrarLog(req, 'DEPOP', 'PERFIL', 'Configurou CPF e assinatura digital do Depop');
  res.status(201).json({ ok: true });
});

// ── Versão ───────────────────────────────────────────────────────────────────
// Precisa vir ANTES do catch-all "Serve SPA" abaixo — senão o catch-all intercepta
// /api/version primeiro (Express casa rotas na ordem de registro), o `if` dele só
// trata caminhos fora de /api e não chama next() nem responde, e a requisição
// fica pendurada pra sempre (foi isso que deixava o indicador de versão nunca
// aparecer: o fetch('/api/version') do front nunca resolvia).
app.get('/api/version', (_req, res) => {
  const { version } = require('./package.json');
  res.json({ version });
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
