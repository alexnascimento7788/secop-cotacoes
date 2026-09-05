// Peças verdadeiramente transversais (usadas por mais de um módulo): sessão/
// autenticação, log, e os gates genéricos de admin/módulo/rotina. Extraído de
// server.js na modularização por módulo (SECOP/SECAD/PAC/Admin) — ver
// C:\Users\alex.nascimento\.claude\plans\linear-puzzling-rain.md. Zero mudança
// de comportamento: cada função aqui é cópia literal do que já existia.
const { db } = require('./database');

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

// Usado por routes/secop.js (purgarLixeira) e routes/admin.js (GET /api/admin/lixeira).
function getLixeiraDias() {
  const row = db.prepare(`SELECT valor FROM config WHERE chave = 'lixeira_dias'`).get();
  const dias = parseInt(row?.valor, 10);
  return dias > 0 ? dias : 60;
}

// Parâmetro em Configurações → Parâmetros ("Edição de processos"). Default
// desligado: preserva a regra histórica (admin ou o próprio criador editam).
// Ligado, qualquer usuário com acesso ao SECOP edita qualquer processo — ver
// [[project_secop_role_admin_legado]] pro histórico dessa decisão.
function getSecopEdicaoLivre() {
  const row = db.prepare(`SELECT valor FROM config WHERE chave = 'secop_edicao_livre'`).get();
  return row?.valor === '1';
}

// Empurra o vencimento da sessão pra frente a cada requisição autenticada —
// o cookie em si dura bastante (ver /api/auth/login), quem controla o timeout
// de verdade é sessions.expires, rolando conforme uso real
function renovarSessao(token) {
  db.prepare(`UPDATE sessions SET expires = datetime('now', '+' || ? || ' minutes') WHERE token = ?`)
    .run(getInatividadeMinutos(), token);
}

// SELECT usado tanto por requireAuth quanto por /api/auth/me — traz, além do
// usuário, o departamento/perfil relativos ao MÓDULO ATIVO da sessão (não ao
// usuário em si — departamento do usuário é a coluna u.departamento_id, usada
// pro escopo do admin_operacional). Ver ao vivo a cada request (não confia em
// nada cacheado na sessão) garante que trocar o perfil de alguém já vale na
// próxima requisição dela, sem precisar de nenhum mecanismo de auto-cura novo.
const SESSAO_SQL = `
  SELECT s.user_id, s.modulo_ativo, u.username, u.role, u.acesso_avancado,
         u.departamento_id, u.nome_completo,
         d.slug AS modulo_departamento_slug, d.nome AS modulo_departamento_nome,
         um.perfil_id, p.nome AS perfil_nome
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  LEFT JOIN modulos m       ON m.slug = s.modulo_ativo
  LEFT JOIN departamentos d ON d.id = m.departamento_id
  LEFT JOIN user_modulos um ON um.user_id = s.user_id AND um.modulo_id = m.id
  LEFT JOIN perfis p        ON p.id = um.perfil_id
  WHERE s.token = ? AND s.expires > datetime('now') AND u.ativo = 1
`;

function requireAuth(req, res, next) {
  const token = getCookie(req, 'secop_sid');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const session = db.prepare(SESSAO_SQL).get(token);
  if (!session) return res.status(401).json({ error: 'Sessão expirada' });
  renovarSessao(token);
  req.user = session;
  next();
}

// Resolve o perfil do usuário num módulo (pelo id do módulo) — usado no login
// e na seleção de módulo, no mesmo lugar onde modulo_ativo é gravado.
function resolverPerfilId(userId, moduloId) {
  const row = db.prepare(`SELECT perfil_id FROM user_modulos WHERE user_id = ? AND modulo_id = ?`).get(userId, moduloId);
  return row ? row.perfil_id : null;
}

// ── Módulos (plataforma CEASA CONECTA) ────────────────────────────────────────
// Módulos ativos que o usuário pode acessar. O master sempre enxerga todos os
// módulos ativos; os demais, só os que têm em user_modulos. Sempre filtra ativo=1
// para que desligar um módulo o esconda de todos de uma vez.
function modulosDoUsuario(user) {
  // master e usuário de consulta (somente leitura) enxergam todos os módulos ativos.
  if (user.username === 'master' || user.role === 'consulta') {
    return db.prepare(`
      SELECT m.id, m.slug, m.nome, m.cor, m.home, m.ordem,
             d.slug AS departamento_slug, d.nome AS departamento_nome
      FROM modulos m LEFT JOIN departamentos d ON d.id = m.departamento_id
      WHERE m.ativo = 1 ORDER BY m.ordem`).all();
  }
  return db.prepare(`
    SELECT m.id, m.slug, m.nome, m.cor, m.home, m.ordem,
           d.slug AS departamento_slug, d.nome AS departamento_nome
    FROM modulos m
    JOIN user_modulos um ON um.modulo_id = m.id
    LEFT JOIN departamentos d ON d.id = m.departamento_id
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

// Somente leitura para o perfil "consulta": nega qualquer método que não seja
// leitura. Poucos POSTs de VISUALIZAÇÃO passam: abrir/ping/fechar o preview de
// um contrato no SECAD apenas montam a tela e mexem numa trava efêmera — nunca
// alteram dado. (Regex é do SECAD, mas o guard em si é global — fica aqui.)
const CONSULTA_POST_OK = [
  /^\/secad\/contratos\/\d+\/(abrir|ping|fechar)$/,
];

// 3 níveis de admin (substituem o antigo role='admin' + flag acesso_avancado):
// master (irrestrito, username hardcoded — nunca gerenciado por ninguém),
// admin_sistema (poderes totais no painel: usuários, departamentos, módulos,
// rotinas, perfis) e admin_operacional (escopo restrito ao próprio
// departamento — só usuários, sem CRUD de perfil/departamento/módulo).
function requireAdminAny(req, res, next) {
  if (req.user.username === 'master') return next();
  if (req.user.role === 'admin_sistema' || req.user.role === 'admin_operacional') return next();
  return res.status(403).json({ error: 'Acesso restrito a administradores' });
}
function requireAdminSistema(req, res, next) {
  if (req.user.username === 'master') return next();
  if (req.user.role !== 'admin_sistema') return res.status(403).json({ error: 'Acesso restrito ao administrador do sistema' });
  next();
}

// Exige que o módulo indicado seja o ativo na sessão. Usado por cada arquivo de
// rotas de módulo (routes/secop.js, secad.js, pac.js) — explícito em CADA rota,
// não como gate "blanket" de arquivo inteiro, porque esses mesmos arquivos
// também hospedam rotas administrativas de suporte que NÃO podem ficar atrás
// desse gate (ver comentário no topo de routes/admin.js).
function requireModulo(slug) {
  return (req, res, next) => {
    if (req.user.modulo_ativo !== slug) {
      return res.status(403).json({ error: `O módulo não está ativo nesta sessão.` });
    }
    next();
  };
}

// Permissão granular por Rotina (tela/funcionalidade dentro de um módulo) — o
// Perfil do usuário nesse módulo (perfil_id, resolvido em requireAuth) precisa
// ter a flag pedida (ver/incluir/alterar/excluir) marcada pra rotina. Master
// sempre passa; consulta passa (a guarda global de leitura já bloqueia
// qualquer escrita, mesmo esquema do antigo requireCap do Depop). Genérico —
// serve pra SECOP, SECAD, PAC ou qualquer módulo futuro. Só entra em rotas de
// ESCRITA (GETs continuam abertos pra quem tem o módulo, como já era).
const ROTINA_FLAGS_VALIDAS = new Set(['ver', 'incluir', 'alterar', 'excluir']);
function requireRotina(rotinaSlug, flag) {
  if (!ROTINA_FLAGS_VALIDAS.has(flag)) throw new Error(`requireRotina: flag inválida "${flag}"`);
  return (req, res, next) => {
    if (req.user.username === 'master') return next();
    if (req.user.role === 'consulta') return next();
    if (!req.user.perfil_id) return res.status(403).json({ error: 'Você não tem um perfil de acesso definido neste módulo. Procure o administrador.' });
    const row = db.prepare(`
      SELECT pr.${flag} AS permitido
      FROM perfil_rotinas pr JOIN rotinas r ON r.id = pr.rotina_id
      WHERE pr.perfil_id = ? AND r.slug = ?
    `).get(req.user.perfil_id, rotinaSlug);
    if (!row || !row.permitido) return res.status(403).json({ error: 'Você não tem essa permissão.' });
    next();
  };
}

// A chave fica no config (chave 'cpfhub_api_key', gerenciada nos Parâmetros do
// admin) e NUNCA vai pro frontend (ver CONFIG_SECRETA em routes/admin.js).
// Fallback: variável de ambiente CPFHUB_API_KEY. Fica aqui porque tanto
// routes/secad.js (consultarCpfApi) quanto routes/admin.js (status da chave em
// /api/admin/cpfhub) precisam dela.
function getCpfHubKey() {
  const row = db.prepare(`SELECT valor FROM config WHERE chave = 'cpfhub_api_key'`).get();
  const v = row && row.valor ? String(row.valor).trim() : '';
  return v || process.env.CPFHUB_API_KEY || '';
}

// numero_pac (AAAA-NNN) nasce JÁ na hora que o item é criado — seja por
// importação (routes/pac-importacao.js) ou lançamento manual de um gestor
// (routes/pac.js, POST /dfds/:id/itens) — sequencial contínuo por DFD/ano,
// nunca reaproveita número (item excluído depois só vira um buraco na
// sequência, nunca uma colisão — idx_dfd_itens_numero_pac é único mesmo em
// linha soft-deletada). Compartilhado entre os dois arquivos porque é a MESMA
// regra de negócio nos dois lugares — ao contrário dos helpers de acesso
// (esses sim duplicados de propósito por causa do gate diferente).
//
// Concorrência: chamador precisa ser síncrono do início ao fim (sem `await`
// entre isto e o INSERT que usa o valor devolvido) — o Node só processa uma
// requisição por vez quando não há nenhum ponto de yield no meio, então dois
// gestores/importações "simultâneos" continuam serializados pelo próprio
// event loop, sem precisar de lock explícito no SQLite.
function proximoNumeroPac(dfdId, anoBase) {
  const prefixo = `${anoBase}-`;
  const usados = db.prepare(`SELECT numero_pac FROM dfd_itens WHERE dfd_id = ? AND numero_pac LIKE ?`)
    .all(dfdId, prefixo + '%')
    .map(r => parseInt(String(r.numero_pac).slice(prefixo.length), 10))
    .filter(n => !isNaN(n));
  const proximo = (usados.length ? Math.max(...usados) : 0) + 1;
  return `${prefixo}${String(proximo).padStart(3, '0')}`;
}

module.exports = {
  n, getCookie, getInatividadeMinutos, getLixeiraDias, getSecopEdicaoLivre, renovarSessao, SESSAO_SQL, requireAuth,
  resolverPerfilId, modulosDoUsuario, registrarLog, CONSULTA_POST_OK,
  requireAdminAny, requireAdminSistema, requireModulo, ROTINA_FLAGS_VALIDAS,
  requireRotina, getCpfHubKey, proximoNumeroPac,
};
