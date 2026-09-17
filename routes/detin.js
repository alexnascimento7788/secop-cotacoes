// ── DETIN: Gestão de Contratos ──────────────────────────────────────────────
// Módulo novo (pedido do Alex, 2026-09-17) — segue o MESMO padrão dos outros
// módulos: requireModulo/requireRotina explícitos em CADA rota (nunca um
// app.use() genérico), registrado em server.js antes do catch-all. Só usa a
// conexão principal (db) pra dado estruturado + anexosDb só pra BLOB (PDF do
// contrato e PDF gerado de cada análise) — mesmo padrão de nota_tecnica em
// routes/secad.js, nunca upload-pra-disco.
const express = require('express');
const { db, anexosDb } = require('../database');
const { registrarLog, requireModulo, requireRotina } = require('../middleware');
const { gerarPdfAnalise, gerarPdfListaContratos, gerarPdfVencimentos, gerarPdfFinanceiroFornecedor, gerarPdfFichaContrato } = require('../detin-pdf');

const router = express.Router();
const detin = requireModulo('detin');

const ANEXO_MAX = 15 * 1024 * 1024; // 15 MB, mesmo teto da Nota Técnica do SECAD

function diasRestantes(dataIso) {
  if (!dataIso) return null;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const alvo = new Date(String(dataIso).split(/[T ]/)[0] + 'T00:00:00');
  if (isNaN(alvo.getTime())) return null;
  return Math.round((alvo - hoje) / 86400000);
}

// Trava por setor (pedido do Alex, 2026-09-17) — mesmo padrão do PAC
// (routes/pac.js, setoresDoUsuario/setor_usuarios): usuário sem vínculo em
// setor_usuarios continua vendo tudo (inclui master/consulta, sempre livres).
// Hoje os 20 contratos seedados têm todos o mesmo setor_id (Detin) — a trava
// só passa a ter efeito prático quando um contrato for atribuído a outro
// setor da tabela compartilhada.
function setoresDoUsuario(userId) {
  return db.prepare(`SELECT setor_id FROM setor_usuarios WHERE user_id = ?`).all(userId).map(r => r.setor_id);
}
function restritoPorSetor(req) {
  return (req.user.username !== 'master' && req.user.role !== 'consulta') ? setoresDoUsuario(req.user.user_id) : [];
}

function contratoRow(id, req) {
  const c = db.prepare(`SELECT * FROM detin_contratos WHERE id = ? AND excluido = 0`).get(id);
  if (!c) return null;
  if (req) {
    const restrito = restritoPorSetor(req);
    if (restrito.length && !restrito.includes(c.setor_id)) return null;
  }
  return c;
}

// Setores/usuários pro formulário de contrato (Setor/Responsável) — rota
// própria do DETIN (não reaproveita /api/pac/setores nem /api/setores porque
// os dois são gated pro módulo deles; setores é uma tabela compartilhada,
// mas cada módulo lê com seu próprio gate, mesmo padrão do resto do projeto).
router.get('/api/detin/setores', detin, requireRotina('detin-contratos', 'ver'), (req, res) => {
  res.json(db.prepare(`SELECT id, nome FROM setores WHERE ativo = 1 ORDER BY ordem`).all());
});
router.get('/api/detin/usuarios', detin, requireRotina('detin-contratos', 'ver'), (req, res) => {
  res.json(db.prepare(`
    SELECT id, COALESCE(nome_completo, username) AS nome FROM users WHERE ativo = 1 ORDER BY nome
  `).all());
});

// Vínculo usuário↔setor pra trava de visibilidade (mesma tabela setor_usuarios
// do PAC — reusada aqui com gate próprio do DETIN, ver restritoPorSetor acima).
router.get('/api/detin/setores/:id/usuarios', detin, requireRotina('detin-contratos', 'alterar'), (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.username, u.nome_completo,
           EXISTS(SELECT 1 FROM setor_usuarios su WHERE su.setor_id = ? AND su.user_id = u.id) AS vinculado
    FROM users u WHERE u.username != 'master' AND u.ativo = 1 ORDER BY COALESCE(u.nome_completo, u.username)
  `).all(req.params.id));
});
router.put('/api/detin/setores/:id/usuarios', detin, requireRotina('detin-contratos', 'alterar'), (req, res) => {
  const { user_id, vinculado } = req.body || {};
  if (vinculado) {
    try { db.prepare(`INSERT INTO setor_usuarios (setor_id, user_id) VALUES (?, ?)`).run(req.params.id, user_id); } catch {}
  } else {
    db.prepare(`DELETE FROM setor_usuarios WHERE setor_id = ? AND user_id = ?`).run(req.params.id, user_id);
  }
  registrarLog(req, 'DETIN', 'SETOR_USUARIO', `${vinculado ? 'Vinculou' : 'Desvinculou'} usuário #${user_id} ao setor #${req.params.id}`);
  res.json({ ok: true });
});

// ── Painel ──────────────────────────────────────────────────────────────────
function montarPainelDados(req) {
  let contratos = db.prepare(`SELECT * FROM detin_contratos WHERE excluido = 0`).all();
  const restrito = restritoPorSetor(req);
  if (restrito.length) contratos = contratos.filter(c => restrito.includes(c.setor_id));
  const ativos = contratos.filter(c => c.status === 'ativo');
  const encerrados = contratos.filter(c => c.status === 'encerrado');

  const valorMensal = c => (c.valor_mensal_efetivo != null ? c.valor_mensal_efetivo : c.valor_mensal) || 0;
  const valor_mensal_total = ativos.reduce((s, c) => s + valorMensal(c), 0);
  const valor_anual_projetado = valor_mensal_total * 12;

  const porFornecedor = {};
  ativos.forEach(c => {
    porFornecedor[c.fornecedor] ??= { fornecedor: c.fornecedor, total: 0, valor_mensal: 0 };
    porFornecedor[c.fornecedor].total++;
    porFornecedor[c.fornecedor].valor_mensal += valorMensal(c);
  });

  const porTipo = {};
  ativos.forEach(c => { porTipo[c.tipo] = (porTipo[c.tipo] || 0) + 1; });

  const comAlerta = ativos
    .map(c => ({ ...c, dias_restantes: diasRestantes(c.data_vencimento) }))
    .filter(c => c.dias_restantes != null && c.dias_restantes <= 60)
    .sort((a, b) => a.dias_restantes - b.dias_restantes);

  // Timeline: próximos 12 meses (a partir do mês corrente), contratos com
  // vencimento dentro de cada mês.
  const timeline = [];
  const base = new Date(); base.setDate(1); base.setHours(0, 0, 0, 0);
  for (let i = 0; i < 12; i++) {
    const mes = new Date(base.getFullYear(), base.getMonth() + i, 1);
    const chave = `${mes.getFullYear()}-${String(mes.getMonth() + 1).padStart(2, '0')}`;
    const doMes = ativos.filter(c => c.data_vencimento && String(c.data_vencimento).slice(0, 7) === chave)
      .map(c => ({ id: c.id, numero_contrato: c.numero_contrato, fornecedor: c.fornecedor, dias_restantes: diasRestantes(c.data_vencimento) }));
    timeline.push({ ano: mes.getFullYear(), mes: mes.getMonth() + 1, contratos: doMes });
  }

  const pendencias = contratos.filter(c => !c.numero_contrato || !c.data_vencimento)
    .map(c => ({ id: c.id, fornecedor: c.fornecedor, numero_contrato: c.numero_contrato, sem_numero: !c.numero_contrato, sem_vencimento: !c.data_vencimento }));

  return {
    total_contratos: contratos.length,
    total_ativos: ativos.length,
    total_encerrados: encerrados.length,
    valor_mensal_total,
    valor_anual_projetado,
    contratos_por_fornecedor: Object.values(porFornecedor).sort((a, b) => b.valor_mensal - a.valor_mensal),
    contratos_por_tipo: Object.entries(porTipo).map(([tipo, total]) => ({ tipo, total })),
    alertas: comAlerta,
    timeline,
    pendencias,
  };
}

router.get('/api/detin/painel', detin, requireRotina('detin-painel', 'ver'), (req, res) => {
  res.json(montarPainelDados(req));
});

// ── Contratos ───────────────────────────────────────────────────────────────
router.get('/api/detin/contratos', detin, requireRotina('detin-contratos', 'ver'), (req, res) => {
  const { status, fornecedor, tipo, setor_id, vencimento_ate } = req.query;
  const cond = ['excluido = 0']; const params = [];
  if (status) { cond.push('status = ?'); params.push(status); }
  if (fornecedor) { cond.push('fornecedor = ?'); params.push(fornecedor); }
  if (tipo) { cond.push('tipo = ?'); params.push(tipo); }
  if (setor_id) { cond.push('setor_id = ?'); params.push(setor_id); }
  if (vencimento_ate) { cond.push('data_vencimento IS NOT NULL AND data_vencimento <= ?'); params.push(vencimento_ate); }
  const restrito = restritoPorSetor(req);
  if (restrito.length) { cond.push(`setor_id IN (${restrito.map(() => '?').join(',')})`); params.push(...restrito); }
  const rows = db.prepare(`
    SELECT * FROM detin_contratos WHERE ${cond.join(' AND ')}
    ORDER BY data_vencimento IS NULL, data_vencimento ASC
  `).all(...params);
  res.json(rows.map(c => ({ ...c, dias_restantes: diasRestantes(c.data_vencimento) })));
});

router.get('/api/detin/contratos/:id', detin, requireRotina('detin-contratos', 'ver'), (req, res) => {
  const c = contratoRow(req.params.id, req);
  if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });
  const temAnexo = !!anexosDb.prepare(`SELECT 1 FROM detin_contrato_anexo WHERE contrato_id = ?`).get(c.id);
  res.json({ ...c, dias_restantes: diasRestantes(c.data_vencimento), tem_anexo: temAnexo });
});

const CAMPOS_CONTRATO = [
  'numero_contrato', 'fornecedor', 'setor_id', 'responsavel_id', 'tipo', 'modalidade',
  'numero_sei', 'status', 'permite_renovacao', 'data_assinatura', 'data_inicio',
  'data_vencimento', 'objeto', 'itens', 'valor_global', 'valor_anual', 'valor_mensal',
  'valor_mensal_efetivo', 'frequencia_pagamento', 'observacao_financeira', 'observacoes',
];

router.post('/api/detin/contratos', detin, requireRotina('detin-contratos', 'incluir'), (req, res) => {
  const body = req.body || {};
  if (!body.fornecedor || !String(body.fornecedor).trim()) return res.status(400).json({ error: 'Fornecedor é obrigatório.' });
  const restrito = restritoPorSetor(req);
  if (restrito.length && !restrito.includes(Number(body.setor_id))) {
    return res.status(403).json({ error: 'Você só pode cadastrar contratos do seu setor.' });
  }
  const campos = CAMPOS_CONTRATO.filter(c => c in body);
  const valores = campos.map(c => body[c] === '' ? null : body[c]);
  const info = db.prepare(`
    INSERT INTO detin_contratos (${campos.join(', ')}, criado_por)
    VALUES (${campos.map(() => '?').join(', ')}, ?)
  `).run(...valores, req.user.user_id);
  registrarLog(req, 'DETIN', 'CRIOU_CONTRATO', `Criou o contrato "${body.numero_contrato || '(sem número)'}" — ${body.fornecedor}`);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/api/detin/contratos/:id', detin, requireRotina('detin-contratos', 'alterar'), (req, res) => {
  const c = contratoRow(req.params.id, req);
  if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });
  const body = req.body || {};
  const campos = CAMPOS_CONTRATO.filter(k => k in body);
  if (!campos.length) return res.status(400).json({ error: 'Nada para salvar.' });
  const sets = campos.map(k => `${k} = ?`).join(', ');
  const valores = campos.map(k => body[k] === '' ? null : body[k]);
  db.prepare(`UPDATE detin_contratos SET ${sets}, atualizado_em = datetime('now') WHERE id = ?`).run(...valores, c.id);
  registrarLog(req, 'DETIN', 'EDITOU_CONTRATO', `Editou o contrato "${c.numero_contrato || '(sem número)'}" — ${c.fornecedor}`);
  res.json({ ok: true });
});

router.delete('/api/detin/contratos/:id', detin, requireRotina('detin-contratos', 'excluir'), (req, res) => {
  const c = contratoRow(req.params.id, req);
  if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });
  db.prepare(`UPDATE detin_contratos SET excluido = 1, atualizado_em = datetime('now') WHERE id = ?`).run(c.id);
  registrarLog(req, 'DETIN', 'EXCLUIU_CONTRATO', `Excluiu o contrato "${c.numero_contrato || '(sem número)'}" — ${c.fornecedor}`);
  res.json({ ok: true });
});

// Anexo do contrato (PDF) — BLOB em anexos.db, 1 arquivo vigente por
// contrato (substituível), mesmo padrão de nota_tecnica em routes/secad.js.
router.post('/api/detin/contratos/:id/anexo', detin, requireRotina('detin-contratos', 'alterar'),
  express.raw({ type: '*/*', limit: '16mb' }),
  (req, res) => {
    const c = contratoRow(req.params.id, req);
    if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const nome = String(req.query.nome || req.headers['x-file-name'] || 'contrato.pdf').slice(0, 180);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Arquivo vazio.' });
    if (mime !== 'application/pdf') return res.status(415).json({ error: 'Envie um arquivo PDF.' });
    if (req.body.length > ANEXO_MAX) return res.status(413).json({ error: 'Arquivo muito grande (máx. 15 MB).' });

    anexosDb.prepare(`
      INSERT INTO detin_contrato_anexo (contrato_id, nome_arquivo, mime, tamanho, conteudo, atualizado_por, atualizado_por_nome, atualizado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(contrato_id) DO UPDATE SET
        nome_arquivo = excluded.nome_arquivo, mime = excluded.mime, tamanho = excluded.tamanho,
        conteudo = excluded.conteudo, atualizado_por = excluded.atualizado_por,
        atualizado_por_nome = excluded.atualizado_por_nome, atualizado_em = excluded.atualizado_em
    `).run(c.id, nome, mime, req.body.length, req.body, req.user.user_id, req.user.username);
    db.prepare(`UPDATE detin_contratos SET anexo_nome = ?, atualizado_em = datetime('now') WHERE id = ?`).run(nome, c.id);
    registrarLog(req, 'DETIN', 'ANEXOU_CONTRATO', `Anexou o PDF do contrato "${c.numero_contrato || '(sem número)'}" (${nome})`);
    res.json({ ok: true });
  }
);

router.get('/api/detin/contratos/:id/anexo', detin, requireRotina('detin-contratos', 'ver'), (req, res) => {
  if (!contratoRow(req.params.id, req)) return res.status(404).json({ error: 'Contrato não encontrado' });
  const row = anexosDb.prepare(`SELECT nome_arquivo, mime, conteudo FROM detin_contrato_anexo WHERE contrato_id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Este contrato não tem PDF anexado.' });
  res.setHeader('Content-Type', row.mime || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.nome_arquivo || 'contrato.pdf')}"`);
  res.send(Buffer.from(row.conteudo));
});

// ── Aditivos ────────────────────────────────────────────────────────────────
router.get('/api/detin/contratos/:id/aditivos', detin, requireRotina('detin-contratos', 'ver'), (req, res) => {
  if (!contratoRow(req.params.id, req)) return res.status(404).json({ error: 'Contrato não encontrado' });
  res.json(db.prepare(`SELECT * FROM detin_aditivos WHERE contrato_id = ? ORDER BY data DESC, id DESC`).all(req.params.id));
});

router.post('/api/detin/contratos/:id/aditivos', detin, requireRotina('detin-contratos', 'alterar'), (req, res) => {
  const c = contratoRow(req.params.id, req);
  if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });
  const { numero_aditivo, data, tipo, descricao, novo_valor_mensal, nova_data_vencimento } = req.body || {};
  if (!tipo) return res.status(400).json({ error: 'Tipo do aditivo é obrigatório.' });
  const info = db.prepare(`
    INSERT INTO detin_aditivos (contrato_id, numero_aditivo, data, tipo, descricao, novo_valor_mensal, nova_data_vencimento, criado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(c.id, numero_aditivo || null, data || null, tipo, descricao || null, novo_valor_mensal || null, nova_data_vencimento || null, req.user.user_id);
  // Aditivo de prazo/valor já reflete no contrato — evita o usuário ter que
  // editar os 2 lugares separadamente pra manter consistente.
  if (nova_data_vencimento) db.prepare(`UPDATE detin_contratos SET data_vencimento = ?, atualizado_em = datetime('now') WHERE id = ?`).run(nova_data_vencimento, c.id);
  if (novo_valor_mensal) db.prepare(`UPDATE detin_contratos SET valor_mensal = ?, atualizado_em = datetime('now') WHERE id = ?`).run(novo_valor_mensal, c.id);
  registrarLog(req, 'DETIN', 'REGISTROU_ADITIVO', `Registrou aditivo (${tipo}) no contrato "${c.numero_contrato || '(sem número)'}"`);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.delete('/api/detin/aditivos/:id', detin, requireRotina('detin-contratos', 'excluir'), (req, res) => {
  const aditivo = db.prepare(`SELECT a.id, c.setor_id FROM detin_aditivos a JOIN detin_contratos c ON c.id = a.contrato_id WHERE a.id = ?`).get(req.params.id);
  if (!aditivo) return res.status(404).json({ error: 'Aditivo não encontrado' });
  const restrito = restritoPorSetor(req);
  if (restrito.length && !restrito.includes(aditivo.setor_id)) return res.status(404).json({ error: 'Aditivo não encontrado' });
  db.prepare(`DELETE FROM detin_aditivos WHERE id = ?`).run(req.params.id);
  registrarLog(req, 'DETIN', 'EXCLUIU_ADITIVO', `Excluiu o aditivo #${req.params.id}`);
  res.json({ ok: true });
});

// ── Análise de contratos ─────────────────────────────────────────────────────
function analiseCompleta(id) {
  const analise = db.prepare(`SELECT * FROM detin_analises WHERE id = ?`).get(id);
  if (!analise) return null;
  const contratos = db.prepare(`
    SELECT dac.*, c.numero_contrato, c.fornecedor, c.tipo, c.status, c.objeto, c.data_vencimento, c.valor_mensal, c.valor_mensal_efetivo
    FROM detin_analise_contratos dac JOIN detin_contratos c ON c.id = dac.contrato_id
    WHERE dac.analise_id = ? ORDER BY dac.id
  `).all(id).map(c => ({ ...c, dias_restantes: diasRestantes(c.data_vencimento) }));
  return { ...analise, contratos };
}

router.get('/api/detin/analises', detin, requireRotina('detin-analise', 'ver'), (req, res) => {
  res.json(db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM detin_analise_contratos WHERE analise_id = a.id) AS total_contratos
    FROM detin_analises a ORDER BY a.id DESC
  `).all());
});

router.post('/api/detin/analises', detin, requireRotina('detin-analise', 'incluir'), (req, res) => {
  const { titulo, contrato_ids } = req.body || {};
  if (!titulo || !String(titulo).trim()) return res.status(400).json({ error: 'Informe um título.' });
  if (!Array.isArray(contrato_ids) || !contrato_ids.length) return res.status(400).json({ error: 'Selecione ao menos 1 contrato.' });
  const info = db.prepare(`INSERT INTO detin_analises (titulo, criado_por) VALUES (?, ?)`).run(String(titulo).trim(), req.user.user_id);
  const analiseId = info.lastInsertRowid;
  const ins = db.prepare(`INSERT INTO detin_analise_contratos (analise_id, contrato_id) VALUES (?, ?)`);
  contrato_ids.forEach(cid => { try { ins.run(analiseId, cid); } catch {} });
  registrarLog(req, 'DETIN', 'CRIOU_ANALISE', `Criou a análise "${titulo}" com ${contrato_ids.length} contrato(s)`);
  res.status(201).json({ id: analiseId });
});

router.get('/api/detin/analises/:id', detin, requireRotina('detin-analise', 'ver'), (req, res) => {
  const a = analiseCompleta(req.params.id);
  if (!a) return res.status(404).json({ error: 'Análise não encontrada' });
  res.json(a);
});

router.put('/api/detin/analises/:id/respostas', detin, requireRotina('detin-analise', 'incluir'), (req, res) => {
  const analise = db.prepare(`SELECT id, finalizado FROM detin_analises WHERE id = ?`).get(req.params.id);
  if (!analise) return res.status(404).json({ error: 'Análise não encontrada' });
  if (analise.finalizado) return res.status(409).json({ error: 'Esta análise já foi finalizada (PDF gerado) — não pode mais ser editada.' });
  const { contrato_id, resp_reducao_linear, resp_alteracao_objeto, resp_renovacao, resp_sugestao_reducao, resp_contrato_similar, observacoes } = req.body || {};
  if (!contrato_id) return res.status(400).json({ error: 'contrato_id é obrigatório.' });
  const info = db.prepare(`
    UPDATE detin_analise_contratos SET
      resp_reducao_linear = ?, resp_alteracao_objeto = ?, resp_renovacao = ?,
      resp_sugestao_reducao = ?, resp_contrato_similar = ?, observacoes = ?
    WHERE analise_id = ? AND contrato_id = ?
  `).run(
    resp_reducao_linear ?? null, resp_alteracao_objeto ?? null, resp_renovacao ?? null,
    resp_sugestao_reducao ?? null, resp_contrato_similar ?? null, observacoes ?? null,
    analise.id, contrato_id
  );
  if (!info.changes) return res.status(404).json({ error: 'Este contrato não faz parte desta análise.' });
  res.json({ ok: true });
});

// Prévia do PDF — pedido do Alex, 2026-09-17: ver o layout antes de finalizar.
// Mesmo gerarPdfAnalise da versão definitiva (inclui a 1ª página financeira),
// mas NUNCA grava em anexosDb nem marca finalizado — pode ser chamada quantas
// vezes quiser, a qualquer momento da Fase 2, mesmo com perguntas em branco
// ("(não respondido)" já é o fallback natural do gerador).
router.get('/api/detin/analises/:id/preview-pdf', detin, requireRotina('detin-analise', 'incluir'), async (req, res) => {
  const a = analiseCompleta(req.params.id);
  if (!a) return res.status(404).json({ error: 'Análise não encontrada' });
  if (!a.contratos.length) return res.status(409).json({ error: 'Esta análise não tem contratos.' });
  try {
    const pdfBuffer = await gerarPdfAnalise(a, req.user.nome_completo || req.user.username);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="previa-analise.pdf"');
    res.send(pdfBuffer);
  } catch (e) {
    console.error('[detin] erro gerando prévia do PDF de análise:', e);
    res.status(500).json({ error: 'Erro ao gerar a prévia. Tente novamente.' });
  }
});

router.post('/api/detin/analises/:id/gerar-pdf', detin, requireRotina('detin-analise', 'incluir'), async (req, res) => {
  const a = analiseCompleta(req.params.id);
  if (!a) return res.status(404).json({ error: 'Análise não encontrada' });
  if (!a.contratos.length) return res.status(409).json({ error: 'Esta análise não tem contratos.' });
  try {
    const pdfBuffer = await gerarPdfAnalise(a, req.user.nome_completo || req.user.username);
    const nome = `analise-${a.id}.pdf`;
    anexosDb.prepare(`
      INSERT INTO detin_analise_pdf (analise_id, nome_arquivo, mime, tamanho, conteudo, gerado_por, gerado_em)
      VALUES (?, ?, 'application/pdf', ?, ?, ?, datetime('now'))
      ON CONFLICT(analise_id) DO UPDATE SET
        nome_arquivo = excluded.nome_arquivo, tamanho = excluded.tamanho, conteudo = excluded.conteudo,
        gerado_por = excluded.gerado_por, gerado_em = excluded.gerado_em
    `).run(a.id, nome, pdfBuffer.length, pdfBuffer, req.user.user_id);
    db.prepare(`UPDATE detin_analises SET finalizado = 1, pdf_gerado_em = datetime('now') WHERE id = ?`).run(a.id);
    registrarLog(req, 'DETIN', 'GEROU_PDF_ANALISE', `Gerou o PDF da análise "${a.titulo}" (${a.contratos.length} contrato(s))`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nome}"`);
    res.send(pdfBuffer);
  } catch (e) {
    console.error('[detin] erro gerando PDF de análise:', e);
    res.status(500).json({ error: 'Erro ao gerar o PDF. Tente novamente.' });
  }
});

router.get('/api/detin/analises/:id/pdf', detin, requireRotina('detin-analise', 'ver'), (req, res) => {
  const row = anexosDb.prepare(`SELECT nome_arquivo, conteudo FROM detin_analise_pdf WHERE analise_id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'PDF ainda não foi gerado para esta análise.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.nome_arquivo || 'analise.pdf')}"`);
  res.send(Buffer.from(row.conteudo));
});

// ── Relatórios prontos (fora do fluxo de Análise) ────────────────────────────
// Pedido do Alex, 2026-09-17: relatórios em PDF direto da listagem/painel,
// sem passar pelo wizard de análise. Mesmo padrão de streaming inline dos
// PDFs de análise/nota técnica — nunca grava em disco.
router.get('/api/detin/relatorios/contratos', detin, requireRotina('detin-contratos', 'ver'), async (req, res) => {
  const { status, fornecedor, tipo, setor_id, vencimento_ate } = req.query;
  const cond = ['excluido = 0']; const params = []; const filtrosTexto = [];
  if (status) { cond.push('status = ?'); params.push(status); filtrosTexto.push(`status: ${status}`); }
  if (fornecedor) { cond.push('fornecedor = ?'); params.push(fornecedor); filtrosTexto.push(`fornecedor: ${fornecedor}`); }
  if (tipo) { cond.push('tipo = ?'); params.push(tipo); filtrosTexto.push(`tipo: ${tipo}`); }
  if (setor_id) { cond.push('setor_id = ?'); params.push(setor_id); }
  if (vencimento_ate) { cond.push('data_vencimento IS NOT NULL AND data_vencimento <= ?'); params.push(vencimento_ate); filtrosTexto.push(`vencimento até: ${vencimento_ate}`); }
  const restrito = restritoPorSetor(req);
  if (restrito.length) { cond.push(`setor_id IN (${restrito.map(() => '?').join(',')})`); params.push(...restrito); }
  const rows = db.prepare(`
    SELECT * FROM detin_contratos WHERE ${cond.join(' AND ')}
    ORDER BY data_vencimento IS NULL, data_vencimento ASC
  `).all(...params).map(c => ({ ...c, dias_restantes: diasRestantes(c.data_vencimento) }));
  try {
    const pdfBuffer = await gerarPdfListaContratos(rows, filtrosTexto.join(' · '), req.user.nome_completo || req.user.username);
    registrarLog(req, 'DETIN', 'GEROU_RELATORIO', `Gerou o relatório "Lista de Contratos" (${rows.length} contrato(s))`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="detin-lista-contratos.pdf"');
    res.send(pdfBuffer);
  } catch (e) {
    console.error('[detin] erro gerando relatório de lista:', e);
    res.status(500).json({ error: 'Erro ao gerar o relatório.' });
  }
});

router.get('/api/detin/relatorios/vencimentos', detin, requireRotina('detin-contratos', 'ver'), async (req, res) => {
  const dias = Number(req.query.dias) || 90;
  let contratos = db.prepare(`SELECT * FROM detin_contratos WHERE excluido = 0 AND status = 'ativo'`).all();
  const restrito = restritoPorSetor(req);
  if (restrito.length) contratos = contratos.filter(c => restrito.includes(c.setor_id));
  const alertas = contratos
    .map(c => ({ ...c, dias_restantes: diasRestantes(c.data_vencimento) }))
    .filter(c => c.dias_restantes != null && c.dias_restantes <= dias)
    .sort((a, b) => a.dias_restantes - b.dias_restantes);
  try {
    const pdfBuffer = await gerarPdfVencimentos(alertas, dias, req.user.nome_completo || req.user.username);
    registrarLog(req, 'DETIN', 'GEROU_RELATORIO', `Gerou o relatório "Vencimentos" (${alertas.length} contrato(s), janela de ${dias} dias)`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="detin-vencimentos.pdf"');
    res.send(pdfBuffer);
  } catch (e) {
    console.error('[detin] erro gerando relatório de vencimentos:', e);
    res.status(500).json({ error: 'Erro ao gerar o relatório.' });
  }
});

router.get('/api/detin/relatorios/financeiro', detin, requireRotina('detin-contratos', 'ver'), async (req, res) => {
  const dados = montarPainelDados(req);
  try {
    const pdfBuffer = await gerarPdfFinanceiroFornecedor(dados, req.user.nome_completo || req.user.username);
    registrarLog(req, 'DETIN', 'GEROU_RELATORIO', `Gerou o relatório "Financeiro por Fornecedor"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="detin-financeiro.pdf"');
    res.send(pdfBuffer);
  } catch (e) {
    console.error('[detin] erro gerando relatório financeiro:', e);
    res.status(500).json({ error: 'Erro ao gerar o relatório.' });
  }
});

router.get('/api/detin/contratos/:id/ficha', detin, requireRotina('detin-contratos', 'ver'), async (req, res) => {
  const c = contratoRow(req.params.id, req);
  if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });
  const setorNome = c.setor_id ? db.prepare(`SELECT nome FROM setores WHERE id = ?`).get(c.setor_id)?.nome : null;
  const responsavelNome = c.responsavel_id ? db.prepare(`SELECT COALESCE(nome_completo, username) AS nome FROM users WHERE id = ?`).get(c.responsavel_id)?.nome : null;
  const aditivos = db.prepare(`SELECT * FROM detin_aditivos WHERE contrato_id = ? ORDER BY data DESC, id DESC`).all(c.id);
  try {
    const pdfBuffer = await gerarPdfFichaContrato({ ...c, dias_restantes: diasRestantes(c.data_vencimento), setor_nome: setorNome, responsavel_nome: responsavelNome }, aditivos, req.user.nome_completo || req.user.username);
    registrarLog(req, 'DETIN', 'GEROU_RELATORIO', `Gerou a ficha do contrato "${c.numero_contrato || '(sem número)'}" — ${c.fornecedor}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="detin-ficha-${c.id}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    console.error('[detin] erro gerando ficha do contrato:', e);
    res.status(500).json({ error: 'Erro ao gerar a ficha.' });
  }
});

module.exports = router;
