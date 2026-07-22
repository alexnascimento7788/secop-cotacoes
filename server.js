const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, setupDb, gerarNumeroProcesso } = require('./database');

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

function requireAuth(req, res, next) {
  const token = getCookie(req, 'secop_sid');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const session = db.prepare(`
    SELECT s.user_id, u.username, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires > datetime('now') AND u.ativo = 1
  `).get(token);
  if (!session) return res.status(401).json({ error: 'Sessão expirada' });
  req.user = session;
  next();
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
  next();
}
app.use('/api/admin', requireAdmin);

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

  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

  db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires < datetime('now')").run(user.id);
  db.prepare("INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)").run(token, user.id, expires);

  registrarLog(req, 'AUTH', 'LOGIN', `Login realizado`, user.username, user.id);

  res.cookie('secop_sid', token, {
    httpOnly: true, sameSite: 'strict', expires: new Date(expires)
  });
  res.json({ ok: true, username: user.username, role: user.role });
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
    SELECT s.user_id AS id, u.username, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires > datetime('now') AND u.ativo = 1
  `).get(token);
  if (!session) return res.status(401).json({ error: 'Não autenticado' });
  res.json(session);
});

// ── Processos ─────────────────────────────────────────────────────────────────

app.get('/api/processos', (req, res) => {
  const { status, setor, busca } = req.query;
  let sql = `
    SELECT p.*, u.username AS criado_por_username,
      CAST((julianday('now') - julianday(p.criado_em)) AS INTEGER) AS dias_em_aberto
    FROM processos p
    LEFT JOIN users u ON u.id = p.criado_por_id
    WHERE 1=1
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
    WHERE p.id = ?
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
  db.prepare(`DELETE FROM processos WHERE id = ?`).run(req.params.id);
  if (proc) registrarLog(req, 'PROCESSO', 'EXCLUIU', `Excluiu processo ${proc.numero_processo}: ${proc.objeto}`);
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
  const em_cotacao   = db.prepare(`SELECT COUNT(*) AS c FROM processos WHERE status='Em cotação' OR status IS NULL`).get().c;
  const ag_aprovacao = db.prepare(`SELECT COUNT(*) AS c FROM processos WHERE status='Ag. aprovação'`).get().c;
  const concluidos_mes = db.prepare(`
    SELECT COUNT(*) AS c FROM processos
    WHERE status='Concluído'
      AND strftime('%Y-%m', atualizado_em) = strftime('%Y-%m', 'now')
  `).get().c;
  const parados = db.prepare(`SELECT COUNT(*) AS c FROM processos WHERE status='Parado'`).get().c;

  const alertas = db.prepare(`
    SELECT id, numero_processo, objeto, setor_solicitante, status,
      CAST((julianday('now') - julianday(criado_em)) AS INTEGER) AS dias_em_aberto
    FROM processos
    WHERE status = 'Parado'
       OR (status NOT IN ('Concluído', 'Cancelado') AND CAST((julianday('now') - julianday(atualizado_em)) AS INTEGER) > 15)
    ORDER BY dias_em_aberto DESC
    LIMIT 20
  `).all();

  const ultimos_processos = db.prepare(`
    SELECT id, numero_processo, objeto, setor_solicitante, status, criado_em,
      CAST((julianday('now') - julianday(criado_em)) AS INTEGER) AS dias_em_aberto
    FROM processos ORDER BY criado_em DESC LIMIT 5
  `).all();

  const por_setor = db.prepare(`
    SELECT setor_solicitante AS setor, COUNT(*) AS total
    FROM processos
    WHERE setor_solicitante IS NOT NULL AND setor_solicitante != ''
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
  const { unidade, descricao, ordem } = req.body;
  if (!unidade || !descricao) return res.status(400).json({ error: 'Unidade e descrição são obrigatórias' });
  try {
    const info = db.prepare(`INSERT INTO tipos_extra (unidade, descricao, ordem) VALUES (?, ?, ?)`).run(unidade, descricao, n(ordem) ?? 0);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Unidade já existe' });
  }
});

app.put('/api/tipos-extra/:id', requireAdmin, (req, res) => {
  const { unidade, descricao, ordem } = req.body;
  if (!unidade || !descricao) return res.status(400).json({ error: 'Unidade e descrição são obrigatórias' });
  db.prepare(`UPDATE tipos_extra SET unidade=?, descricao=?, ordem=? WHERE id=?`).run(unidade, descricao, n(ordem) ?? 0, req.params.id);
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
  const rows = db.prepare(`SELECT DISTINCT setor_solicitante FROM processos WHERE setor_solicitante IS NOT NULL ORDER BY setor_solicitante`).all();
  res.json(rows.map(r => r.setor_solicitante));
});

// ── Admin: usuários ───────────────────────────────────────────────────────────

app.get('/api/admin/users', (req, res) => {
  res.json(db.prepare("SELECT id, username, role, ativo, criado_em FROM users WHERE username != 'master' ORDER BY id").all());
});

app.post('/api/admin/users', (req, res) => {
  const { username, senha, role } = req.body;
  if (!username || !senha) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(senha, salt, 100000, 64, 'sha512').toString('hex');
  try {
    const info = db.prepare(
      "INSERT INTO users (username, senha_hash, salt, role, ativo) VALUES (?, ?, ?, ?, 1)"
    ).run(username, hash, salt, role || 'usuario');
    registrarLog(req, 'USUARIO', 'CRIOU', `Criou usuário "${username}"`);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Usuário já existe' });
  }
});

app.patch('/api/admin/users/:id', (req, res) => {
  const { ativo, senha, role } = req.body;
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

// ── Serve SPA ─────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// ── Versão ───────────────────────────────────────────────────────────────────

app.get('/api/version', (_req, res) => {
  const { version } = require('./package.json');
  res.json({ version });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const { version } = require('./package.json');
  console.log(`SECOP Cotações v${version} rodando em http://localhost:${PORT}`);
});
