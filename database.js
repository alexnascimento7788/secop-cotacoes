const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbFilePath = path.join(dataDir, 'secop.db');
let _db;

function setupDb() {
  _db = new DatabaseSync(dbFilePath);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS processos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_processo TEXT UNIQUE,
      objeto TEXT NOT NULL,
      setor_solicitante TEXT,
      tipo_contratacao TEXT,
      responsavel TEXT,
      descricao TEXT,
      previsao_inicio DATE,
      previsao_termino DATE,
      status TEXT DEFAULT 'Em cotação',
      proposta_vencedora_id INTEGER,
      observacoes TEXT,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS fornecedores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      processo_id INTEGER NOT NULL,
      ordem INTEGER,
      nome TEXT,
      contato TEXT,
      telefone TEXT,
      celular TEXT,
      email TEXT,
      data_proposta TEXT,
      prazo_pagamento TEXT,
      prazo_entrega TEXT,
      prazo_garantia TEXT,
      proposta_inicial REAL,
      proposta_final REAL,
      observacoes TEXT,
      FOREIGN KEY (processo_id) REFERENCES processos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      processo_id INTEGER NOT NULL,
      item_num INTEGER,
      quantidade REAL,
      unidade TEXT,
      descricao TEXT,
      FOREIGN KEY (processo_id) REFERENCES processos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS precos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      fornecedor_id INTEGER NOT NULL,
      preco_unitario REAL,
      preco_total REAL,
      FOREIGN KEY (item_id) REFERENCES itens(id) ON DELETE CASCADE,
      FOREIGN KEY (fornecedor_id) REFERENCES fornecedores(id) ON DELETE CASCADE,
      UNIQUE(item_id, fornecedor_id)
    );

    CREATE TABLE IF NOT EXISTS status (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT    NOT NULL UNIQUE,
      ordem INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Semeia os status padrão (ignora se já existirem)
  [
    { nome: 'Em cotação',    ordem: 1 },
    { nome: 'Ag. aprovação', ordem: 2 },
    { nome: 'Cancelado',     ordem: 5 },
    { nome: 'Concluído',     ordem: 3 },
    { nome: 'Parado',        ordem: 4 },
  ].forEach(s => {
    try {
      _db.prepare(`INSERT INTO status (nome, ordem) VALUES (?, ?)`).run(s.nome, s.ordem);
    } catch {}
  });

  _db.exec(`
    CREATE TABLE IF NOT EXISTS status_historico (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      processo_id  INTEGER NOT NULL,
      status_de    TEXT,
      status_para  TEXT NOT NULL,
      alterado_em  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (processo_id) REFERENCES processos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS config (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    );
  `);

  // Parâmetros padrão (ignora se já existirem)
  [
    { chave: 'alerta_dias_laranja',  valor: '5'  },
    { chave: 'alerta_dias_vermelho', valor: '10' },
    { chave: 'inatividade_minutos',  valor: '30' },
    { chave: 'lixeira_dias',         valor: '60' },
  ].forEach(c => {
    try {
      _db.prepare(`INSERT INTO config (chave, valor) VALUES (?, ?)`).run(c.chave, c.valor);
    } catch {}
  });

  // Migrações — falham silenciosamente se coluna/renomeação já existir
  try { _db.exec(`ALTER TABLE processos    ADD COLUMN data_abertura DATE`);    } catch {}
  try { _db.exec(`ALTER TABLE processos    ADD COLUMN observacoes2 TEXT`);     } catch {}
  try { _db.exec(`ALTER TABLE processos    ADD COLUMN mostrar_menor_preco INTEGER DEFAULT 1`); } catch {}
  try { _db.exec(`ALTER TABLE fornecedores ADD COLUMN frete TEXT`);            } catch {}
  try { _db.exec(`ALTER TABLE fornecedores ADD COLUMN pesquisa_internet INTEGER DEFAULT 0`); } catch {}
  try { _db.exec(`ALTER TABLE fornecedores ADD COLUMN declinio INTEGER DEFAULT 0`); } catch {}
  try { _db.exec(`ALTER TABLE fornecedores ADD COLUMN pesquisa_compra_publica INTEGER DEFAULT 0`); } catch {}
  try { _db.exec(`ALTER TABLE fornecedores ADD COLUMN frete_termo TEXT`);         } catch {}
  // DDD separado do número (bandeira BR + bandeira do estado + DDD no cadastro
  // de fornecedor, ver public/js/telefone-br.js) — telefone/celular já
  // cadastrados NÃO são migrados automaticamente (formato livre demais nos
  // dados reais: "31997163412", "(31) 3053-0404", "31 99793-7199 - WPP", "-",
  // etc. — um regex arriscaria corromper histórico). Ficam com ddd NULL até
  // alguém reabrir e salvar de novo pela tela nova.
  try { _db.exec(`ALTER TABLE fornecedores ADD COLUMN telefone_ddd TEXT`); } catch {}
  try { _db.exec(`ALTER TABLE fornecedores ADD COLUMN celular_ddd TEXT`);  } catch {}
  try { _db.exec(`ALTER TABLE precos RENAME COLUMN preco_unitario TO preco_unitario_mes`); } catch {}
  try { _db.exec(`ALTER TABLE precos RENAME COLUMN preco_total    TO preco_total_ano`);    } catch {}
  try { _db.exec(`ALTER TABLE itens ADD COLUMN extra INTEGER DEFAULT 0`); } catch {}
  // Soft-delete: excluir um processo só marca esta data — ele fica na Lixeira até
  // ser restaurado ou purgado automaticamente após config.lixeira_dias
  try { _db.exec(`ALTER TABLE processos ADD COLUMN excluido_em DATETIME`); } catch {}
  // Segunda camada de permissão sobre "admin": Configurações e Lixeira só ficam
  // disponíveis pra quem tem este flag ligado (ou é o usuário "master")
  try { _db.exec(`ALTER TABLE users ADD COLUMN acesso_avancado INTEGER NOT NULL DEFAULT 0`); } catch {}

  // ── Tipos de itens extras (unidade + descrição sempre amarrados) ──────────────

  _db.exec(`
    CREATE TABLE IF NOT EXISTS tipos_extra (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      unidade   TEXT    NOT NULL UNIQUE,
      descricao TEXT    NOT NULL,
      ordem     INTEGER NOT NULL DEFAULT 0
    );
  `);
  try { _db.exec(`ALTER TABLE tipos_extra ADD COLUMN sinal TEXT NOT NULL DEFAULT 'positivo'`); } catch {}
  try { _db.exec(`ALTER TABLE tipos_extra ADD COLUMN tipo_valor TEXT NOT NULL DEFAULT 'fixo'`); } catch {}
  // Decisão explícita e gerenciável em Configurações (não mais inferida automaticamente
  // pelo código a partir de "itens estão em R$ 0 ou não") sobre se o valor deste tipo
  // soma no VALOR TOTAL do fornecedor ou é apenas informativo (aparece na linha, não
  // entra no cálculo). Default 1 preserva o comportamento de quem já usava tipos fixos.
  try { _db.exec(`ALTER TABLE tipos_extra ADD COLUMN conta_no_total INTEGER NOT NULL DEFAULT 1`); } catch {}

  // ── Tipos de contratação ──────────────────────────────────────────────────────

  _db.exec(`
    CREATE TABLE IF NOT EXISTS tipos_contratacao (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      nome  TEXT    NOT NULL UNIQUE,
      ordem INTEGER NOT NULL DEFAULT 0
    );
  `);

  [
    { nome: 'Direta',     ordem: 1 },
    { nome: 'Licitação',  ordem: 2 },
    { nome: 'Dispensa',   ordem: 3 },
  ].forEach(t => {
    try {
      _db.prepare(`INSERT INTO tipos_contratacao (nome, ordem) VALUES (?, ?)`).run(t.nome, t.ordem);
    } catch {}
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      salt       TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'admin',
      ativo      INTEGER NOT NULL DEFAULT 1,
      criado_em  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token    TEXT PRIMARY KEY,
      user_id  INTEGER NOT NULL,
      expires  DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Semeia usuário master se não existir
  try {
    const exists = _db.prepare("SELECT id FROM users WHERE username='master'").get();
    if (!exists) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync('hear_pgPN@2638#++', salt, 100000, 64, 'sha512').toString('hex');
      _db.prepare("INSERT INTO users (username, senha_hash, salt, role, ativo) VALUES (?,?,?,'admin',1)")
        .run('master', hash, salt);
    }
  } catch {}

  try { _db.exec(`ALTER TABLE processos ADD COLUMN criado_por_id INTEGER REFERENCES users(id)`); } catch {}

  // Email do usuário (definido pelo admin na criação) e flag de senha provisória:
  // ao ser criado/ter a senha redefinida pelo admin, o usuário precisa trocar a
  // senha no próximo login antes de usar o sistema (ver /api/auth/trocar-senha).
  try { _db.exec(`ALTER TABLE users ADD COLUMN email TEXT`); } catch {}
  try { _db.exec(`ALTER TABLE users ADD COLUMN senha_provisoria INTEGER NOT NULL DEFAULT 0`); } catch {}

  // ── Módulos da plataforma CEASA CONECTA ───────────────────────────────────────
  // O sistema virou multi-módulo: SECOP - Cotações é o módulo atual (todo o app de
  // hoje), Depop - Concessionários é um segundo módulo (placeholder). `cor` dá a
  // diferenciação visual (accent) por módulo; `ativo` liga/desliga o módulo inteiro.

  _db.exec(`
    CREATE TABLE IF NOT EXISTS modulos (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      slug  TEXT    NOT NULL UNIQUE,
      nome  TEXT    NOT NULL,
      cor   TEXT    NOT NULL DEFAULT '#1A6B35',
      home  TEXT    NOT NULL,
      ordem INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS user_modulos (
      user_id   INTEGER NOT NULL,
      modulo_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, modulo_id),
      FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
      FOREIGN KEY (modulo_id) REFERENCES modulos(id) ON DELETE CASCADE
    );
  `);

  // Depop - Concessionários → SECAD Concessionários: renomeia ANTES do seed
  // abaixo rodar (senão, depois que 'depop' deixa de existir, o seed geral
  // recriaria uma linha 'depop' do zero a cada boot — colidindo com 'secad' na
  // vez seguinte). Só a camada de módulo muda de nome aqui: o arquivo
  // data/depop.db, a variável depopDb/depopFilePath e as tabelas
  // depop_acesso/depop_perfil continuam com esse nome (são sobre a fonte de
  // dados externa do SQL Server, não sobre a marca do módulo).
  _db.prepare(`UPDATE modulos SET slug = 'secad', nome = 'SECAD - Concessionários', home = '/secad.html' WHERE slug = 'depop'`).run();
  // Sessão com módulo ativo em voo no momento do deploy se autocorrige, sem
  // precisar forçar re-seleção de módulo. try/catch: numa instalação nova a
  // coluna modulo_ativo ainda nem existe nesse ponto (o ALTER dela é mais
  // abaixo) — não tem sessão nenhuma pra corrigir mesmo, então é seguro ignorar.
  try { _db.prepare(`UPDATE sessions SET modulo_ativo = 'secad' WHERE modulo_ativo = 'depop'`).run(); } catch {}

  // Semeia os módulos padrão (ignora se já existirem — idempotente). O 2º módulo
  // já nasce como 'secad' (nome atual) — instalação pré-existente com 'depop'
  // já foi migrada pelo UPDATE de rename logo acima.
  [
    { slug: 'secop', nome: 'SECOP - Cotações',           cor: '#1A6B35', home: '/index.html', ordem: 1 },
    { slug: 'secad', nome: 'SECAD - Concessionários',    cor: '#1565C0', home: '/secad.html',  ordem: 2 },
  ].forEach(m => {
    try {
      _db.prepare(`INSERT INTO modulos (slug, nome, cor, home, ordem) VALUES (?, ?, ?, ?, ?)`)
        .run(m.slug, m.nome, m.cor, m.home, m.ordem);
    } catch {}
  });

  // Todo usuário existente recebe acesso ao módulo SECOP automaticamente — porém
  // UMA ÚNICA VEZ. Sem o flag, este backfill rodaria a cada boot e reconcederia
  // SECOP a quem o admin tivesse revogado depois. O flag em `config` (padrão de
  // idempotência do projeto) garante que só acontece na primeira migração.
  try {
    const jaFeito = _db.prepare(`SELECT valor FROM config WHERE chave = 'migracao_modulos_secop'`).get();
    if (!jaFeito) {
      const secop = _db.prepare(`SELECT id FROM modulos WHERE slug = 'secop'`).get();
      if (secop) {
        _db.prepare(`INSERT OR IGNORE INTO user_modulos (user_id, modulo_id)
                     SELECT id, ? FROM users`).run(secop.id);
      }
      _db.prepare(`INSERT INTO config (chave, valor) VALUES ('migracao_modulos_secop', '1')`).run();
    }
  } catch {}

  // Qual módulo o usuário escolheu para esta sessão (slug). NULL = ainda não escolheu.
  try { _db.exec(`ALTER TABLE sessions ADD COLUMN modulo_ativo TEXT`); } catch {}

  // ── Depop: perfil de assinatura do usuário ────────────────────────────────────
  // No 1º acesso ao módulo Depop o usuário cadastra CPF (validado) + uma senha de
  // assinatura, da qual derivamos um par de chaves. A chave privada é guardada
  // cifrada por essa senha (PEM PKCS8 com passphrase) — o servidor nunca guarda a
  // senha nem a chave privada em claro. A pública fica pra verificar assinaturas.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS depop_perfil (
      user_id            INTEGER PRIMARY KEY,
      cpf                TEXT NOT NULL UNIQUE,
      chave_publica      TEXT NOT NULL,
      chave_privada_pem  TEXT NOT NULL,
      criado_em          DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  // Nome completo do titular do CPF, retornado pela API de consulta (cpfhub.io)
  // no cadastro — usado como nome do validador no Anexo I / assinatura.
  try { _db.exec(`ALTER TABLE depop_perfil ADD COLUMN nome TEXT`); } catch {}

  // ── Depop: ferramenta de validação de contratos ──────────────────────────────
  // A conferência dos contratos (dados vindos das planilhas, carregados no
  // depop.db) é registrada AQUI, no secop.db — de propósito: o depop.db é só
  // leitura e pode ser re-sincronizado do SQL Server a qualquer momento sem
  // apagar o trabalho de validação. A ligação com o contrato é só o número
  // `id_avaliacao` (= AvaliacaoAreaRenovacao.id no depop.db); não há FK entre os
  // dois arquivos. Uma linha por contrato (id_avaliacao UNIQUE); sem linha = pendente.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS validacao_contrato (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      id_avaliacao         INTEGER NOT NULL UNIQUE,
      status               TEXT    NOT NULL DEFAULT 'pendente',
      observacao           TEXT,
      id_usuario_validador INTEGER,
      dt_validacao         DATETIME,
      hash_assinatura      TEXT,
      assinatura_b64       TEXT,
      FOREIGN KEY (id_usuario_validador) REFERENCES users(id)
    );
  `);
  // Ao marcar erro, além do problema (observacao) o validador agora também
  // descreve a solução — visível pra todo mundo que abrir o contrato (não só
  // pra quem vai reabrir).
  try { _db.exec(`ALTER TABLE validacao_contrato ADD COLUMN solucao TEXT`); } catch {}

  _db.exec(`
    CREATE TABLE IF NOT EXISTS validacao_lock (
      id_avaliacao INTEGER PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      nome         TEXT,
      aberto_em    DATETIME DEFAULT CURRENT_TIMESTAMP,
      ultimo_ping  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // ── Depop: capacidades por usuário dentro do módulo ──────────────────────────
  // Acesso ao MÓDULO Depop continua sendo por user_modulos. AQUI é o que o usuário
  // pode FAZER dentro dele: validar contratos e/ou gerar comunicados. Sem linha =
  // padrão (só valida) — mantém quem já usava a validação funcionando. O master
  // (username 'master') ignora esta tabela e pode tudo.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS depop_acesso (
      user_id     INTEGER PRIMARY KEY,
      valida      INTEGER NOT NULL DEFAULT 1,
      comunicados INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // ── Departamentos, Rotinas, Perfis (CEASA CONECTA: hierarquia Departamento →
  // Módulo → Rotina → Perfil) ──────────────────────────────────────────────────
  // Generaliza o modelo de permissão que hoje só existe pro Depop (depop_acesso,
  // 2 colunas fixas valida/comunicados) pra qualquer módulo: cada módulo declara
  // suas Rotinas (telas/funcionalidades, seed fixo, não editável pelo admin) e um
  // Perfil dá, por rotina, as flags ver/incluir/alterar/excluir. Um usuário recebe
  // um Perfil por módulo (user_modulos.perfil_id). Departamento é só uma camada
  // de agrupamento acima dos módulos (visual + escopo do admin_operacional).
  _db.exec(`
    CREATE TABLE IF NOT EXISTS departamentos (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      slug  TEXT    NOT NULL UNIQUE,
      nome  TEXT    NOT NULL,
      ordem INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1
    );
  `);
  [
    { slug: 'depad', nome: 'DEPAD', ordem: 1 },
    { slug: 'depop', nome: 'DEPOP', ordem: 2 },
    { slug: 'depla', nome: 'DEPLA', ordem: 3 },
  ].forEach(d => {
    try { _db.prepare(`INSERT INTO departamentos (slug, nome, ordem) VALUES (?, ?, ?)`).run(d.slug, d.nome, d.ordem); } catch {}
  });

  try { _db.exec(`ALTER TABLE modulos ADD COLUMN departamento_id INTEGER REFERENCES departamentos(id)`); } catch {}

  // Novo módulo PAC (placeholder, departamento DEPLA)
  try {
    _db.prepare(`INSERT INTO modulos (slug, nome, cor, home, ordem) VALUES (?, ?, ?, ?, ?)`)
      .run('pac', 'PAC', '#F9A800', '/pac-lancamento.html', 3);
  } catch {}

  // (rename depop→secad já rodou mais acima, antes do seed de módulos)

  // departamento_id por módulo (idempotente: só preenche quem ainda está NULL)
  try {
    const depIds = Object.fromEntries(_db.prepare(`SELECT slug, id FROM departamentos`).all().map(d => [d.slug, d.id]));
    [['secop', 'depad'], ['secad', 'depop'], ['pac', 'depla']].forEach(([modSlug, depSlug]) => {
      if (depIds[depSlug]) {
        _db.prepare(`UPDATE modulos SET departamento_id = ? WHERE slug = ? AND departamento_id IS NULL`).run(depIds[depSlug], modSlug);
      }
    });
  } catch {}

  _db.exec(`
    CREATE TABLE IF NOT EXISTS rotinas (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      modulo_id        INTEGER NOT NULL,
      slug             TEXT    NOT NULL,
      nome             TEXT    NOT NULL,
      ordem            INTEGER NOT NULL DEFAULT 0,
      ativo            INTEGER NOT NULL DEFAULT 1,
      flags_aplicaveis TEXT    NOT NULL DEFAULT 'ver,incluir,alterar,excluir',
      FOREIGN KEY (modulo_id) REFERENCES modulos(id) ON DELETE CASCADE,
      UNIQUE (modulo_id, slug)
    );
  `);
  {
    const modIds = Object.fromEntries(_db.prepare(`SELECT slug, id FROM modulos`).all().map(m => [m.slug, m.id]));
    const seedRotinas = [
      ['secop', 'dashboard',      'Dashboard',    1, 'ver'],
      ['secop', 'processos',      'Processos',    2, 'ver,incluir,alterar,excluir'],
      ['secop', 'cotacao',        'Cotação',      3, 'ver,incluir,alterar,excluir'],
      ['secop', 'fornecedores',   'Fornecedores', 4, 'ver,incluir,alterar,excluir'],
      ['secad', 'validacao',      'Validação',    1, 'ver,incluir,alterar'],
      ['secad', 'comunicados',    'Comunicados',  2, 'ver,incluir,alterar'],
      ['pac',   'pac-lancamento',     'Lançamento',     1, 'ver,incluir,alterar,excluir'],
      ['pac',   'pac-gestao',         'Gestão',         2, 'ver,incluir,alterar,excluir'],
      ['pac',   'pac-solicitacoes',   'Solicitações',   3, 'ver,incluir,alterar,excluir'],
      ['pac',   'pac-acompanhamento', 'Acompanhamento', 4, 'ver'],
    ];
    seedRotinas.forEach(([modSlug, slug, nome, ordem, flags]) => {
      if (!modIds[modSlug]) return;
      try {
        _db.prepare(`INSERT INTO rotinas (modulo_id, slug, nome, ordem, flags_aplicaveis) VALUES (?, ?, ?, ?, ?)`)
          .run(modIds[modSlug], slug, nome, ordem, flags);
      } catch {}
    });
  }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS perfis (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      modulo_id INTEGER NOT NULL,
      nome      TEXT    NOT NULL,
      descricao TEXT,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (modulo_id) REFERENCES modulos(id) ON DELETE CASCADE,
      UNIQUE (modulo_id, nome)
    );

    CREATE TABLE IF NOT EXISTS perfil_rotinas (
      perfil_id INTEGER NOT NULL,
      rotina_id INTEGER NOT NULL,
      ver       INTEGER NOT NULL DEFAULT 0,
      incluir   INTEGER NOT NULL DEFAULT 0,
      alterar   INTEGER NOT NULL DEFAULT 0,
      excluir   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (perfil_id, rotina_id),
      FOREIGN KEY (perfil_id) REFERENCES perfis(id) ON DELETE CASCADE,
      FOREIGN KEY (rotina_id) REFERENCES rotinas(id) ON DELETE CASCADE
    );
  `);

  // Semeia um perfil (idempotente por UNIQUE(modulo_id,nome)) + suas concessões
  // por rotina — as concessões só são inseridas na 1ª vez que o perfil nasce; se
  // o admin editar depois, a linha já existe e o catch{} preserva a edição dele.
  function seedPerfil(modSlug, nome, descricao, grants) {
    const mod = _db.prepare(`SELECT id FROM modulos WHERE slug = ?`).get(modSlug);
    if (!mod) return;
    let perfilId;
    try {
      perfilId = _db.prepare(`INSERT INTO perfis (modulo_id, nome, descricao) VALUES (?, ?, ?)`).run(mod.id, nome, descricao).lastInsertRowid;
    } catch {
      const existente = _db.prepare(`SELECT id FROM perfis WHERE modulo_id = ? AND nome = ?`).get(mod.id, nome);
      perfilId = existente && existente.id;
    }
    if (!perfilId) return;
    grants.forEach(([rotSlug, f]) => {
      const rot = _db.prepare(`SELECT id FROM rotinas WHERE modulo_id = ? AND slug = ?`).get(mod.id, rotSlug);
      if (!rot) return;
      try {
        _db.prepare(`INSERT INTO perfil_rotinas (perfil_id, rotina_id, ver, incluir, alterar, excluir) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(perfilId, rot.id, f.ver ? 1 : 0, f.incluir ? 1 : 0, f.alterar ? 1 : 0, f.excluir ? 1 : 0);
      } catch {}
    });
    return perfilId;
  }

  const TUDO  = { ver: 1, incluir: 1, alterar: 1, excluir: 1 };
  const SOVER = { ver: 1, incluir: 0, alterar: 0, excluir: 0 };
  const RW    = { ver: 1, incluir: 1, alterar: 1, excluir: 0 }; // SECAD/PAC-lançamento: sem exclusão

  seedPerfil('secop', 'Acesso Total', 'Acesso completo a todas as rotinas do SECOP.',
    [['dashboard', SOVER], ['processos', TUDO], ['cotacao', TUDO], ['fornecedores', TUDO]]);

  seedPerfil('secad', 'Validador', 'Valida contratos e gera comunicados.',
    [['validacao', RW], ['comunicados', RW]]);
  seedPerfil('secad', 'Supervisor', 'Acompanha validação e comunicados, somente leitura.',
    [['validacao', SOVER], ['comunicados', SOVER]]);

  seedPerfil('pac', 'Gestor de Área', 'Lança dados do PAC da própria área.',
    [['pac-lancamento', RW], ['pac-acompanhamento', SOVER]]);
  seedPerfil('pac', 'Analista DEPLA', 'Gestão completa do PAC; acompanha lançamentos.',
    [['pac-gestao', TUDO], ['pac-lancamento', SOVER], ['pac-solicitacoes', TUDO]]);

  try { _db.exec(`ALTER TABLE user_modulos ADD COLUMN perfil_id INTEGER REFERENCES perfis(id)`); } catch {}
  try { _db.exec(`ALTER TABLE users ADD COLUMN nome_completo TEXT`); } catch {}
  try { _db.exec(`ALTER TABLE users ADD COLUMN telefone TEXT`); } catch {}
  // DDD separado do número, mesmo padrão de fornecedores.telefone_ddd/celular_ddd
  // (ver public/js/telefone-br.js) — usuários cadastrados/editados antes disso
  // continuam com o telefone inteiro (com ou sem DDD) só no campo `telefone`.
  try { _db.exec(`ALTER TABLE users ADD COLUMN telefone_ddd TEXT`); } catch {}
  try { _db.exec(`ALTER TABLE users ADD COLUMN departamento_id INTEGER REFERENCES departamentos(id)`); } catch {}
  try { _db.exec(`ALTER TABLE sessions ADD COLUMN perfil_id INTEGER REFERENCES perfis(id)`); } catch {}

  // 3 níveis de admin (master / admin_sistema / admin_operacional) substituem o
  // par role='admin'+acesso_avancado. Migração roda UMA VEZ (config flag) — não
  // promove ninguém às cegas: só quem já tinha acesso_avancado=1 (ou é master)
  // vira admin_sistema; quem era 'admin' sem acesso_avancado nunca teve poder
  // real no painel (requireAdmin já bloqueava essa combinação) e vira
  // admin_operacional SEM departamento (fail-closed) — fica registrado em logs
  // pra revisão manual. O depop_acesso de cada usuário SECAD também é traduzido
  // pro perfil equivalente, nunca concedendo mais do que a pessoa já tinha.
  try {
    const jaFeito = _db.prepare(`SELECT valor FROM config WHERE chave = 'migracao_perfis_v1'`).get();
    if (!jaFeito) {
      const registrarLogMigracao = (acao, descricao) => {
        try { _db.prepare(`INSERT INTO logs (tipo, acao, descricao) VALUES ('SISTEMA', ?, ?)`).run(acao, descricao); } catch {}
      };

      // Backfill do departamento padrão PRIMEIRO (todo mundo pré-existente já usa
      // o SECOP, que é do DEPAD) — o rebaixamento de admin roda DEPOIS de propósito,
      // pra garantir que os 3 casos fail-closed abaixo fiquem com departamento_id
      // NULL por último, sem essa UPDATE genérica sobrescrever de volta pra DEPAD.
      const depad = _db.prepare(`SELECT id FROM departamentos WHERE slug = 'depad'`).get();
      if (depad) _db.prepare(`UPDATE users SET departamento_id = ? WHERE departamento_id IS NULL AND username != 'master'`).run(depad.id);

      _db.prepare(`UPDATE users SET role = 'admin_sistema' WHERE role = 'admin' AND (username = 'master' OR acesso_avancado = 1)`).run();
      const rebaixados = _db.prepare(`SELECT id, username FROM users WHERE role = 'admin' AND username != 'master'`).all();
      rebaixados.forEach(u => {
        _db.prepare(`UPDATE users SET role = 'admin_operacional', departamento_id = NULL WHERE id = ?`).run(u.id);
        registrarLogMigracao('MIGRACAO_REVISAR',
          `Migração de perfis: "${u.username}" era admin sem acesso avançado — virou admin_operacional sem departamento. Revisar manualmente.`);
      });

      const secopMod = _db.prepare(`SELECT id FROM modulos WHERE slug = 'secop'`).get();
      const secopPerfil = secopMod && _db.prepare(`SELECT id FROM perfis WHERE modulo_id = ? AND nome = 'Acesso Total'`).get(secopMod.id);
      if (secopMod && secopPerfil) {
        _db.prepare(`UPDATE user_modulos SET perfil_id = ? WHERE modulo_id = ? AND perfil_id IS NULL`).run(secopPerfil.id, secopMod.id);
      }

      const secadMod = _db.prepare(`SELECT id FROM modulos WHERE slug = 'secad'`).get();
      if (secadMod) {
        const validador     = _db.prepare(`SELECT id FROM perfis WHERE modulo_id = ? AND nome = 'Validador'`).get(secadMod.id);
        const rotValidacao  = _db.prepare(`SELECT id FROM rotinas WHERE modulo_id = ? AND slug = 'validacao'`).get(secadMod.id);

        // Perfil de migração: preserva quem hoje só tem "valida" (o default de
        // depop_acesso pra quem nunca teve linha lá) sem herdar "comunicados".
        let soValida;
        try {
          soValida = _db.prepare(`INSERT INTO perfis (modulo_id, nome, descricao) VALUES (?, ?, ?)`)
            .run(secadMod.id, 'Validador (só validação) [migração]', 'Gerado na migração: tinha só validação em depop_acesso.').lastInsertRowid;
        } catch {
          const ex = _db.prepare(`SELECT id FROM perfis WHERE modulo_id = ? AND nome = ?`).get(secadMod.id, 'Validador (só validação) [migração]');
          soValida = ex && ex.id;
        }
        if (soValida && rotValidacao) {
          try { _db.prepare(`INSERT INTO perfil_rotinas (perfil_id, rotina_id, ver, incluir, alterar) VALUES (?, ?, 1, 1, 1)`).run(soValida, rotValidacao.id); } catch {}
        }

        const acessos = _db.prepare(`SELECT user_id, valida, comunicados FROM depop_acesso`).all();
        const setPerfil = _db.prepare(`UPDATE user_modulos SET perfil_id = ? WHERE user_id = ? AND modulo_id = ? AND perfil_id IS NULL`);
        acessos.forEach(a => {
          let alvo = null;
          if (a.valida && a.comunicados) alvo = validador && validador.id;
          else if (a.valida && !a.comunicados) alvo = soValida;
          // !valida (com ou sem comunicados): fica sem perfil — preserva o "sem nada" de hoje
          if (alvo) setPerfil.run(alvo, a.user_id, secadMod.id);
        });
        // Quem tem acesso ao módulo SECAD mas nunca teve linha em depop_acesso
        // (default de hoje = valida=1,comunicados=0) recebe o mesmo tratamento.
        if (soValida) {
          _db.prepare(`
            UPDATE user_modulos SET perfil_id = ?
            WHERE modulo_id = ? AND perfil_id IS NULL
              AND user_id NOT IN (SELECT user_id FROM depop_acesso)
          `).run(soValida, secadMod.id);
        }
      }

      _db.prepare(`INSERT INTO config (chave, valor) VALUES ('migracao_perfis_v1', '1')`).run();
    }
  } catch {}

  // ── Depop/Comunicados: parâmetros configuráveis do sistema ───────────────────
  // Tabela chave/valor editável só pelo master (ex.: url_plataforma_acesso,
  // numero_comunicado). O comunicado lê estes valores em tempo de geração — a URL
  // NUNCA é escrita fixa no código/template. Semeia com placeholder óbvio.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS parametro_sistema (
      chave TEXT PRIMARY KEY,
      valor TEXT
    );
  `);
  const seedParam = _db.prepare(`INSERT OR IGNORE INTO parametro_sistema (chave, valor) VALUES (?, ?)`);
  seedParam.run('url_plataforma_acesso', 'A DEFINIR');
  seedParam.run('numero_comunicado', '01/2026');

  // ── Depop/Comunicados: rastreamento de geração e entrega ─────────────────────
  // Uma linha por contrato (id_avaliacao UNIQUE). `geracoes` é o CONTADOR de PDFs
  // gerados (incrementa a cada geração — pedido do Alex: saber que já foi gerado e
  // quantas vezes). `enviado`/`dt_envio` é o controle de entrega, marcado à mão e
  // independente da geração. Como validacao_contrato, vive no secop.db e liga ao
  // depop.db só pelo id_avaliacao.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS comunicado_gerado (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      id_avaliacao      INTEGER NOT NULL UNIQUE,
      geracoes          INTEGER NOT NULL DEFAULT 0,
      primeira_geracao  DATETIME,
      ultima_geracao    DATETIME,
      gerado_por        INTEGER,
      enviado           INTEGER NOT NULL DEFAULT 0,
      dt_envio          DATETIME,
      FOREIGN KEY (gerado_por) REFERENCES users(id)
    );
  `);

  // ── Depop: concessionários removidos da listagem (soft-remove) ───────────────
  // Alex não quer DELETE em ClienteConcessionario (o depop.db é recriado do zero
  // a cada sincronização, e outras tabelas referenciam `codigo` por convenção, não
  // por FK — apagar quebraria histórico). Em vez disso, marca aqui (no secop.db,
  // ligado só por `codigo`, mesmo padrão de validacao_contrato/comunicado_gerado)
  // e todo ponto que lista/conta/gera comunicado passa a ignorar esses códigos.
  // O registro em si nunca some do depop.db — só fica invisível na plataforma.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS concessionario_removido (
      codigo       INTEGER PRIMARY KEY,
      motivo       TEXT,
      removido_em  DATETIME DEFAULT CURRENT_TIMESTAMP,
      removido_por INTEGER,
      FOREIGN KEY (removido_por) REFERENCES users(id)
    );
  `);

  // Cidades liberadas por usuário em Comunicados (escopo dentro da rotina
  // 'comunicados', não um perfil isolado — ver routes/secad.js cidadesPermitidas()).
  // cidade_id é o id de depop.db/Cidade; mora aqui (secop.db) pelo mesmo motivo
  // de concessionario_removido acima — depop.db é recriado do zero em re-imports.
  // Sem NENHUMA linha pra um usuário = sem restrição (vê todas as cidades).
  _db.exec(`
    CREATE TABLE IF NOT EXISTS secad_cidade_usuarios (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL,
      cidade_id INTEGER NOT NULL,
      UNIQUE (user_id, cidade_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // ── PAC/DEPLA: DFD (Documento de Formalização de Demanda) ────────────────────
  // Cada setor lança itens de demanda dentro de um DFD criado pelo DEPLA. Colunas
  // do DFD são configuráveis por documento (dfd_colunas_ativas escolhe, de um
  // catálogo fixo, quais aparecem e em que ordem) — os valores ficam num modelo
  // chave/valor (dfd_itens_valores) pra suportar isso sem coluna nova por campo.
  // `lista` em dfd_colunas_catalogo casa por STRING com dfd_parametros_lista.lista
  // (mesmo padrão de tipos_extra.unidade — casar por chave, não por FK id).
  _db.exec(`
    CREATE TABLE IF NOT EXISTS setores (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      nome      TEXT    NOT NULL UNIQUE,
      sigla     TEXT,
      ativo     INTEGER NOT NULL DEFAULT 1,
      ordem     INTEGER NOT NULL DEFAULT 0,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS setor_usuarios (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      setor_id INTEGER NOT NULL,
      user_id  INTEGER NOT NULL,
      UNIQUE (setor_id, user_id),
      FOREIGN KEY (setor_id) REFERENCES setores(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dfd_parametros_lista (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      lista     TEXT    NOT NULL,
      valor     TEXT    NOT NULL,
      ordem     INTEGER NOT NULL DEFAULT 0,
      ativo     INTEGER NOT NULL DEFAULT 1,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (lista, valor)
    );

    CREATE TABLE IF NOT EXISTS dfd_colunas_catalogo (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      slug         TEXT    NOT NULL UNIQUE,
      label        TEXT    NOT NULL,
      grupo        TEXT    NOT NULL,
      tipo_input   TEXT    NOT NULL,
      lista        TEXT,
      obrigatoria  INTEGER NOT NULL DEFAULT 0,
      ordem_padrao INTEGER NOT NULL DEFAULT 0,
      ativa        INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS dfds (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ano_base      INTEGER NOT NULL,
      titulo        TEXT    NOT NULL,
      descricao     TEXT,
      status        TEXT    NOT NULL DEFAULT 'aberto',
      criado_por    INTEGER REFERENCES users(id),
      criado_em     DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dfd_setores (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      dfd_id   INTEGER NOT NULL,
      setor_id INTEGER NOT NULL,
      UNIQUE (dfd_id, setor_id),
      FOREIGN KEY (dfd_id) REFERENCES dfds(id) ON DELETE CASCADE,
      FOREIGN KEY (setor_id) REFERENCES setores(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dfd_colunas_ativas (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      dfd_id    INTEGER NOT NULL,
      coluna_id INTEGER NOT NULL,
      ordem     INTEGER NOT NULL DEFAULT 0,
      UNIQUE (dfd_id, coluna_id),
      FOREIGN KEY (dfd_id) REFERENCES dfds(id) ON DELETE CASCADE,
      FOREIGN KEY (coluna_id) REFERENCES dfd_colunas_catalogo(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dfd_itens (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      dfd_id        INTEGER NOT NULL,
      setor_id      INTEGER NOT NULL,
      numero_item   INTEGER NOT NULL,
      criado_por    INTEGER REFERENCES users(id),
      criado_em     DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      excluido_em   DATETIME,
      FOREIGN KEY (dfd_id) REFERENCES dfds(id) ON DELETE CASCADE,
      FOREIGN KEY (setor_id) REFERENCES setores(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dfd_itens_valores (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id   INTEGER NOT NULL,
      coluna_id INTEGER NOT NULL,
      valor     TEXT,
      UNIQUE (item_id, coluna_id),
      FOREIGN KEY (item_id) REFERENCES dfd_itens(id) ON DELETE CASCADE,
      FOREIGN KEY (coluna_id) REFERENCES dfd_colunas_catalogo(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dfd_pedidos_edicao (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      dfd_id         INTEGER NOT NULL,
      item_id        INTEGER,
      setor_id       INTEGER NOT NULL,
      solicitante_id INTEGER REFERENCES users(id),
      tipo           TEXT    NOT NULL,
      justificativa  TEXT,
      status         TEXT    NOT NULL DEFAULT 'pendente',
      respondido_por INTEGER REFERENCES users(id),
      resposta       TEXT,
      criado_em      DATETIME DEFAULT CURRENT_TIMESTAMP,
      respondido_em  DATETIME,
      consumido_em   DATETIME,
      FOREIGN KEY (dfd_id) REFERENCES dfds(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES dfd_itens(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_dfd_itens_valores_item ON dfd_itens_valores(item_id);
    CREATE INDEX IF NOT EXISTS idx_dfd_itens_dfd_setor ON dfd_itens(dfd_id, setor_id);
  `);

  // ── PAC: consolidação e execução (após o DFD fechar) ──────────────────────────
  // numero_pac (AAAA-NNN) só existe depois que o DEPLA consolida um DFD fechado
  // — atribuído/recalculado por rotina em routes/pac.js, nunca escrito à mão.
  // status_execucao acompanha o item ao longo do exercício, independente do
  // status (aberto/análise/fechado) do DFD em si — são dois ciclos de vida
  // sobrepostos (planejamento vs. execução).
  try { _db.exec(`ALTER TABLE dfd_itens ADD COLUMN numero_pac TEXT`); } catch {}
  try { _db.exec(`ALTER TABLE dfd_itens ADD COLUMN status_execucao TEXT NOT NULL DEFAULT 'Não Iniciado'`); } catch {}

  _db.exec(`
    CREATE TABLE IF NOT EXISTS pac_consolidacoes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      dfd_id          INTEGER NOT NULL UNIQUE,
      consolidado_por INTEGER REFERENCES users(id),
      consolidado_em  DATETIME DEFAULT CURRENT_TIMESTAMP,
      total_itens     INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (dfd_id) REFERENCES dfds(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pac_solicitacoes (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      dfd_id                INTEGER NOT NULL,
      item_id               INTEGER,
      numero_movimento      TEXT,
      data_requisicao       DATE,
      setor_requisitante_id INTEGER,
      natureza_orcamentaria TEXT,
      descricao_objeto      TEXT,
      valor_tu_mlp          REAL NOT NULL DEFAULT 0,
      valor_rdc             REAL NOT NULL DEFAULT 0,
      observacao            TEXT,
      criado_por            INTEGER REFERENCES users(id),
      criado_em             DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em         DATETIME DEFAULT CURRENT_TIMESTAMP,
      excluido              INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (dfd_id) REFERENCES dfds(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES dfd_itens(id) ON DELETE SET NULL,
      FOREIGN KEY (setor_requisitante_id) REFERENCES setores(id)
    );

    CREATE INDEX IF NOT EXISTS idx_pac_solicitacoes_dfd ON pac_solicitacoes(dfd_id);
    CREATE INDEX IF NOT EXISTS idx_pac_solicitacoes_item ON pac_solicitacoes(item_id);
    -- Único por DFD só quando atribuído (NULL antes de consolidar não conta) —
    -- índice PARCIAL, senão dois itens nunca consolidados (ambos NULL) colidiriam.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dfd_itens_numero_pac
      ON dfd_itens(dfd_id, numero_pac) WHERE numero_pac IS NOT NULL;
  `);

  // Nº SEI — só esse era realmente novo. numero_movimento já existia rotulado
  // "Nº Movimento (TOTVS)" na tela de Solicitações, então TOTVS é reaproveitado
  // (só o rótulo virou "Nº TOTVS"), sem coluna duplicada.
  try { _db.exec(`ALTER TABLE pac_solicitacoes ADD COLUMN numero_sei TEXT`); } catch {}

  // Seed dos setores participantes do PAC (nomes exatamente como fornecidos)
  [
    'Depop', 'Dereh', 'Detin', 'Depla', 'Depad', 'Audin', 'Defin', 'Deuni',
    'Detec', 'Dejur', 'Secom', 'Ouvidoria', 'Conger', 'Deinfra', 'Gabin',
    'Dirfin', 'Dirtec', 'Presi', 'Gerência Uberlândia', 'Gerência Caratinga',
    'Gerência Gov. Valadares', 'Gerência Barbacena', 'Gerência Juiz de Fora',
  ].forEach((nome, i) => {
    try { _db.prepare(`INSERT INTO setores (nome, ordem) VALUES (?, ?)`).run(nome, i + 1); } catch {}
  });

  // Seed das listas de parâmetro usadas como dropdown nas colunas do DFD
  {
    const seedLista = (lista, valores) => {
      valores.forEach((valor, i) => {
        try { _db.prepare(`INSERT INTO dfd_parametros_lista (lista, valor, ordem) VALUES (?, ?, ?)`).run(lista, valor, i + 1); } catch {}
      });
    };
    seedLista('tipo', ['Material', 'Serviço', 'Imobilizado']);
    seedLista('subitem', ['Permanente', 'Consumo', 'Continuado', 'Não Continuado', 'Obras']);
    seedLista('prioridade', ['Alta', 'Média', 'Baixa']);
    seedLista('fonte_pagadora', ['TU', 'RDC', 'MLP']);
    seedLista('unidade_medida', ['Unidade', 'Mês', 'Anual', 'M²', 'Litros', 'KG', 'Serviço']);
    seedLista('sim_nao', ['Sim', 'Não']);
  }

  // Seed do catálogo fixo de colunas do DFD (17 colunas, 3 grupos visuais).
  // "numero_item" é tipo_input 'auto' — não gera linha em dfd_itens_valores,
  // o frontend lê direto de dfd_itens.numero_item (é sempre a 1ª coluna, sticky).
  {
    const seedColuna = (slug, label, grupo, tipo_input, lista, obrigatoria, ordem_padrao) => {
      try {
        _db.prepare(`
          INSERT INTO dfd_colunas_catalogo (slug, label, grupo, tipo_input, lista, obrigatoria, ordem_padrao)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(slug, label, grupo, tipo_input, lista || null, obrigatoria ? 1 : 0, ordem_padrao);
      } catch {}
    };
    seedColuna('numero_item',      'Nº',                       'A', 'auto',     null,             0, 1);
    seedColuna('tipo',             'Tipo',                     'A', 'select',   'tipo',           0, 2);
    seedColuna('subitem',          'Subitem',                  'A', 'select',   'subitem',        0, 3);
    seedColuna('encaminhar_para',  'Encaminhar para',          'A', 'texto',    null,             0, 4);
    seedColuna('descricao_objeto', 'Descrição do Objeto',      'A', 'textarea', null,             1, 5);
    seedColuna('unidade_medida',   'Unidade',                  'A', 'select',   'unidade_medida', 0, 6);
    seedColuna('quantidade',       'Qtd',                      'A', 'numero',   null,             0, 7);
    seedColuna('valor_estimado',   'Valor Est. Anual (R$)',    'A', 'moeda',    null,             0, 8);
    seedColuna('justificativa',    'Justificativa',            'A', 'textarea', null,             0, 9);
    seedColuna('prioridade',       'Prioridade',                'A', 'select',   'prioridade',     0, 10);
    seedColuna('data_desejada',    'Data Desejada',            'A', 'data',     null,             0, 11);
    seedColuna('dependencia',      'Dependência?',             'A', 'select',   'sim_nao',        0, 12);
    seedColuna('fonte_pagadora',   'Fonte Pagadora',           'A', 'select',   'fonte_pagadora', 0, 13);
    seedColuna('possui_contrato',  'Possui Contrato?',         'B', 'select',   'sim_nao',        0, 14);
    seedColuna('numero_contrato',  'Nº Contrato',              'C', 'texto',    null,             0, 15);
    seedColuna('razao_social',     'Razão Social',             'C', 'texto',    null,             0, 16);
    seedColuna('data_vencimento',  'Vencimento',                'C', 'data',     null,             0, 17);
  }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER,
      username  TEXT,
      tipo      TEXT NOT NULL,
      acao      TEXT NOT NULL,
      descricao TEXT,
      ip        TEXT,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

setupDb();

// Proxy transparente — delega sempre ao _db atual (permite reabrir sem reiniciar o servidor)
const db = new Proxy({}, {
  get(_, prop) {
    const val = _db[prop];
    return typeof val === 'function' ? val.bind(_db) : val;
  }
});

function gerarNumeroProcesso() {
  const ano = new Date().getFullYear();
  const row = db.prepare(
    `SELECT numero_processo FROM processos WHERE numero_processo LIKE ? ORDER BY id DESC LIMIT 1`
  ).get(`${ano}/%`);

  let seq = 1;
  if (row) {
    const parts = row.numero_processo.split('/');
    seq = parseInt(parts[1], 10) + 1;
  }
  return `${ano}/${String(seq).padStart(3, '0')}`;
}

// ── Base do Depop (arquivo separado: data/depop.db) ───────────────────────────
// Dataset de referência do módulo Depop (renovações), sincronizado a partir do
// SQL Server pelo conversor (databse/converter-depop.js). Fica num arquivo à
// parte de propósito: exportar/importar/re-sincronizar o Depop nunca toca no
// secop.db (dados operacionais). Se o arquivo ainda não existe, abrir aqui só
// cria um .db vazio — as tabelas vêm do conversor ou de uma importação.
const depopFilePath = path.join(dataDir, 'depop.db');
let _depop;

function setupDepop() {
  _depop = new DatabaseSync(depopFilePath);
  _depop.exec('PRAGMA journal_mode = WAL');
}

setupDepop();

const depopDb = new Proxy({}, {
  get(_, prop) {
    const val = _depop[prop];
    return typeof val === 'function' ? val.bind(_depop) : val;
  }
});

// ── Anexos (arquivo separado: data/anexos.db) ─────────────────────────────────
// Guarda os comprovantes de entrega dos comunicados (a cópia assinada que volta
// como prova) — como BLOB. Fica num arquivo à parte de propósito: os anexos
// podem crescer bastante e NÃO devem inchar/arriscar o secop.db (contratos
// assinados). Tem export/import próprio, então viajam no backup sem tocar nos
// outros bancos. Diferente do depop.db, o schema é NOSSO — criamos a tabela aqui
// (idempotente), inclusive depois de uma importação. Liga ao depop.db só pelo
// id_avaliacao; `enviado_por`/`_nome` são desnormalizados (não há FK entre .db).
const anexosFilePath = path.join(dataDir, 'anexos.db');
let _anexos;

function setupAnexos() {
  _anexos = new DatabaseSync(anexosFilePath);
  _anexos.exec('PRAGMA journal_mode = WAL');
  _anexos.exec(`
    CREATE TABLE IF NOT EXISTS comprovante_entrega (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      id_avaliacao      INTEGER NOT NULL,
      nome_arquivo      TEXT,
      mime              TEXT,
      tamanho           INTEGER,
      conteudo          BLOB NOT NULL,
      enviado_por       INTEGER,
      enviado_por_nome  TEXT,
      criado_em         DATETIME DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compr_aval ON comprovante_entrega(id_avaliacao);
  `);
  // Foto de perfil do usuário — mesmo padrão do comprovante (BLOB, arquivo à
  // parte): não existe upload-pra-disco em lugar nenhum deste projeto, então a
  // foto segue a mesma casa/mecânica em vez de inventar um padrão novo.
  _anexos.exec(`
    CREATE TABLE IF NOT EXISTS user_foto (
      user_id       INTEGER PRIMARY KEY,
      mime          TEXT NOT NULL,
      tamanho       INTEGER NOT NULL,
      conteudo      BLOB NOT NULL,
      atualizado_em DATETIME DEFAULT (datetime('now'))
    );
  `);
}

setupAnexos();

const anexosDb = new Proxy({}, {
  get(_, prop) {
    const val = _anexos[prop];
    return typeof val === 'function' ? val.bind(_anexos) : val;
  }
});

module.exports = {
  db, setupDb, gerarNumeroProcesso,
  depopDb, setupDepop, depopFilePath,
  anexosDb, setupAnexos, anexosFilePath
};
