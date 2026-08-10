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

  // Semeia os módulos padrão (ignora se já existirem — idempotente)
  [
    { slug: 'secop', nome: 'SECOP - Cotações',        cor: '#1A6B35', home: '/index.html', ordem: 1 },
    { slug: 'depop', nome: 'Depop - Concessionários', cor: '#1565C0', home: '/depop.html', ordem: 2 },
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
  // Número de protocolo de entrega: sequencial, atribuído 1x na 1ª geração e
  // estável nas reimpressões (2ª via mostra o mesmo número).
  try { _db.exec(`ALTER TABLE comunicado_gerado ADD COLUMN protocolo_seq INTEGER`); } catch {}

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
