// ── API do motor de notificação por e-mail (Admin → Comunicação) ───────────
// Transversal (não é um "módulo" da plataforma, não passa por requireModulo)
// — mesmo padrão de routes/admin.js e routes/pac-importacao.js, acesso por
// ROLE direto (master/admin_sistema), não por Perfil/Rotina.
const express = require('express');
const { db } = require('../database');
const { registrarLog, requireAdminSistema, n } = require('../middleware');
const mailer = require('../mailer');

const router = express.Router();

// ── Config SMTP ─────────────────────────────────────────────────────────────
router.get('/api/email/config', requireAdminSistema, (req, res) => {
  const config = db.prepare(`SELECT * FROM email_config ORDER BY id DESC LIMIT 1`).get();
  if (!config) return res.json(null);
  const { senha_enc, ...semSenha } = config; // nunca volta a senha (nem criptografada) pro cliente
  res.json({ ...semSenha, senha_configurada: !!senha_enc });
});

router.post('/api/email/config', requireAdminSistema, (req, res) => {
  const { host, port, secure, usuario, senha, remetente_email, remetente_nome, ativo } = req.body || {};
  if (!host || !port || !remetente_email) {
    return res.status(400).json({ error: 'Host, porta e e-mail do remetente são obrigatórios.' });
  }
  const atual = db.prepare(`SELECT id, senha_enc FROM email_config ORDER BY id DESC LIMIT 1`).get();
  // Senha em branco no form = mantém a que já estava salva (não obriga
  // redigitar a cada edição); senha explicitamente enviada substitui.
  const senha_enc = senha ? mailer.encriptarSenha(String(senha)) : (atual ? atual.senha_enc : null);
  if (atual) {
    db.prepare(`
      UPDATE email_config SET host=?, port=?, secure=?, usuario=?, senha_enc=?, remetente_email=?, remetente_nome=?, ativo=?, atualizado_em=datetime('now')
      WHERE id = ?
    `).run(String(host).trim(), Number(port), ativo ? 1 : 0, n(usuario), n(senha_enc), String(remetente_email).trim(), n(remetente_nome), ativo ? 1 : 0, atual.id);
  } else {
    db.prepare(`
      INSERT INTO email_config (host, port, secure, usuario, senha_enc, remetente_email, remetente_nome, ativo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(String(host).trim(), Number(port), ativo ? 1 : 0, n(usuario), n(senha_enc), String(remetente_email).trim(), n(remetente_nome), ativo ? 1 : 0);
  }
  registrarLog(req, 'EMAIL', 'CONFIG', `Alterou a configuração de SMTP (motor ${ativo ? 'ativado' : 'desativado'})`);
  res.json({ ok: true });
});

router.post('/api/email/config/testar', requireAdminSistema, async (req, res) => {
  const r = await mailer.testarConexao();
  registrarLog(req, 'EMAIL', 'TESTOU_CONEXAO', r.ok ? 'Teste de conexão SMTP OK' : `Teste de conexão SMTP falhou: ${r.erro}`);
  res.json(r);
});

// ── Templates ────────────────────────────────────────────────────────────
router.get('/api/email/templates', requireAdminSistema, (req, res) => {
  res.json(db.prepare(`SELECT * FROM email_templates ORDER BY nome`).all());
});

router.get('/api/email/templates/:slug', requireAdminSistema, (req, res) => {
  const t = db.prepare(`SELECT * FROM email_templates WHERE slug = ?`).get(req.params.slug);
  if (!t) return res.status(404).json({ error: 'Template não encontrado' });
  res.json(t);
});

router.post('/api/email/templates', requireAdminSistema, (req, res) => {
  const { slug, nome, assunto, corpo_html, corpo_texto, variaveis_disponiveis } = req.body || {};
  if (!slug || !nome || !assunto || !corpo_html) {
    return res.status(400).json({ error: 'Slug, nome, assunto e corpo HTML são obrigatórios.' });
  }
  if (!/^[a-z0-9_.-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Slug só pode ter letras minúsculas, números, ".", "_" e "-".' });
  }
  try {
    db.prepare(`
      INSERT INTO email_templates (slug, nome, assunto, corpo_html, corpo_texto, variaveis_disponiveis)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(String(slug).trim(), String(nome).trim(), String(assunto).trim(), String(corpo_html),
      n(corpo_texto), n(variaveis_disponiveis ? JSON.stringify(variaveis_disponiveis) : null));
  } catch {
    return res.status(409).json({ error: 'Já existe um template com este slug.' });
  }
  registrarLog(req, 'EMAIL', 'CRIOU_TEMPLATE', `Criou o template "${slug}"`);
  res.status(201).json({ ok: true });
});

router.put('/api/email/templates/:slug', requireAdminSistema, (req, res) => {
  const t = db.prepare(`SELECT slug FROM email_templates WHERE slug = ?`).get(req.params.slug);
  if (!t) return res.status(404).json({ error: 'Template não encontrado' });
  const { nome, assunto, corpo_html, corpo_texto, variaveis_disponiveis } = req.body || {};
  if (!nome || !assunto || !corpo_html) return res.status(400).json({ error: 'Nome, assunto e corpo HTML são obrigatórios.' });
  db.prepare(`
    UPDATE email_templates SET nome=?, assunto=?, corpo_html=?, corpo_texto=?, variaveis_disponiveis=?, atualizado_em=datetime('now')
    WHERE slug = ?
  `).run(String(nome).trim(), String(assunto).trim(), String(corpo_html), n(corpo_texto),
    n(variaveis_disponiveis ? JSON.stringify(variaveis_disponiveis) : null), req.params.slug);
  registrarLog(req, 'EMAIL', 'EDITOU_TEMPLATE', `Editou o template "${req.params.slug}"`);
  res.json({ ok: true });
});

router.patch('/api/email/templates/:slug/ativo', requireAdminSistema, (req, res) => {
  const { ativo } = req.body || {};
  const info = db.prepare(`UPDATE email_templates SET ativo = ? WHERE slug = ?`).run(ativo ? 1 : 0, req.params.slug);
  if (!info.changes) return res.status(404).json({ error: 'Template não encontrado' });
  registrarLog(req, 'EMAIL', 'TEMPLATE_ATIVO', `Template "${req.params.slug}" → ${ativo ? 'ativo' : 'inativo'}`);
  res.json({ ok: true });
});

// ── Destinatários fixos ──────────────────────────────────────────────────
router.get('/api/email/destinatarios/:slug', requireAdminSistema, (req, res) => {
  res.json(db.prepare(`SELECT * FROM email_destinatarios_fixos WHERE template_slug = ? ORDER BY id`).all(req.params.slug));
});

router.post('/api/email/destinatarios/:slug', requireAdminSistema, (req, res) => {
  const { email, nome } = req.body || {};
  if (!email || !String(email).trim()) return res.status(400).json({ error: 'E-mail é obrigatório.' });
  const info = db.prepare(`INSERT INTO email_destinatarios_fixos (template_slug, email, nome) VALUES (?, ?, ?)`)
    .run(req.params.slug, String(email).trim(), n(nome ? String(nome).trim() : null));
  registrarLog(req, 'EMAIL', 'ADICIONOU_DESTINATARIO', `Adicionou "${email}" ao template "${req.params.slug}"`);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.delete('/api/email/destinatarios/:id', requireAdminSistema, (req, res) => {
  const d = db.prepare(`SELECT template_slug, email FROM email_destinatarios_fixos WHERE id = ?`).get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Destinatário não encontrado' });
  db.prepare(`DELETE FROM email_destinatarios_fixos WHERE id = ?`).run(req.params.id);
  registrarLog(req, 'EMAIL', 'REMOVEU_DESTINATARIO', `Removeu "${d.email}" do template "${d.template_slug}"`);
  res.json({ ok: true });
});

// ── Fila ─────────────────────────────────────────────────────────────────
router.get('/api/email/fila', requireAdminSistema, (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare(`SELECT * FROM email_fila WHERE status = ? ORDER BY criado_em DESC LIMIT 200`).all(status)
    : db.prepare(`SELECT * FROM email_fila ORDER BY criado_em DESC LIMIT 200`).all();
  res.json(rows);
});

router.post('/api/email/fila/:id/reenviar', requireAdminSistema, (req, res) => {
  const item = db.prepare(`SELECT id, status FROM email_fila WHERE id = ?`).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item não encontrado' });
  if (!['erro', 'cancelado'].includes(item.status)) return res.status(409).json({ error: 'Só é possível reenviar item com erro ou cancelado.' });
  db.prepare(`UPDATE email_fila SET status = 'pendente', tentativas = 0, erro_msg = NULL, processado_em = NULL WHERE id = ?`).run(item.id);
  registrarLog(req, 'EMAIL', 'REENVIOU_FILA', `Reenfileirou o item #${item.id} da fila de e-mail`);
  res.json({ ok: true });
});

// Soft: marca como cancelado em vez de apagar a linha — mantém rastro do que
// foi decidido não enviar (mesmo espírito de nunca apagar email_log).
router.delete('/api/email/fila/:id', requireAdminSistema, (req, res) => {
  const item = db.prepare(`SELECT id, status FROM email_fila WHERE id = ?`).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item não encontrado' });
  if (item.status !== 'pendente') return res.status(409).json({ error: 'Só é possível cancelar item pendente.' });
  db.prepare(`UPDATE email_fila SET status = 'cancelado', processado_em = datetime('now') WHERE id = ?`).run(item.id);
  registrarLog(req, 'EMAIL', 'CANCELOU_FILA', `Cancelou o item #${item.id} da fila de e-mail`);
  res.json({ ok: true });
});

router.post('/api/email/fila/processar', requireAdminSistema, async (req, res) => {
  const resumo = await mailer.processarFila();
  registrarLog(req, 'EMAIL', 'PROCESSOU_FILA', `Processamento manual: ${resumo.enviados} enviado(s), ${resumo.erros} erro(s) de ${resumo.processados} item(ns)`);
  res.json(resumo);
});

// ── Log ──────────────────────────────────────────────────────────────────
router.get('/api/email/log', requireAdminSistema, (req, res) => {
  const { template_slug, status_final, de, ate } = req.query;
  const condicoes = []; const params = [];
  if (template_slug) { condicoes.push('template_slug = ?'); params.push(template_slug); }
  if (status_final)  { condicoes.push('status_final = ?');  params.push(status_final); }
  if (de)  { condicoes.push('criado_em >= ?'); params.push(de); }
  if (ate) { condicoes.push('criado_em <= ?'); params.push(ate); }
  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  res.json(db.prepare(`SELECT * FROM email_log ${where} ORDER BY id DESC LIMIT 300`).all(...params));
});

// ── Alertas ──────────────────────────────────────────────────────────────
router.get('/api/email/alertas', requireAdminSistema, (req, res) => {
  const todos = req.query.todos === '1';
  res.json(todos
    ? db.prepare(`SELECT * FROM email_alertas ORDER BY id DESC LIMIT 200`).all()
    : db.prepare(`SELECT * FROM email_alertas WHERE resolvido = 0 ORDER BY id DESC`).all());
});

router.patch('/api/email/alertas/:id/resolver', requireAdminSistema, (req, res) => {
  const info = db.prepare(`UPDATE email_alertas SET resolvido = 1, resolvido_em = datetime('now') WHERE id = ?`).run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Alerta não encontrado' });
  registrarLog(req, 'EMAIL', 'RESOLVEU_ALERTA', `Marcou o alerta #${req.params.id} como resolvido`);
  res.json({ ok: true });
});

// Resumo leve pra badge do menu admin + banner de login (master/admin_sistema)
// — evita o cliente ter que buscar as listas inteiras só pra saber "tem
// alguma coisa pendente?". Só exige estar autenticado (não master/admin_
// sistema): qualquer role pode chamar, mas só retorna >0 pra quem os outros
// endpoints também liberariam — dá pra checar sem 403 quebrar o carregamento
// da sidebar de todo mundo.
router.get('/api/email/resumo', (req, res) => {
  if (req.user.username !== 'master' && req.user.role !== 'admin_sistema') {
    return res.json({ alertas_nao_resolvidos: 0, fila_erros: 0 });
  }
  const alertas = db.prepare(`SELECT COUNT(*) AS n FROM email_alertas WHERE resolvido = 0`).get().n;
  const erros = db.prepare(`SELECT COUNT(*) AS n FROM email_fila WHERE status = 'erro'`).get().n;
  res.json({ alertas_nao_resolvidos: alertas, fila_erros: erros });
});

module.exports = router;
