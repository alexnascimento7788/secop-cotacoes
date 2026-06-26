const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'secop.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
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
  { nome: 'Concluído',     ordem: 3 },
  { nome: 'Parado',        ordem: 4 },
].forEach(s => {
  try {
    db.prepare(`INSERT INTO status (nome, ordem) VALUES (?, ?)`).run(s.nome, s.ordem);
  } catch {}
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

db.exec(`
  CREATE TABLE IF NOT EXISTS status_historico (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    processo_id  INTEGER NOT NULL,
    status_de    TEXT,
    status_para  TEXT NOT NULL,
    alterado_em  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (processo_id) REFERENCES processos(id) ON DELETE CASCADE
  );
`);

// Migrações — falham silenciosamente se coluna/renomeação já existir
try { db.exec(`ALTER TABLE processos    ADD COLUMN data_abertura DATE`);    } catch {}
try { db.exec(`ALTER TABLE processos    ADD COLUMN observacoes2 TEXT`);     } catch {}
try { db.exec(`ALTER TABLE processos    ADD COLUMN mostrar_menor_preco INTEGER DEFAULT 1`); } catch {}
try { db.exec(`ALTER TABLE fornecedores ADD COLUMN frete TEXT`);            } catch {}
try { db.exec(`ALTER TABLE precos RENAME COLUMN preco_unitario TO preco_unitario_mes`); } catch {}
try { db.exec(`ALTER TABLE precos RENAME COLUMN preco_total    TO preco_total_ano`);    } catch {}

module.exports = { db, gerarNumeroProcesso };
