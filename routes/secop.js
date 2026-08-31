// ── SECOP: Cotações (processos/fornecedores/itens/preços/dashboard) ───────────
// Extraído de server.js na modularização por módulo — zero mudança de
// comportamento. Cada rota leva `requireModulo('secop')` explícito (const
// `secop` abaixo), substituindo o antigo gate por lista de prefixos
// (SECOP_PREFIXOS, que vivia em server.js) — mesmo efeito, mas sem depender de
// manter uma lista de prefixos sincronizada com as rotas de fato.
//
// NÃO estão aqui (ficam em routes/admin.js de propósito — ver comentário no
// topo daquele arquivo): /api/admin/lixeira* e /api/config + /api/admin/config
// + /api/tipos-contratacao* + /api/tipos-extra* — hoje NENHuma dessas é gateada
// por módulo (lixeira só por requireAdminAny; as outras 3 nem isso, de
// propósito, pra admin.html gerenciar de qualquer módulo ativo).
const express = require('express');
const { db, gerarNumeroProcesso } = require('../database');
const { n, registrarLog, requireModulo, getLixeiraDias, getSecopEdicaoLivre } = require('../middleware');

// Dicionário geral de português (já vem ordenado por frequência de uso do
// idioma) — recorte das mais comuns, apoia o autocomplete quando o histórico
// real da cotação ainda não tem a palavra digitada.
const DICIONARIO_PT = require('an-array-of-portuguese-words')
  .filter(w => w.length >= 3)
  .slice(0, 30000);

const router = express.Router();
const secop = requireModulo('secop');

// ── Permissões de cotação (dono ou admin, ou liberado pra todos via parâmetro) ──

function podeEditarProcesso(user, processoId) {
  if (getSecopEdicaoLivre()) return true;
  if (user.role === 'admin' || user.role === 'admin_sistema' || user.role === 'admin_operacional') return true;
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

// Purga definitiva de processos que já passaram do prazo na Lixeira — não
// existe "excluir" manual na Lixeira, só esta purga por tempo (ver a rota
// GET /api/admin/lixeira em routes/admin.js). Autoexecuta ao carregar este
// módulo (uma vez no boot + hora em hora), como já era em server.js.
// getLixeiraDias vem de ../middleware (também usado pela rota de lixeira em admin.js).
function purgarLixeira() {
  try {
    db.prepare(`DELETE FROM processos WHERE excluido_em IS NOT NULL AND excluido_em < datetime('now', '-' || ? || ' days')`)
      .run(getLixeiraDias());
  } catch {}
}
purgarLixeira();
setInterval(purgarLixeira, 60 * 60 * 1000); // checa a cada hora

// ── Processos ─────────────────────────────────────────────────────────────────

router.get('/api/processos', secop, (req, res) => {
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

router.post('/api/processos', secop, (req, res) => {
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

router.get('/api/processos/:id', secop, (req, res) => {
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
router.post('/api/processos/:id/duplicar', secop, (req, res) => {
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
    INSERT INTO fornecedores (processo_id, ordem, nome, contato, telefone, celular, telefone_ddd, celular_ddd, email,
      prazo_pagamento, prazo_entrega, prazo_garantia, frete, frete_termo,
      pesquisa_internet, pesquisa_compra_publica, declinio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  fornecedores.forEach(f => insertForn.run(novoId, f.ordem, f.nome, f.contato, f.telefone, f.celular, f.telefone_ddd, f.celular_ddd, f.email,
    f.prazo_pagamento, f.prazo_entrega, f.prazo_garantia, f.frete, f.frete_termo,
    f.pesquisa_internet, f.pesquisa_compra_publica, f.declinio));

  registrarLog(req, 'PROCESSO', 'DUPLICOU', `Duplicou processo ${original.numero_processo} (${original.objeto}) em ${numero_processo}`);

  res.status(201).json({ id: novoId, numero_processo });
});

router.put('/api/processos/:id', secop, requireEditProcesso(req => req.params.id), (req, res) => {
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

router.delete('/api/processos/:id', secop, requireEditProcesso(req => req.params.id), (req, res) => {
  const proc = db.prepare(`SELECT numero_processo, objeto FROM processos WHERE id = ?`).get(req.params.id);
  // Soft-delete: vai pra Lixeira (Configurações), não some de vez — só quem tem
  // acesso_avancado/master enxerga e pode restaurar; purga automática depois de
  // config.lixeira_dias (ver purgarLixeira)
  db.prepare(`UPDATE processos SET excluido_em = datetime('now') WHERE id = ?`).run(req.params.id);
  if (proc) registrarLog(req, 'PROCESSO', 'EXCLUIU', `Excluiu processo ${proc.numero_processo}: ${proc.objeto} (movido para lixeira)`);
  res.json({ ok: true });
});

// ── Fornecedores ──────────────────────────────────────────────────────────────

router.get('/api/processos/:id/fornecedores', secop, (req, res) => {
  res.json(db.prepare(`SELECT * FROM fornecedores WHERE processo_id = ? ORDER BY ordem`).all(req.params.id));
});

router.get('/api/fornecedores/:id', secop, (req, res) => {
  const f = db.prepare(`SELECT * FROM fornecedores WHERE id = ?`).get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Não encontrado' });
  const precos = db.prepare(`SELECT * FROM precos WHERE fornecedor_id = ?`).all(req.params.id);
  res.json({ ...f, precos });
});

router.post('/api/processos/:id/fornecedores', secop, requireEditProcesso(req => req.params.id), (req, res) => {
  const { nome, contato, telefone, celular, telefone_ddd, celular_ddd, email, data_proposta,
          prazo_pagamento, prazo_entrega, prazo_garantia, frete, frete_termo,
          proposta_inicial, proposta_final, observacoes, pesquisa_internet, pesquisa_compra_publica, declinio } = req.body;

  const countRow = db.prepare(`SELECT COUNT(*) AS c FROM fornecedores WHERE processo_id = ?`).get(req.params.id);
  const ordem = (countRow.c || 0) + 1;

  const info = db.prepare(`
    INSERT INTO fornecedores (processo_id, ordem, nome, contato, telefone, celular, telefone_ddd, celular_ddd, email,
      data_proposta, prazo_pagamento, prazo_entrega, prazo_garantia, frete, frete_termo,
      proposta_inicial, proposta_final, observacoes, pesquisa_internet, pesquisa_compra_publica, declinio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, ordem, n(nome), n(contato), n(telefone), n(celular), n(telefone_ddd), n(celular_ddd), n(email),
         n(data_proposta), n(prazo_pagamento), n(prazo_entrega), n(prazo_garantia), n(frete), n(frete_termo),
         n(proposta_inicial), n(proposta_final), n(observacoes), pesquisa_internet ? 1 : 0, pesquisa_compra_publica ? 1 : 0, declinio ? 1 : 0);

  const proc = db.prepare(`SELECT numero_processo FROM processos WHERE id = ?`).get(req.params.id);
  registrarLog(req, 'FORNECEDOR', 'CRIOU', `Adicionou fornecedor "${nome}" ao processo ${proc?.numero_processo || req.params.id}`);

  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/api/fornecedores/:id', secop, requireEditProcesso(req => processoIdDoFornecedor(req.params.id)), (req, res) => {
  const { nome, contato, telefone, celular, telefone_ddd, celular_ddd, email, data_proposta,
          prazo_pagamento, prazo_entrega, prazo_garantia, frete, frete_termo,
          proposta_inicial, proposta_final, observacoes, pesquisa_internet, pesquisa_compra_publica, declinio } = req.body;

  db.prepare(`
    UPDATE fornecedores SET nome=?, contato=?, telefone=?, celular=?, telefone_ddd=?, celular_ddd=?, email=?,
      data_proposta=?, prazo_pagamento=?, prazo_entrega=?, prazo_garantia=?, frete=?, frete_termo=?,
      proposta_inicial=?, proposta_final=?, observacoes=?, pesquisa_internet=?, pesquisa_compra_publica=?, declinio=?
    WHERE id=?
  `).run(n(nome), n(contato), n(telefone), n(celular), n(telefone_ddd), n(celular_ddd), n(email), n(data_proposta), n(prazo_pagamento),
         n(prazo_entrega), n(prazo_garantia), n(frete), n(frete_termo), n(proposta_inicial), n(proposta_final), n(observacoes),
         pesquisa_internet ? 1 : 0, pesquisa_compra_publica ? 1 : 0, declinio ? 1 : 0, req.params.id);

  res.json({ ok: true });
});

router.delete('/api/fornecedores/:id', secop, requireEditProcesso(req => processoIdDoFornecedor(req.params.id)), (req, res) => {
  const f = db.prepare(`SELECT nome, processo_id FROM fornecedores WHERE id = ?`).get(req.params.id);
  db.prepare(`DELETE FROM fornecedores WHERE id = ?`).run(req.params.id);
  if (f) {
    const proc = db.prepare(`SELECT numero_processo FROM processos WHERE id = ?`).get(f.processo_id);
    registrarLog(req, 'FORNECEDOR', 'EXCLUIU', `Removeu fornecedor "${f.nome}" do processo ${proc?.numero_processo || f.processo_id}`);
  }
  res.json({ ok: true });
});

// ── Itens ─────────────────────────────────────────────────────────────────────

router.get('/api/processos/:id/itens', secop, (req, res) => {
  const itens = db.prepare(`SELECT * FROM itens WHERE processo_id = ? ORDER BY item_num`).all(req.params.id);
  const result = itens.map(item => {
    const precos = db.prepare(`SELECT * FROM precos WHERE item_id = ?`).all(item.id);
    return { ...item, precos };
  });
  res.json(result);
});

router.post('/api/processos/:id/itens', secop, requireEditProcesso(req => req.params.id), (req, res) => {
  const { item_num, quantidade, unidade, descricao, extra } = req.body;
  const info = db.prepare(`
    INSERT INTO itens (processo_id, item_num, quantidade, unidade, descricao, extra)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.params.id, n(item_num), n(quantidade), n(unidade), n(descricao), extra ? 1 : 0);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/api/itens/:id', secop, requireEditProcesso(req => processoIdDoItem(req.params.id)), (req, res) => {
  const { item_num, quantidade, unidade, descricao } = req.body;
  db.prepare(`UPDATE itens SET item_num=?, quantidade=?, unidade=?, descricao=? WHERE id=?`)
    .run(n(item_num), n(quantidade), n(unidade), n(descricao), req.params.id);
  res.json({ ok: true });
});

router.delete('/api/itens/:id', secop, requireEditProcesso(req => processoIdDoItem(req.params.id)), (req, res) => {
  db.prepare(`DELETE FROM itens WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Preços ────────────────────────────────────────────────────────────────────

router.post('/api/precos', secop, requireEditProcesso(req => processoIdDoItem(req.body.item_id)), (req, res) => {
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

router.get('/api/dashboard/resumo', secop, (req, res) => {
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

router.put('/api/processos/:id/vencedor/:fornecedor_id', secop, requireEditProcesso(req => req.params.id), (req, res) => {
  db.prepare(`UPDATE processos SET proposta_vencedora_id=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`)
    .run(req.params.fornecedor_id, req.params.id);
  res.json({ ok: true });
});

// ── Menor preço ───────────────────────────────────────────────────────────────

router.patch('/api/processos/:id/mostrar-menor-preco', secop, requireEditProcesso(req => req.params.id), (req, res) => {
  const { mostrar } = req.body;
  db.prepare(`UPDATE processos SET mostrar_menor_preco=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`)
    .run(mostrar ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ── Status rápido ─────────────────────────────────────────────────────────────

router.patch('/api/processos/:id/status', secop, requireEditProcesso(req => req.params.id), (req, res) => {
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

// ── Status ────────────────────────────────────────────────────────────────────

router.get('/api/status', secop, (req, res) => {
  res.json(db.prepare(`SELECT * FROM status ORDER BY ordem`).all());
});

router.post('/api/status', secop, (req, res) => {
  const { nome, ordem } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  const info = db.prepare(`INSERT INTO status (nome, ordem) VALUES (?, ?)`).run(nome, n(ordem) ?? 0);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/api/status/:id', secop, (req, res) => {
  const { nome, ordem } = req.body;
  db.prepare(`UPDATE status SET nome=?, ordem=? WHERE id=?`).run(nome, n(ordem) ?? 0, req.params.id);
  res.json({ ok: true });
});

router.delete('/api/status/:id', secop, (req, res) => {
  db.prepare(`DELETE FROM status WHERE id=?`).run(req.params.id);
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

router.get('/api/autocomplete/:campo', secop, (req, res) => {
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

router.get('/api/autocomplete/:campo/palavras', secop, (req, res) => {
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

router.get('/api/dicionario-pt', secop, (req, res) => {
  res.json(DICIONARIO_PT);
});

// ── Setores (lista única para filtros) ────────────────────────────────────────

router.get('/api/setores', secop, (req, res) => {
  const rows = db.prepare(`SELECT DISTINCT setor_solicitante FROM processos WHERE setor_solicitante IS NOT NULL AND excluido_em IS NULL ORDER BY setor_solicitante`).all();
  res.json(rows.map(r => r.setor_solicitante));
});

module.exports = router;
