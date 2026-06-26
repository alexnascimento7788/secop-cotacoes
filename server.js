const express = require('express');
const path = require('path');
const { db, gerarNumeroProcesso } = require('./database');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// node:sqlite rejects undefined — coerce to null
const n = v => (v === undefined ? null : v);

// ── Processos ─────────────────────────────────────────────────────────────────

app.get('/api/processos', (req, res) => {
  const { status, setor, busca } = req.query;
  let sql = `SELECT *, CAST((julianday('now') - julianday(criado_em)) AS INTEGER) AS dias_em_aberto FROM processos WHERE 1=1`;
  const params = [];

  if (status) { sql += ` AND status = ?`; params.push(status); }
  if (setor)  { sql += ` AND setor_solicitante = ?`; params.push(setor); }
  if (busca)  { sql += ` AND (objeto LIKE ? OR numero_processo LIKE ? OR responsavel LIKE ?)`; params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`); }

  sql += ` ORDER BY id DESC`;
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/processos', (req, res) => {
  const { objeto, setor_solicitante, tipo_contratacao, responsavel, descricao,
          previsao_inicio, previsao_termino, observacoes, observacoes2, data_abertura } = req.body;

  if (!objeto) return res.status(400).json({ error: 'Objeto é obrigatório' });

  const numero_processo = gerarNumeroProcesso();
  const info = db.prepare(`
    INSERT INTO processos (numero_processo, objeto, setor_solicitante, tipo_contratacao,
      responsavel, descricao, previsao_inicio, previsao_termino, observacoes, observacoes2, data_abertura)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(numero_processo, n(objeto), n(setor_solicitante), n(tipo_contratacao), n(responsavel),
         n(descricao), n(previsao_inicio), n(previsao_termino), n(observacoes), n(observacoes2), n(data_abertura));

  res.status(201).json({ id: info.lastInsertRowid, numero_processo });
});

app.get('/api/processos/:id', (req, res) => {
  const processo = db.prepare(`
    SELECT *, CAST((julianday('now') - julianday(criado_em)) AS INTEGER) AS dias_em_aberto
    FROM processos WHERE id = ?
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

app.put('/api/processos/:id', (req, res) => {
  const { objeto, setor_solicitante, tipo_contratacao, responsavel, descricao,
          previsao_inicio, previsao_termino, status, observacoes, observacoes2, data_abertura } = req.body;

  const existe = db.prepare(`SELECT id FROM processos WHERE id = ?`).get(req.params.id);
  if (!existe) return res.status(404).json({ error: 'Não encontrado' });

  db.prepare(`
    UPDATE processos SET objeto=?, setor_solicitante=?, tipo_contratacao=?, responsavel=?,
      descricao=?, previsao_inicio=?, previsao_termino=?, status=?, observacoes=?,
      observacoes2=?, data_abertura=?, atualizado_em=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(n(objeto), n(setor_solicitante), n(tipo_contratacao), n(responsavel), n(descricao),
         n(previsao_inicio), n(previsao_termino), n(status), n(observacoes),
         n(observacoes2), n(data_abertura), req.params.id);

  res.json({ ok: true });
});

app.delete('/api/processos/:id', (req, res) => {
  db.prepare(`DELETE FROM processos WHERE id = ?`).run(req.params.id);
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

app.post('/api/processos/:id/fornecedores', (req, res) => {
  const { nome, contato, telefone, celular, email, data_proposta,
          prazo_pagamento, prazo_entrega, prazo_garantia, frete,
          proposta_inicial, proposta_final, observacoes } = req.body;

  const countRow = db.prepare(`SELECT COUNT(*) AS c FROM fornecedores WHERE processo_id = ?`).get(req.params.id);
  const ordem = (countRow.c || 0) + 1;

  const info = db.prepare(`
    INSERT INTO fornecedores (processo_id, ordem, nome, contato, telefone, celular, email,
      data_proposta, prazo_pagamento, prazo_entrega, prazo_garantia, frete,
      proposta_inicial, proposta_final, observacoes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, ordem, n(nome), n(contato), n(telefone), n(celular), n(email),
         n(data_proposta), n(prazo_pagamento), n(prazo_entrega), n(prazo_garantia), n(frete),
         n(proposta_inicial), n(proposta_final), n(observacoes));

  res.status(201).json({ id: info.lastInsertRowid });
});

app.put('/api/fornecedores/:id', (req, res) => {
  const { nome, contato, telefone, celular, email, data_proposta,
          prazo_pagamento, prazo_entrega, prazo_garantia, frete,
          proposta_inicial, proposta_final, observacoes } = req.body;

  db.prepare(`
    UPDATE fornecedores SET nome=?, contato=?, telefone=?, celular=?, email=?,
      data_proposta=?, prazo_pagamento=?, prazo_entrega=?, prazo_garantia=?, frete=?,
      proposta_inicial=?, proposta_final=?, observacoes=?
    WHERE id=?
  `).run(n(nome), n(contato), n(telefone), n(celular), n(email), n(data_proposta), n(prazo_pagamento),
         n(prazo_entrega), n(prazo_garantia), n(frete), n(proposta_inicial), n(proposta_final), n(observacoes), req.params.id);

  res.json({ ok: true });
});

app.delete('/api/fornecedores/:id', (req, res) => {
  db.prepare(`DELETE FROM fornecedores WHERE id = ?`).run(req.params.id);
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

app.post('/api/processos/:id/itens', (req, res) => {
  const { item_num, quantidade, unidade, descricao } = req.body;
  const info = db.prepare(`
    INSERT INTO itens (processo_id, item_num, quantidade, unidade, descricao)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.params.id, n(item_num), n(quantidade), n(unidade), n(descricao));
  res.status(201).json({ id: info.lastInsertRowid });
});

app.put('/api/itens/:id', (req, res) => {
  const { item_num, quantidade, unidade, descricao } = req.body;
  db.prepare(`UPDATE itens SET item_num=?, quantidade=?, unidade=?, descricao=? WHERE id=?`)
    .run(n(item_num), n(quantidade), n(unidade), n(descricao), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/itens/:id', (req, res) => {
  db.prepare(`DELETE FROM itens WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Preços ────────────────────────────────────────────────────────────────────

app.post('/api/precos', (req, res) => {
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
  const em_cotacao   = db.prepare(`SELECT COUNT(*) AS c FROM processos WHERE status='Em cotação'`).get().c;
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
       OR (status != 'Concluído' AND CAST((julianday('now') - julianday(atualizado_em)) AS INTEGER) > 15)
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

app.put('/api/processos/:id/vencedor/:fornecedor_id', (req, res) => {
  db.prepare(`UPDATE processos SET proposta_vencedora_id=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`)
    .run(req.params.fornecedor_id, req.params.id);
  res.json({ ok: true });
});

// ── Menor preço ───────────────────────────────────────────────────────────────

app.patch('/api/processos/:id/mostrar-menor-preco', (req, res) => {
  const { mostrar } = req.body;
  db.prepare(`UPDATE processos SET mostrar_menor_preco=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`)
    .run(mostrar ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ── Status rápido ─────────────────────────────────────────────────────────────

app.patch('/api/processos/:id/status', (req, res) => {
  const { status } = req.body;
  const atual = db.prepare(`SELECT status FROM processos WHERE id=?`).get(req.params.id);
  if (!atual) return res.status(404).json({ error: 'Não encontrado' });
  db.prepare(`UPDATE processos SET status=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status, req.params.id);
  db.prepare(`INSERT INTO status_historico (processo_id, status_de, status_para) VALUES (?,?,?)`)
    .run(req.params.id, atual.status, status);
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

// ── Setores (lista única para filtros) ────────────────────────────────────────

app.get('/api/setores', (req, res) => {
  const rows = db.prepare(`SELECT DISTINCT setor_solicitante FROM processos WHERE setor_solicitante IS NOT NULL ORDER BY setor_solicitante`).all();
  res.json(rows.map(r => r.setor_solicitante));
});

// ── Serve SPA ─────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SECOP Cotações rodando em http://localhost:${PORT}`);
});
