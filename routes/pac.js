// ── PAC/DEPLA: DFD (Documento de Formalização de Demanda) ─────────────────────
// Setores lançam itens de demanda dentro de um DFD administrado pelo DEPLA
// (rotina 'pac-gestao'); o gestor de cada setor lança pelos seus itens (rotina
// 'pac-lancamento'). Setor do usuário não é resolvido no requireAuth (seria
// permissão cacheada demais pra algo que muda pouco) — consulta ao vivo aqui.
//
// Extraído de server.js na modularização por módulo — zero mudança de
// comportamento. Cada rota leva `requireModulo('pac')` explícito (em vez do
// antigo `app.use('/api/pac', requireModulo('pac'))` blanket) — ver
// C:\Users\alex.nascimento\.claude\plans\linear-puzzling-rain.md pro motivo
// (evitar reintroduzir a classe de bug de ordem de rota já documentada em
// routes/admin.js). PAC só usa a conexão principal (`db`) — nunca depopDb/anexosDb.
const express = require('express');
const { db } = require('../database');
const { registrarLog, requireModulo, requireRotina, ROTINA_FLAGS_VALIDAS, gerarCodigoPac } = require('../middleware');
const crypto = require('crypto');

const router = express.Router();
const pac = requireModulo('pac');

function setoresDoUsuario(userId) {
  return db.prepare(`SELECT setor_id FROM setor_usuarios WHERE user_id = ?`).all(userId).map(r => r.setor_id);
}

// DEPLA (perfil com 'ver' em pac-gestao) enxerga o DFD inteiro (todos os
// setores lado a lado); gestor de setor só o próprio recorte — usado pra
// decidir o filtro nas listagens de DFDs/itens/pedidos.
function temPacGestao(req) {
  if (req.user.username === 'master' || req.user.role === 'consulta') return true;
  if (!req.user.perfil_id) return false;
  const row = db.prepare(`
    SELECT pr.ver AS v FROM perfil_rotinas pr JOIN rotinas r ON r.id = pr.rotina_id
    WHERE pr.perfil_id = ? AND r.slug = 'pac-gestao'
  `).get(req.user.perfil_id);
  return !!(row && row.v);
}

// Como requireRotina, mas aceita a flag em QUALQUER UMA das duas rotinas do
// PAC — usado nas rotas de DFD que tanto o DEPLA quanto o gestor de setor
// precisam alcançar (listar/abrir um DFD, ver colunas do catálogo).
function requireRotinaPac(flag) {
  if (!ROTINA_FLAGS_VALIDAS.has(flag)) throw new Error(`requireRotinaPac: flag inválida "${flag}"`);
  return (req, res, next) => {
    if (req.user.username === 'master' || req.user.role === 'consulta') return next();
    if (!req.user.perfil_id) return res.status(403).json({ error: 'Você não tem um perfil de acesso definido neste módulo. Procure o administrador.' });
    const row = db.prepare(`
      SELECT MAX(pr.${flag}) AS permitido
      FROM perfil_rotinas pr JOIN rotinas r ON r.id = pr.rotina_id
      WHERE pr.perfil_id = ? AND r.slug IN ('pac-gestao', 'pac-lancamento')
    `).get(req.user.perfil_id);
    if (!row || !row.permitido) return res.status(403).json({ error: 'Você não tem essa permissão.' });
    next();
  };
}

// Escrita em itens só com o DFD "aberto" — E o setor do item ainda não tendo
// clicado "Finalizar meu DFD" (dfd_setores.finalizado_em), que trava do mesmo
// jeito que o DFD "em análise" mesmo com o DFD continuando aberto pros OUTROS
// setores (Alex: "o status do DFD global não muda — apenas o registro do
// setor marca que aquele setor concluiu"). "Fechado" nunca aceita escrita. Em
// qualquer um dos dois bloqueios (análise OU setor finalizado), só passa se
// houver um pedido de edição APROVADO e ainda não CONSUMIDO pra aquele
// item+tipo (opts) — usado só no PUT/DELETE de item, não na criação (não
// existe "pedido de inclusão", por isso resolveSetorId sozinho já barra a
// criação sem checar pedido nenhum). Ao passar por um pedido, marca
// req.pedidoConsumir pro handler consumir (uso único) na mesma operação.
function requireDfdEditavel(resolveDfdId, opts = {}) {
  return (req, res, next) => {
    const dfd = db.prepare(`SELECT id, status FROM dfds WHERE id = ?`).get(resolveDfdId(req));
    if (!dfd) return res.status(404).json({ error: 'DFD não encontrado' });
    // master nunca fica bloqueado por status — pode intervir em qualquer situação.
    if (req.user.username === 'master') { req.dfd = dfd; return next(); }
    if (dfd.status === 'fechado') return res.status(409).json({ error: 'Este DFD está fechado — somente leitura.' });

    const setorId = opts.resolveSetorId ? opts.resolveSetorId(req) : null;
    const setorFinalizado = setorId != null && !!db.prepare(
      `SELECT 1 FROM dfd_setores WHERE dfd_id = ? AND setor_id = ? AND finalizado_em IS NOT NULL`
    ).get(dfd.id, setorId);

    if (dfd.status === 'aberto' && !setorFinalizado) { req.dfd = dfd; return next(); }

    if (opts.resolveItemId) {
      const pedido = db.prepare(`
        SELECT id FROM dfd_pedidos_edicao
        WHERE item_id = ? AND tipo = ? AND status = 'aprovado' AND consumido_em IS NULL
        ORDER BY id DESC LIMIT 1
      `).get(opts.resolveItemId(req), opts.tipo);
      if (pedido) { req.dfd = dfd; req.pedidoConsumir = pedido.id; return next(); }
    }
    return res.status(409).json({
      error: setorFinalizado
        ? 'Você já finalizou o lançamento deste setor — solicite um pedido de edição ao DEPLA.'
        : 'DFD em análise — solicite um pedido de edição.',
      pedeEdicao: true,
    });
  };
}

// Setor(es) do usuário logado — o frontend de Lançamento usa isso pra saber em
// nome de qual setor lançar um item novo. Master não pertence a setor nenhum
// de verdade, mas precisa poder agir em qualquer um (mesmo bypass de sempre).
router.get('/api/pac/meus-setores', pac, requireRotinaPac('ver'), (req, res) => {
  if (req.user.username === 'master') {
    return res.json(db.prepare(`SELECT id, nome FROM setores WHERE ativo = 1 ORDER BY ordem`).all());
  }
  const ids = setoresDoUsuario(req.user.user_id);
  if (!ids.length) return res.json([]);
  const ph = ids.map(() => '?').join(',');
  res.json(db.prepare(`SELECT id, nome FROM setores WHERE id IN (${ph}) AND ativo = 1 ORDER BY ordem`).all(...ids));
});

// ── PAC: setores (cadastro do DEPLA) ──────────────────────────────────────────

router.get('/api/pac/setores', pac, requireRotina('pac-gestao', 'ver'), (req, res) => {
  res.json(db.prepare(`SELECT id, nome, sigla, ativo, ordem FROM setores ORDER BY ordem`).all());
});

router.post('/api/pac/setores', pac, requireRotina('pac-gestao', 'incluir'), (req, res) => {
  const { nome, sigla, ordem } = req.body || {};
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  try {
    const info = db.prepare(`INSERT INTO setores (nome, sigla, ordem) VALUES (?, ?, ?)`)
      .run(String(nome).trim(), sigla ? String(sigla).trim() : null, ordem || 0);
    registrarLog(req, 'PAC', 'CRIOU_SETOR', `Criou o setor "${nome}"`);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch {
    res.status(400).json({ error: 'Já existe um setor com esse nome' });
  }
});

router.put('/api/pac/setores/:id', pac, requireRotina('pac-gestao', 'alterar'), (req, res) => {
  const setor = db.prepare(`SELECT nome FROM setores WHERE id = ?`).get(req.params.id);
  if (!setor) return res.status(404).json({ error: 'Setor não encontrado' });
  const { nome, sigla, ordem } = req.body || {};
  if (nome !== undefined) db.prepare(`UPDATE setores SET nome = ? WHERE id = ?`).run(String(nome).trim(), req.params.id);
  if (sigla !== undefined) db.prepare(`UPDATE setores SET sigla = ? WHERE id = ?`).run(sigla ? String(sigla).trim() : null, req.params.id);
  if (ordem !== undefined) db.prepare(`UPDATE setores SET ordem = ? WHERE id = ?`).run(ordem, req.params.id);
  registrarLog(req, 'PAC', 'EDITOU_SETOR', `Editou o setor "${setor.nome}"`);
  res.json({ ok: true });
});

router.patch('/api/pac/setores/:id/ativo', pac, requireRotina('pac-gestao', 'alterar'), (req, res) => {
  const setor = db.prepare(`SELECT nome FROM setores WHERE id = ?`).get(req.params.id);
  if (!setor) return res.status(404).json({ error: 'Setor não encontrado' });
  db.prepare(`UPDATE setores SET ativo = ? WHERE id = ?`).run(req.body?.ativo ? 1 : 0, req.params.id);
  registrarLog(req, 'PAC', 'SETOR_ATIVO', `${req.body?.ativo ? 'Ativou' : 'Desativou'} o setor "${setor.nome}"`);
  res.json({ ok: true });
});

router.get('/api/pac/setores/:id/usuarios', pac, requireRotina('pac-gestao', 'ver'), (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.username, u.nome_completo,
           EXISTS(SELECT 1 FROM setor_usuarios su WHERE su.setor_id = ? AND su.user_id = u.id) AS vinculado
    FROM users u WHERE u.username != 'master' AND u.ativo = 1 ORDER BY u.username
  `).all(req.params.id));
});

router.put('/api/pac/setores/:id/usuarios', pac, requireRotina('pac-gestao', 'alterar'), (req, res) => {
  const { user_id, vinculado } = req.body || {};
  if (vinculado) {
    try { db.prepare(`INSERT INTO setor_usuarios (setor_id, user_id) VALUES (?, ?)`).run(req.params.id, user_id); } catch {}
  } else {
    db.prepare(`DELETE FROM setor_usuarios WHERE setor_id = ? AND user_id = ?`).run(req.params.id, user_id);
  }
  registrarLog(req, 'PAC', 'SETOR_USUARIO', `${vinculado ? 'Vinculou' : 'Desvinculou'} usuário #${user_id} ao setor #${req.params.id}`);
  res.json({ ok: true });
});

// ── PAC: parâmetros (listas de dropdown das colunas do DFD) ───────────────────

// Leitura liberada pra quem acessa QUALQUER rotina do PAC — o gestor de setor
// (só pac-lancamento) precisa das listas pra preencher os <select> dos itens;
// escrita continua exclusiva do DEPLA (pac-gestao), logo abaixo.
router.get('/api/pac/parametros', pac, requireRotinaPac('ver'), (req, res) => {
  const { lista } = req.query;
  const rows = lista
    ? db.prepare(`SELECT id, lista, valor, ordem, ativo FROM dfd_parametros_lista WHERE lista = ? ORDER BY ordem`).all(lista)
    : db.prepare(`SELECT id, lista, valor, ordem, ativo FROM dfd_parametros_lista ORDER BY lista, ordem`).all();
  res.json(rows);
});

router.post('/api/pac/parametros', pac, requireRotina('pac-gestao', 'incluir'), (req, res) => {
  const { lista, valor, ordem } = req.body || {};
  if (!lista || !valor) return res.status(400).json({ error: 'Lista e valor são obrigatórios' });
  try {
    const info = db.prepare(`INSERT INTO dfd_parametros_lista (lista, valor, ordem) VALUES (?, ?, ?)`)
      .run(String(lista).trim(), String(valor).trim(), ordem || 0);
    registrarLog(req, 'PAC', 'CRIOU_PARAMETRO', `Criou "${valor}" na lista "${lista}"`);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch {
    res.status(400).json({ error: 'Este valor já existe nessa lista' });
  }
});

router.put('/api/pac/parametros/:id', pac, requireRotina('pac-gestao', 'alterar'), (req, res) => {
  const p = db.prepare(`SELECT valor FROM dfd_parametros_lista WHERE id = ?`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Não encontrado' });
  const { valor, ordem, ativo } = req.body || {};
  if (valor !== undefined) db.prepare(`UPDATE dfd_parametros_lista SET valor = ? WHERE id = ?`).run(String(valor).trim(), req.params.id);
  if (ordem !== undefined) db.prepare(`UPDATE dfd_parametros_lista SET ordem = ? WHERE id = ?`).run(ordem, req.params.id);
  if (ativo !== undefined) db.prepare(`UPDATE dfd_parametros_lista SET ativo = ? WHERE id = ?`).run(ativo ? 1 : 0, req.params.id);
  registrarLog(req, 'PAC', 'EDITOU_PARAMETRO', `Editou "${p.valor}"`);
  res.json({ ok: true });
});

router.delete('/api/pac/parametros/:id', pac, requireRotina('pac-gestao', 'excluir'), (req, res) => {
  const p = db.prepare(`SELECT valor FROM dfd_parametros_lista WHERE id = ?`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Não encontrado' });
  try {
    db.prepare(`DELETE FROM dfd_parametros_lista WHERE id = ?`).run(req.params.id);
    registrarLog(req, 'PAC', 'EXCLUIU_PARAMETRO', `Excluiu "${p.valor}"`);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Este valor está em uso.' });
  }
});

// ── PAC: catálogo de colunas (fixo, só leitura) ───────────────────────────────

router.get('/api/pac/colunas', pac, requireRotinaPac('ver'), (req, res) => {
  res.json(db.prepare(`
    SELECT id, slug, label, grupo, tipo_input, lista, obrigatoria, ordem_padrao
    FROM dfd_colunas_catalogo WHERE ativa = 1 ORDER BY ordem_padrao
  `).all());
});

// ── PAC: DFDs ──────────────────────────────────────────────────────────────

router.get('/api/pac/dfds', pac, requireRotinaPac('ver'), (req, res) => {
  let rows;
  if (temPacGestao(req)) {
    // DEPLA/master: contagem de TODOS os itens do DFD (todos os setores).
    rows = db.prepare(`
      SELECT d.*,
        (SELECT COUNT(*) FROM dfd_itens WHERE dfd_id = d.id AND excluido_em IS NULL) AS itens_count
      FROM dfds d ORDER BY d.ano_base DESC, d.id DESC
    `).all();
  } else {
    const meus = setoresDoUsuario(req.user.user_id);
    if (!meus.length) return res.json([]);
    const ph = meus.map(() => '?').join(',');
    // Gestor de setor: contagem só dos itens do(s) próprio(s) setor(es) —
    // mesmo filtro que GET /api/pac/dfds/:id/itens já usa.
    rows = db.prepare(`
      SELECT DISTINCT d.*,
        (SELECT COUNT(*) FROM dfd_itens WHERE dfd_id = d.id AND excluido_em IS NULL AND setor_id IN (${ph})) AS itens_count
      FROM dfds d JOIN dfd_setores ds ON ds.dfd_id = d.id
      WHERE ds.setor_id IN (${ph}) ORDER BY d.ano_base DESC, d.id DESC
    `).all(...meus, ...meus);
  }
  res.json(rows);
});

router.post('/api/pac/dfds', pac, requireRotina('pac-gestao', 'incluir'), (req, res) => {
  const { ano_base, titulo, descricao } = req.body || {};
  if (!ano_base || !titulo) return res.status(400).json({ error: 'Ano base e título são obrigatórios' });
  const info = db.prepare(`INSERT INTO dfds (ano_base, titulo, descricao, criado_por) VALUES (?, ?, ?, ?)`)
    .run(ano_base, String(titulo).trim(), descricao ? String(descricao).trim() : null, req.user.user_id);
  const dfdId = info.lastInsertRowid;
  // Colunas ativas começam todas pré-selecionadas (o DEPLA desativa quem não quer).
  const colunas = db.prepare(`SELECT id, ordem_padrao FROM dfd_colunas_catalogo WHERE ativa = 1 ORDER BY ordem_padrao`).all();
  const insColuna = db.prepare(`INSERT INTO dfd_colunas_ativas (dfd_id, coluna_id, ordem) VALUES (?, ?, ?)`);
  colunas.forEach(c => insColuna.run(dfdId, c.id, c.ordem_padrao));
  registrarLog(req, 'PAC', 'CRIOU_DFD', `Criou o DFD "${titulo}" (${ano_base})`);
  res.status(201).json({ id: dfdId });
});

router.get('/api/pac/dfds/:id', pac, requireRotinaPac('ver'), (req, res) => {
  const dfd = db.prepare(`SELECT * FROM dfds WHERE id = ?`).get(req.params.id);
  if (!dfd) return res.status(404).json({ error: 'DFD não encontrado' });
  const setoresParticipantes = db.prepare(`
    SELECT s.id, s.nome FROM dfd_setores ds JOIN setores s ON s.id = ds.setor_id
    WHERE ds.dfd_id = ? ORDER BY s.ordem
  `).all(req.params.id);
  const colunas = db.prepare(`
    SELECT c.id, c.slug, c.label, c.grupo, c.tipo_input, c.lista, c.obrigatoria, dca.ordem
    FROM dfd_colunas_ativas dca JOIN dfd_colunas_catalogo c ON c.id = dca.coluna_id
    WHERE dca.dfd_id = ? ORDER BY dca.ordem
  `).all(req.params.id);
  res.json({ ...dfd, setores: setoresParticipantes, colunas });
});

router.put('/api/pac/dfds/:id', pac, requireRotina('pac-gestao', 'alterar'), (req, res) => {
  const dfd = db.prepare(`SELECT titulo FROM dfds WHERE id = ?`).get(req.params.id);
  if (!dfd) return res.status(404).json({ error: 'DFD não encontrado' });
  const { ano_base, titulo, descricao } = req.body || {};
  if (ano_base !== undefined) db.prepare(`UPDATE dfds SET ano_base = ? WHERE id = ?`).run(ano_base, req.params.id);
  if (titulo !== undefined) db.prepare(`UPDATE dfds SET titulo = ? WHERE id = ?`).run(String(titulo).trim(), req.params.id);
  if (descricao !== undefined) db.prepare(`UPDATE dfds SET descricao = ? WHERE id = ?`).run(descricao ? String(descricao).trim() : null, req.params.id);
  db.prepare(`UPDATE dfds SET atualizado_em = datetime('now') WHERE id = ?`).run(req.params.id);
  registrarLog(req, 'PAC', 'EDITOU_DFD', `Editou o DFD "${dfd.titulo}"`);
  res.json({ ok: true });
});

const DFD_STATUS_VALIDOS = new Set(['aberto', 'analise', 'fechado']);
router.patch('/api/pac/dfds/:id/status', pac, requireRotina('pac-gestao', 'alterar'), (req, res) => {
  const { status } = req.body || {};
  if (!DFD_STATUS_VALIDOS.has(status)) return res.status(400).json({ error: 'Status inválido' });
  const dfd = db.prepare(`SELECT titulo FROM dfds WHERE id = ?`).get(req.params.id);
  if (!dfd) return res.status(404).json({ error: 'DFD não encontrado' });
  db.prepare(`UPDATE dfds SET status = ?, atualizado_em = datetime('now') WHERE id = ?`).run(status, req.params.id);
  registrarLog(req, 'PAC', 'MUDOU_STATUS_DFD', `DFD "${dfd.titulo}" → ${status}`);
  res.json({ ok: true });
});

router.get('/api/pac/dfds/:id/setores', pac, requireRotina('pac-gestao', 'ver'), (req, res) => {
  res.json(db.prepare(`
    SELECT s.id, s.nome,
           EXISTS(SELECT 1 FROM dfd_setores ds WHERE ds.dfd_id = ? AND ds.setor_id = s.id) AS ativo
    FROM setores s WHERE s.ativo = 1 ORDER BY s.ordem
  `).all(req.params.id));
});

router.put('/api/pac/dfds/:id/setores', pac, requireRotina('pac-gestao', 'alterar'), (req, res) => {
  const { setor_id, ativo } = req.body || {};
  if (ativo) {
    try { db.prepare(`INSERT INTO dfd_setores (dfd_id, setor_id) VALUES (?, ?)`).run(req.params.id, setor_id); } catch {}
  } else {
    db.prepare(`DELETE FROM dfd_setores WHERE dfd_id = ? AND setor_id = ?`).run(req.params.id, setor_id);
  }
  registrarLog(req, 'PAC', 'DFD_SETOR', `${ativo ? 'Incluiu' : 'Removeu'} setor #${setor_id} no DFD #${req.params.id}`);
  res.json({ ok: true });
});

router.get('/api/pac/dfds/:id/colunas', pac, requireRotina('pac-gestao', 'ver'), (req, res) => {
  res.json(db.prepare(`
    SELECT c.id, c.slug, c.label, c.grupo,
           (dca.id IS NOT NULL) AS ativa, COALESCE(dca.ordem, c.ordem_padrao) AS ordem
    FROM dfd_colunas_catalogo c LEFT JOIN dfd_colunas_ativas dca ON dca.dfd_id = ? AND dca.coluna_id = c.id
    WHERE c.ativa = 1 ORDER BY c.ordem_padrao
  `).all(req.params.id));
});

router.put('/api/pac/dfds/:id/colunas', pac, requireRotina('pac-gestao', 'alterar'), (req, res) => {
  const { coluna_id, ativa } = req.body || {};
  if (ativa) {
    const cat = db.prepare(`SELECT ordem_padrao FROM dfd_colunas_catalogo WHERE id = ?`).get(coluna_id);
    try { db.prepare(`INSERT INTO dfd_colunas_ativas (dfd_id, coluna_id, ordem) VALUES (?, ?, ?)`).run(req.params.id, coluna_id, cat ? cat.ordem_padrao : 0); } catch {}
  } else {
    db.prepare(`DELETE FROM dfd_colunas_ativas WHERE dfd_id = ? AND coluna_id = ?`).run(req.params.id, coluna_id);
  }
  registrarLog(req, 'PAC', 'DFD_COLUNA', `${ativa ? 'Ativou' : 'Desativou'} coluna #${coluna_id} no DFD #${req.params.id}`);
  res.json({ ok: true });
});

// ── PAC: itens do DFD ──────────────────────────────────────────────────────

router.get('/api/pac/dfds/:id/itens', pac, requireRotinaPac('ver'), (req, res) => {
  const dfdId = req.params.id;
  let itens;
  if (temPacGestao(req)) {
    itens = db.prepare(`SELECT * FROM dfd_itens WHERE dfd_id = ? AND excluido_em IS NULL ORDER BY setor_id, numero_item`).all(dfdId);
  } else {
    const meus = setoresDoUsuario(req.user.user_id);
    if (!meus.length) return res.json([]);
    const ph = meus.map(() => '?').join(',');
    itens = db.prepare(`SELECT * FROM dfd_itens WHERE dfd_id = ? AND excluido_em IS NULL AND setor_id IN (${ph}) ORDER BY numero_item`).all(dfdId, ...meus);
  }
  const ids = itens.map(i => i.id);
  const valoresPorItem = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`SELECT item_id, coluna_id, valor FROM dfd_itens_valores WHERE item_id IN (${ph})`).all(...ids)
      .forEach(v => { (valoresPorItem[v.item_id] ??= {})[v.coluna_id] = v.valor; });
  }
  res.json(itens.map(i => ({ ...i, valores: valoresPorItem[i.id] || {} })));
});

router.post('/api/pac/dfds/:id/itens', pac, requireRotina('pac-lancamento', 'incluir'),
  requireDfdEditavel(req => req.params.id, { resolveSetorId: req => req.body?.setor_id }),
  (req, res) => {
  const dfdId = Number(req.params.id);
  const { setor_id, valores } = req.body || {};
  if (!setor_id) return res.status(400).json({ error: 'Setor é obrigatório' });
  if (req.user.username !== 'master' && !setoresDoUsuario(req.user.user_id).includes(Number(setor_id))) {
    return res.status(403).json({ error: 'Você não pertence a este setor.' });
  }
  const setor = db.prepare(`SELECT id, nome, sigla FROM setores WHERE id = ?`).get(setor_id);
  const participa = db.prepare(`SELECT 1 FROM dfd_setores WHERE dfd_id = ? AND setor_id = ?`).get(dfdId, setor_id);
  if (!participa) return res.status(400).json({ error: 'Este setor não participa deste DFD.' });

  const max = db.prepare(`SELECT COALESCE(MAX(numero_item), 0) AS m FROM dfd_itens WHERE dfd_id = ? AND setor_id = ?`).get(dfdId, setor_id).m;
  const numeroItem = max + 1;
  // Momento 1 do numero_pac: nasce igual ao numero_item (sequencial local por
  // setor) — só vira global quando o DEPLA gerar a consolidação (ver
  // POST /gerar-consolidacao). codigo_pac (SIGLA-NNNN) é o rótulo ESTÁVEL do
  // gestor: nunca muda, mesmo depois que numero_pac for reordenado.
  const idPac = crypto.randomUUID();
  const codigoPac = gerarCodigoPac(setor, numeroItem);
  const info = db.prepare(`
    INSERT INTO dfd_itens (dfd_id, setor_id, numero_item, criado_por, numero_pac, id_pac, codigo_pac)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(dfdId, setor_id, numeroItem, req.user.user_id, String(numeroItem), idPac, codigoPac);
  const itemId = info.lastInsertRowid;

  const colunasAtivas = new Set(db.prepare(`SELECT coluna_id FROM dfd_colunas_ativas WHERE dfd_id = ?`).all(dfdId).map(r => r.coluna_id));
  const upsert = db.prepare(`INSERT INTO dfd_itens_valores (item_id, coluna_id, valor) VALUES (?, ?, ?)`);
  Object.entries(valores || {}).forEach(([colunaId, valor]) => {
    if (!colunasAtivas.has(Number(colunaId))) return;
    upsert.run(itemId, Number(colunaId), valor == null ? null : String(valor));
  });

  registrarLog(req, 'PAC', 'CRIOU_ITEM', `Criou o item #${numeroItem} no DFD #${dfdId} (setor ${setor_id}) — ${codigoPac}`);
  res.status(201).json({ id: itemId, numero_item: numeroItem, numero_pac: String(numeroItem), codigo_pac: codigoPac });
});

router.put('/api/pac/itens/:id',
  pac,
  requireRotina('pac-lancamento', 'alterar'),
  (req, res, next) => {
    const item = db.prepare(`SELECT id, dfd_id, setor_id FROM dfd_itens WHERE id = ? AND excluido_em IS NULL`).get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item não encontrado' });
    req.item = item;
    next();
  },
  (req, res, next) => requireDfdEditavel(() => req.item.dfd_id, { resolveItemId: () => req.item.id, tipo: 'editar', resolveSetorId: () => req.item.setor_id })(req, res, next),
  (req, res) => {
    const item = req.item;
    if (req.user.username !== 'master' && !setoresDoUsuario(req.user.user_id).includes(item.setor_id)) {
      return res.status(403).json({ error: 'Você não pertence ao setor deste item.' });
    }
    const colunasAtivas = new Set(db.prepare(`SELECT coluna_id FROM dfd_colunas_ativas WHERE dfd_id = ?`).all(item.dfd_id).map(r => r.coluna_id));
    const upsert = db.prepare(`
      INSERT INTO dfd_itens_valores (item_id, coluna_id, valor) VALUES (?, ?, ?)
      ON CONFLICT(item_id, coluna_id) DO UPDATE SET valor = excluded.valor
    `);
    Object.entries(req.body?.valores || {}).forEach(([colunaId, valor]) => {
      if (!colunasAtivas.has(Number(colunaId))) return;
      upsert.run(item.id, Number(colunaId), valor == null ? null : String(valor));
    });
    db.prepare(`UPDATE dfd_itens SET atualizado_em = datetime('now') WHERE id = ?`).run(item.id);
    if (req.pedidoConsumir) db.prepare(`UPDATE dfd_pedidos_edicao SET consumido_em = datetime('now') WHERE id = ?`).run(req.pedidoConsumir);
    registrarLog(req, 'PAC', 'EDITOU_ITEM', `Editou o item #${item.id} do DFD #${item.dfd_id}`);
    res.json({ ok: true });
  }
);

router.delete('/api/pac/itens/:id',
  pac,
  requireRotina('pac-lancamento', 'excluir'),
  (req, res, next) => {
    const item = db.prepare(`SELECT id, dfd_id, setor_id FROM dfd_itens WHERE id = ? AND excluido_em IS NULL`).get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item não encontrado' });
    req.item = item;
    next();
  },
  (req, res, next) => requireDfdEditavel(() => req.item.dfd_id, { resolveItemId: () => req.item.id, tipo: 'excluir', resolveSetorId: () => req.item.setor_id })(req, res, next),
  (req, res) => {
    const item = req.item;
    if (req.user.username !== 'master' && !setoresDoUsuario(req.user.user_id).includes(item.setor_id)) {
      return res.status(403).json({ error: 'Você não pertence ao setor deste item.' });
    }
    db.prepare(`UPDATE dfd_itens SET excluido_em = datetime('now') WHERE id = ?`).run(item.id);
    if (req.pedidoConsumir) db.prepare(`UPDATE dfd_pedidos_edicao SET consumido_em = datetime('now') WHERE id = ?`).run(req.pedidoConsumir);
    registrarLog(req, 'PAC', 'EXCLUIU_ITEM', `Excluiu o item #${item.id} do DFD #${item.dfd_id}`);
    res.json({ ok: true });
  }
);

// ── PAC: pedidos de edição (DFD em análise) ───────────────────────────────────

router.post('/api/pac/pedidos', pac, requireRotina('pac-lancamento', 'incluir'), (req, res) => {
  const { item_id, tipo, justificativa } = req.body || {};
  if (!['editar', 'excluir'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
  const item = db.prepare(`SELECT dfd_id, setor_id FROM dfd_itens WHERE id = ? AND excluido_em IS NULL`).get(item_id);
  if (!item) return res.status(404).json({ error: 'Item não encontrado' });
  if (req.user.username !== 'master' && !setoresDoUsuario(req.user.user_id).includes(item.setor_id)) {
    return res.status(403).json({ error: 'Você não pertence ao setor deste item.' });
  }
  const dfd = db.prepare(`SELECT status FROM dfds WHERE id = ?`).get(item.dfd_id);
  if (!dfd || dfd.status !== 'analise') return res.status(409).json({ error: 'Só é possível abrir pedido com o DFD em análise.' });
  const info = db.prepare(`
    INSERT INTO dfd_pedidos_edicao (dfd_id, item_id, setor_id, solicitante_id, tipo, justificativa)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(item.dfd_id, item_id, item.setor_id, req.user.user_id, tipo, justificativa ? String(justificativa).trim() : null);
  registrarLog(req, 'PAC', 'SOLICITOU_EDICAO', `Solicitou ${tipo} no item #${item_id} do DFD #${item.dfd_id}`);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.get('/api/pac/pedidos', pac, requireRotinaPac('ver'), (req, res) => {
  const { dfd_id } = req.query;
  let rows;
  if (temPacGestao(req)) {
    rows = dfd_id
      ? db.prepare(`SELECT * FROM dfd_pedidos_edicao WHERE dfd_id = ? ORDER BY id DESC`).all(dfd_id)
      : db.prepare(`SELECT * FROM dfd_pedidos_edicao ORDER BY id DESC`).all();
  } else {
    rows = db.prepare(`SELECT * FROM dfd_pedidos_edicao WHERE solicitante_id = ? ORDER BY id DESC`).all(req.user.user_id);
  }
  res.json(rows);
});

router.patch('/api/pac/pedidos/:id/resposta', pac, requireRotina('pac-gestao', 'alterar'), (req, res) => {
  const { status, resposta } = req.body || {};
  if (!['aprovado', 'rejeitado'].includes(status)) return res.status(400).json({ error: 'Status inválido' });
  const pedido = db.prepare(`SELECT status FROM dfd_pedidos_edicao WHERE id = ?`).get(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });
  if (pedido.status !== 'pendente') return res.status(409).json({ error: 'Este pedido já foi respondido.' });
  db.prepare(`
    UPDATE dfd_pedidos_edicao SET status = ?, resposta = ?, respondido_por = ?, respondido_em = datetime('now') WHERE id = ?
  `).run(status, resposta ? String(resposta).trim() : null, req.user.user_id, req.params.id);
  registrarLog(req, 'PAC', 'RESPONDEU_PEDIDO', `${status === 'aprovado' ? 'Aprovou' : 'Rejeitou'} o pedido #${req.params.id}`);
  res.json({ ok: true });
});

// ── PAC: finalização por setor (gestor) ───────────────────────────────────────
// O gestor sinaliza que terminou de lançar os itens do seu setor num DFD —
// dfd_setores.finalizado_em, independente do status global do DFD (que
// continua manual, controlado só pelo DEPLA). A partir daí, o setor trava
// pra escrita igual ao DFD "em análise" (ver requireDfdEditavel acima) — pra
// mudar algo, precisa de pedido de edição.
router.post('/api/pac/dfds/:dfd_id/setores/:setor_id/finalizar', pac, requireRotina('pac-lancamento', 'incluir'), (req, res) => {
  const dfdId = Number(req.params.dfd_id);
  const setorId = Number(req.params.setor_id);
  const dfd = db.prepare(`SELECT id, status FROM dfds WHERE id = ?`).get(dfdId);
  if (!dfd) return res.status(404).json({ error: 'DFD não encontrado' });
  if (dfd.status !== 'aberto') return res.status(409).json({ error: 'Só é possível finalizar com o DFD aberto.' });
  if (req.user.username !== 'master' && !setoresDoUsuario(req.user.user_id).includes(setorId)) {
    return res.status(403).json({ error: 'Você não pertence a este setor.' });
  }
  const participa = db.prepare(`SELECT finalizado_em FROM dfd_setores WHERE dfd_id = ? AND setor_id = ?`).get(dfdId, setorId);
  if (!participa) return res.status(400).json({ error: 'Este setor não participa deste DFD.' });
  if (participa.finalizado_em) return res.status(409).json({ error: 'Este setor já foi finalizado.' });
  const totalItens = db.prepare(`SELECT COUNT(*) AS n FROM dfd_itens WHERE dfd_id = ? AND setor_id = ? AND excluido_em IS NULL`).get(dfdId, setorId).n;
  if (!totalItens) return res.status(400).json({ error: 'Lance ao menos 1 item antes de finalizar.' });
  db.prepare(`UPDATE dfd_setores SET finalizado_em = datetime('now') WHERE dfd_id = ? AND setor_id = ?`).run(dfdId, setorId);
  registrarLog(req, 'PAC', 'FINALIZOU_SETOR_DFD', `Finalizou o lançamento do setor #${setorId} no DFD #${dfdId} (${totalItens} item(ns))`);
  const pendentes = db.prepare(`SELECT COUNT(*) AS n FROM dfd_setores WHERE dfd_id = ? AND finalizado_em IS NULL`).get(dfdId).n;
  res.json({ ok: true, todos_finalizados: pendentes === 0 });
});

// Usado tanto pelo Acompanhamento do DEPLA (badges por setor + condição pra
// mostrar "Gerar Consolidação") quanto pelo próprio Lançamento do gestor
// (esconder/desabilitar o botão "Finalizar meu DFD" depois de já finalizado).
router.get('/api/pac/dfds/:id/status-finalizacao', pac, requireRotinaPac('ver'), (req, res) => {
  const rows = db.prepare(`
    SELECT s.id AS setor_id, s.nome AS setor_nome, ds.finalizado_em
    FROM dfd_setores ds JOIN setores s ON s.id = ds.setor_id
    WHERE ds.dfd_id = ? ORDER BY s.ordem
  `).all(req.params.id);
  res.json({ setores: rows, todos_finalizados: rows.length > 0 && rows.every(r => !!r.finalizado_em) });
});

// ── PAC: consolidação (numeração global + ciclo de aprovação/cancelamento) ───
// Fluxo: cada setor finaliza (acima) → DEPLA gera a consolidação (numeração
// global, Momento 2 do numero_pac) → DEPLA trabalha os itens na tela de
// Consolidação (em análise / finalizado / cancelado, com observação) → ao
// finalizar a consolidação de um setor, a numeração é reordenada de novo
// (Momento 3), excluindo cancelados da sequência ativa mas SEM tirar o
// numero_pac que eles já tinham (ver índice parcial em database.js).

function colunaId(slug) {
  const row = db.prepare(`SELECT id FROM dfd_colunas_catalogo WHERE slug = ?`).get(slug);
  return row ? row.id : null;
}

function itensConsolidados(dfdId) {
  const itens = db.prepare(`
    SELECT di.*, s.nome AS setor_nome, s.sigla AS setor_sigla, u.username AS cancelado_por_username
    FROM dfd_itens di
    JOIN setores s ON s.id = di.setor_id
    LEFT JOIN users u ON u.id = di.cancelado_por
    WHERE di.dfd_id = ? AND di.excluido_em IS NULL
    ORDER BY s.ordem ASC, CAST(di.numero_pac AS INTEGER) ASC
  `).all(dfdId);
  const ids = itens.map(i => i.id);
  const valoresPorItem = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`SELECT item_id, coluna_id, valor FROM dfd_itens_valores WHERE item_id IN (${ph})`).all(...ids)
      .forEach(v => { (valoresPorItem[v.item_id] ??= {})[v.coluna_id] = v.valor; });
  }
  return itens.map(i => ({ ...i, valores: valoresPorItem[i.id] || {} }));
}

router.post('/api/pac/dfds/:id/gerar-consolidacao', pac, requireRotina('pac-gestao', 'incluir'), (req, res) => {
  const dfd = db.prepare(`SELECT id, titulo FROM dfds WHERE id = ?`).get(req.params.id);
  if (!dfd) return res.status(404).json({ error: 'DFD não encontrado' });
  if (db.prepare(`SELECT 1 FROM pac_consolidacoes WHERE dfd_id = ?`).get(dfd.id)) {
    return res.status(409).json({ error: 'Este DFD já foi consolidado.' });
  }
  const setoresPart = db.prepare(`SELECT finalizado_em FROM dfd_setores WHERE dfd_id = ?`).all(dfd.id);
  if (!setoresPart.length || setoresPart.some(s => !s.finalizado_em)) {
    return res.status(409).json({ error: 'Nem todos os setores finalizaram o lançamento ainda.' });
  }
  // Momento 2: renumera GLOBALMENTE (setores.ordem ASC → numero_pac local
  // ASC), 1..N sobre todos os itens ainda não cancelados.
  const itens = db.prepare(`
    SELECT di.id FROM dfd_itens di JOIN setores s ON s.id = di.setor_id
    WHERE di.dfd_id = ? AND di.excluido_em IS NULL AND di.status_consolidacao != 'cancelado'
    ORDER BY s.ordem ASC, CAST(di.numero_pac AS INTEGER) ASC
  `).all(dfd.id);
  const upd = db.prepare(`UPDATE dfd_itens SET numero_pac = ? WHERE id = ?`);
  itens.forEach((item, i) => upd.run(String(i + 1), item.id));
  db.prepare(`INSERT INTO pac_consolidacoes (dfd_id, consolidado_por, total_itens) VALUES (?, ?, ?)`)
    .run(dfd.id, req.user.user_id, itens.length);
  registrarLog(req, 'PAC', 'GEROU_CONSOLIDACAO', `Gerou a consolidação do DFD "${dfd.titulo}" #${dfd.id} (${itens.length} itens numerados)`);
  res.json({ ok: true, total_itens: itens.length });
});

router.get('/api/pac/dfds/:id/consolidado', pac, requireRotina('pac-gestao', 'ver'), (req, res) => {
  const dfd = db.prepare(`SELECT id FROM dfds WHERE id = ?`).get(req.params.id);
  if (!dfd) return res.status(404).json({ error: 'DFD não encontrado' });
  const consolidacao = db.prepare(`SELECT * FROM pac_consolidacoes WHERE dfd_id = ?`).get(dfd.id);
  res.json({ consolidado: !!consolidacao, consolidacao: consolidacao || null, itens: itensConsolidados(dfd.id) });
});

const STATUS_CONSOLIDACAO_VALIDOS = new Set(['nao_iniciado', 'em_analise', 'finalizado', 'cancelado']);
router.patch('/api/pac/itens/:id/consolidacao', pac, requireRotina('pac-gestao', 'alterar'), (req, res) => {
  const { status, justificativa } = req.body || {};
  if (!STATUS_CONSOLIDACAO_VALIDOS.has(status)) return res.status(400).json({ error: 'Status inválido' });
  if (status === 'cancelado' && !String(justificativa || '').trim()) {
    return res.status(400).json({ error: 'Justificativa é obrigatória para cancelar.' });
  }
  const item = db.prepare(`SELECT id, dfd_id FROM dfd_itens WHERE id = ? AND excluido_em IS NULL`).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item não encontrado' });
  if (status === 'cancelado') {
    db.prepare(`
      UPDATE dfd_itens SET status_consolidacao = 'cancelado', justificativa_cancelamento = ?, cancelado_por = ?, cancelado_em = datetime('now')
      WHERE id = ?
    `).run(String(justificativa).trim(), req.user.user_id, item.id);
  } else {
    db.prepare(`
      UPDATE dfd_itens SET status_consolidacao = ?, justificativa_cancelamento = NULL, cancelado_por = NULL, cancelado_em = NULL WHERE id = ?
    `).run(status, item.id);
  }
  registrarLog(req, 'PAC', 'ALTEROU_STATUS_CONSOLIDACAO',
    `Item #${item.id} (DFD #${item.dfd_id}) → ${status}${status === 'cancelado' ? `: ${String(justificativa).trim()}` : ''}`);
  res.json({ ok: true });
});

router.patch('/api/pac/itens/:id/observacao-consolidacao', pac, requireRotina('pac-gestao', 'alterar'), (req, res) => {
  const item = db.prepare(`SELECT id, dfd_id FROM dfd_itens WHERE id = ? AND excluido_em IS NULL`).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item não encontrado' });
  const observacao = req.body?.observacao;
  db.prepare(`UPDATE dfd_itens SET observacao_consolidacao = ? WHERE id = ?`).run(observacao ? String(observacao).trim() : null, item.id);
  res.json({ ok: true });
});

// Momento 3: reordena de novo, agora excluindo cancelados da sequência ATIVA
// — mas sem mexer no numero_pac que um item cancelado já tinha (índice único
// parcial em database.js permite a sobreposição de propósito). Zera pra NULL
// antes de reatribuir só entre os ativos, mesmo cuidado de sempre passar por
// um estado neutro antes de reescrever uma coluna com índice único (ver nota
// em project_secop_homolog_migracoes: nunca fazer "swap" direto).
function renumerarPacFinal(dfdId) {
  const itensAtivos = db.prepare(`
    SELECT di.id FROM dfd_itens di JOIN setores s ON s.id = di.setor_id
    WHERE di.dfd_id = ? AND di.excluido_em IS NULL AND di.status_consolidacao != 'cancelado'
    ORDER BY s.ordem ASC, CAST(di.numero_pac AS INTEGER) ASC
  `).all(dfdId);
  db.prepare(`
    UPDATE dfd_itens SET numero_pac = NULL
    WHERE dfd_id = ? AND excluido_em IS NULL AND status_consolidacao != 'cancelado'
  `).run(dfdId);
  const upd = db.prepare(`UPDATE dfd_itens SET numero_pac = ? WHERE id = ?`);
  itensAtivos.forEach((item, i) => upd.run(String(i + 1), item.id));
  return itensAtivos.length;
}

router.post('/api/pac/dfds/:dfd_id/setores/:setor_id/finalizar-consolidacao', pac, requireRotina('pac-gestao', 'alterar'), (req, res) => {
  const dfdId = Number(req.params.dfd_id);
  const setorId = Number(req.params.setor_id);
  const dfd = db.prepare(`SELECT id FROM dfds WHERE id = ?`).get(dfdId);
  if (!dfd) return res.status(404).json({ error: 'DFD não encontrado' });
  if (!db.prepare(`SELECT 1 FROM pac_consolidacoes WHERE dfd_id = ?`).get(dfdId)) {
    return res.status(400).json({ error: 'Este DFD ainda não foi consolidado.' });
  }
  const pendentes = db.prepare(`
    SELECT COUNT(*) AS n FROM dfd_itens
    WHERE dfd_id = ? AND setor_id = ? AND excluido_em IS NULL AND status_consolidacao NOT IN ('finalizado', 'cancelado')
  `).get(dfdId, setorId).n;
  if (pendentes > 0) return res.status(409).json({ error: 'Ainda há itens deste setor sem status "Consolidação finalizada" ou "Cancelado".' });
  // Renumera o DFD inteiro, não só o setor que disparou — o exemplo do Alex é
  // exatamente esse: cancelar item no DETIN também desloca a numeração do
  // DEFIN, que vem depois na ordem. Rodar de novo (outro setor finalizando
  // depois) é seguro — recalcula 1..N determinístico sobre quem ainda está ativo.
  const total = renumerarPacFinal(dfdId);
  registrarLog(req, 'PAC', 'FINALIZOU_CONSOLIDACAO_SETOR', `Finalizou a consolidação do setor #${setorId} no DFD #${dfdId} — renumeração final (${total} item(ns) ativo(s))`);
  res.json({ ok: true, total_itens_ativos: total });
});

const STATUS_EXECUCAO_VALIDOS = new Set([
  'Não Iniciado', 'Processado DEPLA', 'Fracionamento Aberto', 'Processo Finalizado', 'Cancelado',
]);
router.patch('/api/pac/itens/:id/status', pac, requireRotina('pac-gestao', 'alterar'), (req, res) => {
  const { status_execucao } = req.body || {};
  if (!STATUS_EXECUCAO_VALIDOS.has(status_execucao)) return res.status(400).json({ error: 'Status inválido' });
  const item = db.prepare(`SELECT id, dfd_id FROM dfd_itens WHERE id = ? AND excluido_em IS NULL`).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item não encontrado' });
  db.prepare(`UPDATE dfd_itens SET status_execucao = ?, atualizado_em = datetime('now') WHERE id = ?`).run(status_execucao, item.id);
  registrarLog(req, 'PAC', 'ALTEROU_STATUS_EXECUCAO', `Item #${item.id} (DFD #${item.dfd_id}) → ${status_execucao}`);
  res.json({ ok: true });
});

// ── PAC: solicitações de contratação (execução ao longo do exercício) ────────
// Rotina própria ('pac-solicitacoes'), independente de 'pac-gestao' — permite
// dar esse acesso a um perfil sem dar Gestão inteira, ou vice-versa.

router.get('/api/pac/dfds/:id/solicitacoes', pac, requireRotina('pac-solicitacoes', 'ver'), (req, res) => {
  const rows = db.prepare(`
    SELECT sol.*, di.numero_pac
    FROM pac_solicitacoes sol LEFT JOIN dfd_itens di ON di.id = sol.item_id
    WHERE sol.dfd_id = ? AND sol.excluido = 0
    ORDER BY sol.data_requisicao DESC, sol.id DESC
  `).all(req.params.id);
  res.json(rows.map(r => ({ ...r, sem_pac: r.item_id === null })));
});

router.get('/api/pac/dfds/:id/solicitacoes/sem-pac', pac, requireRotina('pac-solicitacoes', 'ver'), (req, res) => {
  res.json(db.prepare(`
    SELECT * FROM pac_solicitacoes WHERE dfd_id = ? AND item_id IS NULL AND excluido = 0
    ORDER BY data_requisicao DESC, id DESC
  `).all(req.params.id));
});

function validarItemDaSolicitacao(item_id, dfdId) {
  if (!item_id) return true;
  return !!db.prepare(`SELECT 1 FROM dfd_itens WHERE id = ? AND dfd_id = ? AND excluido_em IS NULL`).get(item_id, dfdId);
}

router.post('/api/pac/dfds/:id/solicitacoes', pac, requireRotina('pac-solicitacoes', 'incluir'), (req, res) => {
  const dfdId = Number(req.params.id);
  const dfd = db.prepare(`SELECT id FROM dfds WHERE id = ?`).get(dfdId);
  if (!dfd) return res.status(404).json({ error: 'DFD não encontrado' });
  const {
    item_id, numero_movimento, numero_sei, data_requisicao, setor_requisitante_id,
    natureza_orcamentaria, descricao_objeto, valor_tu_mlp, valor_rdc, observacao,
  } = req.body || {};
  if (!validarItemDaSolicitacao(item_id, dfdId)) return res.status(400).json({ error: 'Item do PAC inválido para este DFD.' });
  const info = db.prepare(`
    INSERT INTO pac_solicitacoes (
      dfd_id, item_id, numero_movimento, numero_sei, data_requisicao, setor_requisitante_id,
      natureza_orcamentaria, descricao_objeto, valor_tu_mlp, valor_rdc, observacao, criado_por
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    dfdId, item_id || null, numero_movimento ? String(numero_movimento).trim() : null,
    numero_sei ? String(numero_sei).trim() : null, data_requisicao || null,
    setor_requisitante_id || null, natureza_orcamentaria ? String(natureza_orcamentaria).trim() : null,
    descricao_objeto ? String(descricao_objeto).trim() : null, Number(valor_tu_mlp) || 0, Number(valor_rdc) || 0,
    observacao ? String(observacao).trim() : null, req.user.user_id
  );
  registrarLog(req, 'PAC', 'CRIOU_SOLICITACAO',
    `Criou a solicitação #${info.lastInsertRowid} no DFD #${dfdId}${item_id ? ` (item #${item_id})` : ' (sem vínculo ao PAC)'}`);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/api/pac/solicitacoes/:id', pac, requireRotina('pac-solicitacoes', 'alterar'), (req, res) => {
  const sol = db.prepare(`SELECT * FROM pac_solicitacoes WHERE id = ? AND excluido = 0`).get(req.params.id);
  if (!sol) return res.status(404).json({ error: 'Solicitação não encontrada' });
  const {
    item_id, numero_movimento, numero_sei, data_requisicao, setor_requisitante_id,
    natureza_orcamentaria, descricao_objeto, valor_tu_mlp, valor_rdc, observacao,
  } = req.body || {};
  if (!validarItemDaSolicitacao(item_id, sol.dfd_id)) return res.status(400).json({ error: 'Item do PAC inválido para este DFD.' });
  db.prepare(`
    UPDATE pac_solicitacoes SET
      item_id = ?, numero_movimento = ?, numero_sei = ?, data_requisicao = ?, setor_requisitante_id = ?,
      natureza_orcamentaria = ?, descricao_objeto = ?, valor_tu_mlp = ?, valor_rdc = ?, observacao = ?,
      atualizado_em = datetime('now')
    WHERE id = ?
  `).run(
    item_id || null, numero_movimento ? String(numero_movimento).trim() : null,
    numero_sei ? String(numero_sei).trim() : null, data_requisicao || null,
    setor_requisitante_id || null, natureza_orcamentaria ? String(natureza_orcamentaria).trim() : null,
    descricao_objeto ? String(descricao_objeto).trim() : null, Number(valor_tu_mlp) || 0, Number(valor_rdc) || 0,
    observacao ? String(observacao).trim() : null, sol.id
  );
  registrarLog(req, 'PAC', 'EDITOU_SOLICITACAO', `Editou a solicitação #${sol.id}`);
  res.json({ ok: true });
});

router.delete('/api/pac/solicitacoes/:id', pac, requireRotina('pac-solicitacoes', 'excluir'), (req, res) => {
  const sol = db.prepare(`SELECT id FROM pac_solicitacoes WHERE id = ? AND excluido = 0`).get(req.params.id);
  if (!sol) return res.status(404).json({ error: 'Solicitação não encontrada' });
  db.prepare(`UPDATE pac_solicitacoes SET excluido = 1, atualizado_em = datetime('now') WHERE id = ?`).run(sol.id);
  registrarLog(req, 'PAC', 'EXCLUIU_SOLICITACAO', `Excluiu a solicitação #${sol.id}`);
  res.json({ ok: true });
});

// ── PAC: acompanhamento (planejado × realizado) ───────────────────────────────
// "Fonte Pagadora" do item (coluna A, lista TU/RDC/MLP — já existente) decide
// em qual dos 2 baldes de valor estimado ele entra: TU e MLP dividem o mesmo
// balde (valor_tu_mlp), RDC é separado — mesmo agrupamento que a planilha de
// solicitações já usa pros valores realizados (valor_tu_mlp/valor_rdc).
function montarAcompanhamento(dfdId, setorIds) {
  const filtroSetor = setorIds ? ` AND di.setor_id IN (${setorIds.map(() => '?').join(',')})` : '';
  const params = setorIds ? [dfdId, ...setorIds] : [dfdId];
  const itens = db.prepare(`
    SELECT di.id, di.numero_pac, di.codigo_pac, di.numero_item, di.setor_id, di.status_execucao, s.nome AS setor_nome
    FROM dfd_itens di JOIN setores s ON s.id = di.setor_id
    WHERE di.dfd_id = ? AND di.excluido_em IS NULL${filtroSetor}
    ORDER BY di.numero_pac IS NULL, CAST(di.numero_pac AS INTEGER)
  `).all(...params);

  const ids = itens.map(i => i.id);
  const valoresPorItem = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`SELECT item_id, coluna_id, valor FROM dfd_itens_valores WHERE item_id IN (${ph})`).all(...ids)
      .forEach(v => { (valoresPorItem[v.item_id] ??= {})[v.coluna_id] = v.valor; });
  }
  const idDescricao = colunaId('descricao_objeto');
  const idTipo = colunaId('tipo');
  const idValorEstimado = colunaId('valor_estimado');
  const idFontePagadora = colunaId('fonte_pagadora');

  const solicitacoesPorItem = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`SELECT * FROM pac_solicitacoes WHERE item_id IN (${ph}) AND excluido = 0 ORDER BY data_requisicao DESC, id DESC`)
      .all(...ids).forEach(s => { (solicitacoesPorItem[s.item_id] ??= []).push(s); });
  }

  const itensMontados = itens.map(item => {
    const v = valoresPorItem[item.id] || {};
    const valorEstimado = Number(v[idValorEstimado]) || 0;
    const fonte = v[idFontePagadora] || null;
    const sols = solicitacoesPorItem[item.id] || [];
    const realizadoTuMlp = sols.reduce((s, x) => s + (Number(x.valor_tu_mlp) || 0), 0);
    const realizadoRdc = sols.reduce((s, x) => s + (Number(x.valor_rdc) || 0), 0);
    const estimadoTuMlp = fonte === 'RDC' ? 0 : valorEstimado;
    const estimadoRdc = fonte === 'RDC' ? valorEstimado : 0;
    return {
      item_id: item.id, numero_pac: item.numero_pac, codigo_pac: item.codigo_pac, numero_item: item.numero_item,
      setor_id: item.setor_id, setor_nome: item.setor_nome, status_execucao: item.status_execucao,
      descricao_objeto: v[idDescricao] ?? null, tipo: v[idTipo] ?? null, fonte_pagadora: fonte,
      valor_estimado: valorEstimado,
      estimado_tu_mlp: estimadoTuMlp, estimado_rdc: estimadoRdc,
      realizado_tu_mlp: realizadoTuMlp, realizado_rdc: realizadoRdc,
      saldo_tu_mlp: estimadoTuMlp - realizadoTuMlp, saldo_rdc: estimadoRdc - realizadoRdc,
      solicitacoes: sols,
      // Mapa genérico coluna_id → valor (TODAS as colunas do DFD, não só as
      // curadas acima) — pedido do Alex: a tela de Gestão > Acompanhamento
      // precisa ser fiel ao processo do gestor, com as MESMAS colunas de
      // Lançamento (Subitem, Unidade, Prioridade, Contrato...), não só o
      // recorte financeiro que já existia aqui.
      valores: v,
    };
  });

  const totais = itensMontados.reduce((acc, i) => ({
    estimado_tu_mlp: acc.estimado_tu_mlp + i.estimado_tu_mlp,
    estimado_rdc: acc.estimado_rdc + i.estimado_rdc,
    realizado_tu_mlp: acc.realizado_tu_mlp + i.realizado_tu_mlp,
    realizado_rdc: acc.realizado_rdc + i.realizado_rdc,
  }), { estimado_tu_mlp: 0, estimado_rdc: 0, realizado_tu_mlp: 0, realizado_rdc: 0 });
  totais.saldo_tu_mlp = totais.estimado_tu_mlp - totais.realizado_tu_mlp;
  totais.saldo_rdc = totais.estimado_rdc - totais.realizado_rdc;

  return { itens: itensMontados, totais };
}

router.get('/api/pac/dfds/:id/acompanhamento', pac, requireRotina('pac-gestao', 'ver'), (req, res) => {
  const dfd = db.prepare(`SELECT id FROM dfds WHERE id = ?`).get(req.params.id);
  if (!dfd) return res.status(404).json({ error: 'DFD não encontrado' });
  const base = montarAcompanhamento(dfd.id, null);
  const semPac = db.prepare(`
    SELECT * FROM pac_solicitacoes WHERE dfd_id = ? AND item_id IS NULL AND excluido = 0
    ORDER BY data_requisicao DESC, id DESC
  `).all(dfd.id);
  registrarLog(req, 'PAC', 'VIU_ACOMPANHAMENTO', `Visualizou o acompanhamento do DFD #${dfd.id} (visão DEPLA)`);
  res.json({ ...base, sem_pac: semPac });
});

router.get('/api/pac/dfds/:id/acompanhamento/meu-setor', pac, requireRotina('pac-acompanhamento', 'ver'), (req, res) => {
  const dfd = db.prepare(`SELECT id FROM dfds WHERE id = ?`).get(req.params.id);
  if (!dfd) return res.status(404).json({ error: 'DFD não encontrado' });
  const setorIds = req.user.username === 'master'
    ? db.prepare(`SELECT id FROM setores WHERE ativo = 1`).all().map(r => r.id)
    : setoresDoUsuario(req.user.user_id);
  if (!setorIds.length) {
    return res.json({ itens: [], totais: { estimado_tu_mlp: 0, estimado_rdc: 0, realizado_tu_mlp: 0, realizado_rdc: 0, saldo_tu_mlp: 0, saldo_rdc: 0 } });
  }
  registrarLog(req, 'PAC', 'VIU_ACOMPANHAMENTO', `Visualizou o acompanhamento do DFD #${dfd.id} (setor)`);
  res.json(montarAcompanhamento(dfd.id, setorIds));
});

module.exports = router;
