// ── Admin: usuários/departamentos/rotinas/perfis/módulos, backup dos 3 bancos,
// logs, e catálogos "transversais" geridos pelo admin.html ───────────────────
// Extraído de server.js na modularização por módulo — zero mudança de
// comportamento. O antigo `app.use('/api/admin', requireAdminAny)` blanket
// virou `requireAdminAny` explícito por rota (mesma decisão dos outros 3
// arquivos de rotas — ver plano em
// C:\Users\alex.nascimento\.claude\plans\linear-puzzling-rain.md). Rotas que já
// tinham `requireAdminSistema` próprio continuam só com ele (é um subconjunto
// mais restrito de requireAdminAny, então nada muda).
//
// Também vivem aqui, de propósito, 4 famílias de rotas que NÃO são gateadas
// por módulo hoje (por isso não foram para routes/secop.js ou routes/secad.js,
// apesar de darem suporte a esses módulos específicos):
//   - GET /api/config (nenhum gate — qualquer usuário autenticado lê;
//     PUT /api/admin/config é que é admin-only) e /api/tipos-contratacao*,
//     /api/tipos-extra* (GET sem gate, escrita com requireAdminSistema) —
//     catálogos do SECOP geridos pelo admin.html indepen­dente do módulo ativo
//     na sessão (comentário original explica: senão um admin no PAC tomaria
//     403 ao abrir essas abas)
//   - /api/admin/lixeira* — SECOP (soft-delete de processos)
//   - /api/admin/concessionarios-removidos*, /api/admin/cpfhub,
//     /api/admin/export|import-depop-db — SECAD
// Se você está procurando lógica do SECOP/SECAD e não achou em routes/secop.js
// ou routes/secad.js, é aqui que ela está.
//
// GET /api/usuarios/:id/foto também mora aqui (é sobre "usuários", mas não é
// admin-gated — qualquer usuário autenticado vê o avatar de qualquer outro).
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, depopDb, anexosDb, setupDb, setupDepop, setupAnexos, depopFilePath, anexosFilePath } = require('../database');
const { n, registrarLog, requireAdminAny, requireAdminSistema, getLixeiraDias } = require('../middleware');

const router = express.Router();

// Ambiente HOMOLOG: existe só onde há o arquivo-marcador `.homolog` (gitignored).
// Gateia a aba "Atualização na base de produção" (ferramenta interna do master
// p/ acumular os comandos SQL a rodar manualmente na produção). Em produção o
// arquivo não existe → a aba nunca aparece, mesmo que o código chegue lá pelo git.
const IS_HOMOLOG = fs.existsSync(path.join(__dirname, '..', '.homolog'));
const MIGRACOES_FILE = path.join(__dirname, '..', 'migracoes-homolog.json');

// ── Lixeira (Configurações → Lixeira, restrito por requireAdminAny) ───────────

router.get('/api/admin/lixeira', requireAdminAny, (req, res) => {
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

router.post('/api/admin/lixeira/:id/restaurar', requireAdminAny, (req, res) => {
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

router.get('/api/admin/concessionarios-removidos', requireAdminAny, (req, res) => {
  const rows = db.prepare(`
    SELECT r.codigo, r.motivo, r.removido_em, u.username AS removido_por_username
    FROM concessionario_removido r
    LEFT JOIN users u ON u.id = r.removido_por
    ORDER BY r.removido_em DESC
  `).all();
  const clientes = new Map(depopDb.prepare(`SELECT codigo, cliente FROM ClienteConcessionario`).all().map(c => [c.codigo, c.cliente]));
  res.json(rows.map(r => ({ ...r, cliente: clientes.get(r.codigo) || null })));
});

router.post('/api/admin/concessionarios-removidos', requireAdminAny, (req, res) => {
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

router.post('/api/admin/concessionarios-removidos/:codigo/restaurar', requireAdminAny, (req, res) => {
  const codigo = parseInt(req.params.codigo, 10);
  const row = db.prepare(`SELECT codigo FROM concessionario_removido WHERE codigo = ?`).get(codigo);
  if (!row) return res.status(404).json({ error: 'Não está removido.' });
  db.prepare(`DELETE FROM concessionario_removido WHERE codigo = ?`).run(codigo);
  registrarLog(req, 'SECAD', 'CONCESSIONARIO_RESTAUROU', `Restaurou concessionário ${codigo} na listagem`);
  res.json({ ok: true });
});

// ── SECAD: cidades por usuário (escopo de Comunicados) ────────────────────────
// José só pode gerar/ver comunicados de Caratinga, Maria de todas — vínculo
// mora no secop.db (o `cidade_id` é o id de depop.db/Cidade, mas depop.db é
// recriado do zero em re-imports, não pode guardar nada lá que precise
// sobreviver, mesmo motivo de concessionario_removido acima). Sem NENHUMA
// linha pra um usuário = sem restrição (vê todas) — não quebra ninguém que já
// usa Comunicados hoje quando esta função entra no ar.

router.get('/api/admin/secad-cidades', requireAdminAny, (req, res) => {
  res.json(depopDb.prepare(`SELECT id, descricao FROM Cidade ORDER BY descricao`).all());
});

router.get('/api/admin/usuarios/:id/secad-cidades', requireAdminAny, (req, res) => {
  const user = db.prepare(`SELECT departamento_id FROM users WHERE id = ?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (req.user.role === 'admin_operacional' && req.user.username !== 'master' && user.departamento_id !== req.user.departamento_id) {
    return res.status(403).json({ error: 'Fora do seu departamento.' });
  }
  res.json(db.prepare(`SELECT cidade_id FROM secad_cidade_usuarios WHERE user_id = ?`).all(req.params.id).map(r => r.cidade_id));
});

router.put('/api/admin/usuarios/:id/secad-cidades', requireAdminAny, (req, res) => {
  const { cidade_id, concedido } = req.body || {};
  if (cidade_id == null) return res.status(400).json({ error: 'Cidade não informada' });
  const user = db.prepare(`SELECT username, departamento_id FROM users WHERE id = ?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (req.user.role === 'admin_operacional' && req.user.username !== 'master' && user.departamento_id !== req.user.departamento_id) {
    return res.status(403).json({ error: 'Fora do seu departamento.' });
  }
  if (concedido) {
    db.prepare(`INSERT OR IGNORE INTO secad_cidade_usuarios (user_id, cidade_id) VALUES (?, ?)`).run(req.params.id, cidade_id);
  } else {
    db.prepare(`DELETE FROM secad_cidade_usuarios WHERE user_id = ? AND cidade_id = ?`).run(req.params.id, cidade_id);
  }
  registrarLog(req, 'SECAD', 'CIDADE_USUARIO', `${concedido ? 'Liberou' : 'Removeu'} a cidade #${cidade_id} (Comunicados) para "${user.username}"`);
  res.json({ ok: true });
});

// ── Configurações (parâmetros do sistema) ─────────────────────────────────────

// Chaves de config que NUNCA podem ir pro frontend (segredos). Este endpoint é
// consumido por qualquer usuário logado (auth.js), então segredos ficam de fora.
const CONFIG_SECRETA = new Set(['cpfhub_api_key']);

router.get('/api/config', (req, res) => {
  const rows = db.prepare(`SELECT chave, valor FROM config`).all();
  const cfg = {};
  rows.forEach(r => { if (!CONFIG_SECRETA.has(r.chave)) cfg[r.chave] = r.valor; });
  res.json(cfg);
});

router.put('/api/admin/config', requireAdminAny, (req, res) => {
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

router.get('/api/tipos-contratacao', (req, res) => {
  res.json(db.prepare(`SELECT * FROM tipos_contratacao ORDER BY ordem`).all());
});

router.post('/api/tipos-contratacao', requireAdminSistema, (req, res) => {
  const { nome, ordem } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  try {
    const info = db.prepare(`INSERT INTO tipos_contratacao (nome, ordem) VALUES (?, ?)`).run(nome, n(ordem) ?? 0);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Tipo já existe' });
  }
});

router.put('/api/tipos-contratacao/:id', requireAdminSistema, (req, res) => {
  const { nome, ordem } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  db.prepare(`UPDATE tipos_contratacao SET nome=?, ordem=? WHERE id=?`).run(nome, n(ordem) ?? 0, req.params.id);
  res.json({ ok: true });
});

router.delete('/api/tipos-contratacao/:id', requireAdminSistema, (req, res) => {
  db.prepare(`DELETE FROM tipos_contratacao WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Tipos de itens extras (unidade + descrição sempre amarrados) ──────────────

router.get('/api/tipos-extra', (req, res) => {
  res.json(db.prepare(`SELECT * FROM tipos_extra ORDER BY ordem`).all());
});

router.post('/api/tipos-extra', requireAdminSistema, (req, res) => {
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

router.put('/api/tipos-extra/:id', requireAdminSistema, (req, res) => {
  const { unidade, descricao, ordem, sinal, tipo_valor, conta_no_total } = req.body;
  if (!unidade || !descricao) return res.status(400).json({ error: 'Unidade e descrição são obrigatórias' });
  const sinalVal = sinal === 'negativo' ? 'negativo' : 'positivo';
  const tipoValorVal = tipo_valor === 'percentual' ? 'percentual' : 'fixo';
  const contaNoTotalVal = conta_no_total === false || conta_no_total === 0 || conta_no_total === '0' ? 0 : 1;
  db.prepare(`UPDATE tipos_extra SET unidade=?, descricao=?, ordem=?, sinal=?, tipo_valor=?, conta_no_total=? WHERE id=?`).run(unidade, descricao, n(ordem) ?? 0, sinalVal, tipoValorVal, contaNoTotalVal, req.params.id);
  res.json({ ok: true });
});

router.delete('/api/tipos-extra/:id', requireAdminSistema, (req, res) => {
  db.prepare(`DELETE FROM tipos_extra WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});


// ── Admin: usuários ───────────────────────────────────────────────────────────

router.get('/api/admin/users', requireAdminAny, (req, res) => {
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

router.post('/api/admin/users', requireAdminAny, (req, res) => {
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

router.patch('/api/admin/users/:id', requireAdminAny, (req, res) => {
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

router.delete('/api/admin/users/:id', requireAdminAny, (req, res) => {
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
router.post('/api/admin/users/:id/foto', requireAdminAny, express.raw({ type: '*/*', limit: '4mb' }), (req, res) => {
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

router.delete('/api/admin/users/:id/foto', requireAdminAny, (req, res) => {
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

router.get('/api/admin/departamentos', requireAdminSistema, (req, res) => {
  res.json(db.prepare(`SELECT id, slug, nome, ordem, ativo FROM departamentos ORDER BY ordem`).all());
});

router.patch('/api/admin/departamentos/:id', requireAdminSistema, (req, res) => {
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

router.get('/api/admin/rotinas', requireAdminSistema, (req, res) => {
  res.json(db.prepare(`
    SELECT r.id, r.modulo_id, m.nome AS modulo_nome, r.slug, r.nome, r.ordem, r.ativo, r.flags_aplicaveis
    FROM rotinas r JOIN modulos m ON m.id = r.modulo_id
    ORDER BY m.ordem, r.ordem`).all());
});

router.patch('/api/admin/rotinas/:id', requireAdminSistema, (req, res) => {
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

router.get('/api/admin/perfis', requireAdminAny, (req, res) => {
  const { modulo_id } = req.query;
  const rows = modulo_id
    ? db.prepare(`SELECT id, modulo_id, nome, descricao FROM perfis WHERE modulo_id = ? ORDER BY nome`).all(modulo_id)
    : db.prepare(`SELECT id, modulo_id, nome, descricao FROM perfis ORDER BY modulo_id, nome`).all();
  res.json(rows);
});

router.post('/api/admin/perfis', requireAdminSistema, (req, res) => {
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

router.patch('/api/admin/perfis/:id', requireAdminSistema, (req, res) => {
  const { nome, descricao } = req.body;
  const perfil = db.prepare(`SELECT nome FROM perfis WHERE id = ?`).get(req.params.id);
  if (!perfil) return res.status(404).json({ error: 'Perfil não encontrado' });
  if (nome !== undefined) db.prepare(`UPDATE perfis SET nome = ? WHERE id = ?`).run(String(nome).trim(), req.params.id);
  if (descricao !== undefined) db.prepare(`UPDATE perfis SET descricao = ? WHERE id = ?`).run(descricao ? String(descricao).trim() : null, req.params.id);
  registrarLog(req, 'PERFIL', 'EDITOU', `Editou o perfil "${perfil.nome}"`);
  res.json({ ok: true });
});

router.delete('/api/admin/perfis/:id', requireAdminSistema, (req, res) => {
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
router.get('/api/admin/perfis/:id/rotinas', requireAdminAny, (req, res) => {
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

router.put('/api/admin/perfis/:id/rotinas', requireAdminSistema, (req, res) => {
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

router.get('/api/admin/modulos', requireAdminSistema, (req, res) => {
  res.json(db.prepare(`SELECT id, slug, nome, cor, home, ordem, ativo, departamento_id FROM modulos ORDER BY ordem`).all());
});

// Matriz para a aba Módulos: todos os módulos + cada usuário (exceto master, que
// já enxerga tudo) com o perfil que possui em cada um. admin_operacional só
// enxerga/mexe no que é do próprio departamento.
router.get('/api/admin/modulos/acessos', requireAdminAny, (req, res) => {
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

router.put('/api/admin/modulos/acessos', requireAdminAny, (req, res) => {
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
router.patch('/api/admin/modulos/acessos', requireAdminAny, (req, res) => {
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
router.patch('/api/admin/modulos/:id', requireAdminSistema, (req, res) => {
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
router.get('/api/usuarios/:id/foto', (req, res) => {
  const row = anexosDb.prepare(`SELECT mime, conteudo FROM user_foto WHERE user_id = ?`).get(req.params.id);
  if (!row) return res.status(404).end();
  res.set('Content-Type', row.mime);
  res.set('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(row.conteudo));
});

// ── Admin: export / import banco ─────────────────────────────────────────────

router.get('/api/admin/export-db', requireAdminAny, (req, res) => {
  registrarLog(req, 'BANCO', 'EXPORTOU', 'Exportou banco de dados');
  try { db.exec('PRAGMA wal_checkpoint(FULL)'); } catch {}
  res.download(path.join(__dirname, '..', 'data', 'secop.db'), 'secop.db');
});

router.post('/api/admin/import-db',
  requireAdminAny,
  express.raw({ type: 'application/octet-stream', limit: '100mb' }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      return res.status(400).json({ error: 'Arquivo inválido' });

    registrarLog(req, 'BANCO', 'IMPORTOU', 'Importou banco de dados');

    const dbPath = path.join(__dirname, '..', 'data', 'secop.db');
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

router.get('/api/admin/export-depop-db', requireAdminAny, (req, res) => {
  if (!fs.existsSync(depopFilePath)) {
    return res.status(404).json({ error: 'Base do Depop ainda não existe. Gere-a com o conversor primeiro.' });
  }
  registrarLog(req, 'DEPOP', 'EXPORTOU', 'Exportou a base de dados do Depop');
  try { depopDb.exec('PRAGMA wal_checkpoint(FULL)'); } catch {}
  res.download(depopFilePath, 'depop.db');
});

router.post('/api/admin/import-depop-db',
  requireAdminAny,
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

router.get('/api/admin/export-anexos-db', requireAdminAny, (req, res) => {
  if (!fs.existsSync(anexosFilePath)) return res.status(404).json({ error: 'Ainda não há anexos.' });
  registrarLog(req, 'DEPOP', 'EXPORTOU', 'Exportou os anexos (comprovantes)');
  try { anexosDb.exec('PRAGMA wal_checkpoint(FULL)'); } catch {}
  res.download(anexosFilePath, 'anexos.db');
});

router.post('/api/admin/import-anexos-db',
  requireAdminAny,
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

router.get('/api/admin/logs', requireAdminAny, (req, res) => {
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

router.get('/api/admin/logs/usuarios', requireAdminAny, (req, res) => {
  const rows = db.prepare(`SELECT DISTINCT username FROM logs WHERE username IS NOT NULL ORDER BY username`).all();
  res.json(rows.map(r => r.username));
});

router.delete('/api/admin/logs', requireAdminAny, (req, res) => {
  db.prepare('DELETE FROM logs').run();
  registrarLog(req, 'SISTEMA', 'LIMPOU', 'Histórico de logs limpo');
  res.json({ ok: true });
});

// Status da chave (pro admin saber se está configurada, sem expor o valor).
router.get('/api/admin/cpfhub', requireAdminAny, (req, res) => {
  const row = db.prepare(`SELECT valor FROM config WHERE chave = 'cpfhub_api_key'`).get();
  const v = row && row.valor ? String(row.valor).trim() : '';
  res.json({ configurada: !!v, mascara: v ? (v.slice(0, 4) + '••••••' + v.slice(-2)) : '' });
});

// ── Homolog: migrações a rodar manualmente na produção (DBeaver) ──────────────
// Ferramenta interna do master, SÓ em homolog. Lê a lista local de comandos SQL
// (migracoes-homolog.json, gitignored — mora só aqui). Em produção o marcador
// .homolog não existe → 404, a aba nunca aparece.
router.get('/api/admin/migracoes-homolog', requireAdminAny, (req, res) => {
  if (!IS_HOMOLOG) return res.status(404).json({ error: 'Indisponível fora do homolog.' });
  if (req.user.username !== 'master') return res.status(403).json({ error: 'Restrito ao master.' });
  res.set('Cache-Control', 'no-store');
  let dados = { migracoes: [] };
  try { if (fs.existsSync(MIGRACOES_FILE)) dados = JSON.parse(fs.readFileSync(MIGRACOES_FILE, 'utf8')); } catch (e) {
    return res.status(500).json({ error: 'Falha ao ler a lista de migrações: ' + e.message });
  }
  res.json({ migracoes: dados.migracoes || [] });
});

module.exports = { router, IS_HOMOLOG };
