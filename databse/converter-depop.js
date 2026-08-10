// Converte o dump do SQL Server (Base.sql, gerado pelo SSMS, UTF-16) para um
// SQLite em data/depop.db. Repetível: dropa e recria as 5 tabelas e recarrega
// todos os dados a partir do Base.sql — use quando quiser refazer a base do zero.
//
// Regras importantes:
//  - SEM IDENTITY/AUTOINCREMENT. As PKs são INTEGER PRIMARY KEY "puro", então os
//    ids inseridos são exatamente os do dump (os mesmos do SQL Server), que é a
//    referência usada na sincronização manual.
//  - Datas viram TEXT 'YYYY-MM-DD'; decimais viram REAL.
//
// Uso: node databse/converter-depop.js

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Fontes do dump (todas UTF-16 do SSMS). Base.sql = 5 tabelas de referência;
// Table.sql = concessionario_acess (credenciais de acesso à plataforma de adesão,
// usadas na aba Comunicados). Table.sql é opcional — se faltar, só é pulado.
const SRCS = [
  path.join(__dirname, 'Base.sql'),
  path.join(__dirname, 'Table.sql'),
];
const OUT = path.join(__dirname, '..', 'data', 'depop.db');

// ── Schema SQLite (escrito à mão a partir do dump) ────────────────────────────
const SCHEMA = `
DROP TABLE IF EXISTS AvaliacaoAreaRenovacao;
CREATE TABLE AvaliacaoAreaRenovacao (
  id              INTEGER,
  codigo          INTEGER,
  concessionaria  TEXT,
  endereco        TEXT,
  numero_ccu      TEXT,
  data_vencimento TEXT,
  valor_ponto     REAL,
  valor_30_ceasa  REAL,
  id_cidade       INTEGER,
  id_contrato     INTEGER PRIMARY KEY,
  Status          TEXT NOT NULL DEFAULT 'A' CHECK (Status IN ('I','A')),
  dt_aceite_cpl   TEXT,
  dt_pagto_taxa   TEXT
);

DROP TABLE IF EXISTS Cidade;
CREATE TABLE Cidade (
  id          INTEGER PRIMARY KEY,
  descricao   TEXT NOT NULL,
  uf          TEXT NOT NULL DEFAULT 'MG',
  codigo_ibge INTEGER NOT NULL
);

DROP TABLE IF EXISTS ClienteConcessionario;
CREATE TABLE ClienteConcessionario (
  codigo         INTEGER PRIMARY KEY,
  cliente        TEXT NOT NULL,
  endereco       TEXT,
  cpf_cnpj       TEXT,
  insc_estadual  TEXT,
  insc_municipal TEXT,
  telefone       TEXT,
  email          TEXT,
  email2         TEXT,
  email3         TEXT,
  bairro         TEXT,
  cep            TEXT
);

DROP TABLE IF EXISTS ContratoCCU;
CREATE TABLE ContratoCCU (
  id       INTEGER PRIMARY KEY,
  contrato TEXT NOT NULL
);

DROP TABLE IF EXISTS TarifaContrato20Anos;
CREATE TABLE TarifaContrato20Anos (
  id               INTEGER PRIMARY KEY,
  codigo           INTEGER NOT NULL,
  sequencial       INTEGER NOT NULL DEFAULT 1,
  concessionario   TEXT,
  endereco         TEXT,
  cnpj             TEXT,
  numero_ccu       TEXT,
  atividades       TEXT,
  atual_tarifa_uso REAL,
  nova_tarifa_uso  REAL,
  area_m2          REAL,
  data_assinatura  TEXT,
  data_vencimento  TEXT,
  id_contrato      INTEGER
);

-- Credenciais de acesso à plataforma de adesão (uma linha por concessionário).
-- codigo → ClienteConcessionario.codigo; login (CNPJ formatado) e codeaccess
-- (senha provisória) vêm prontos do SQL Server — a plataforma nunca os gera.
DROP TABLE IF EXISTS concessionario_acess;
CREATE TABLE concessionario_acess (
  codigo     INTEGER,
  login      TEXT,
  name       TEXT,
  codeaccess TEXT
);
CREATE INDEX idx_acess_codigo ON concessionario_acess(codigo);
`;

// ── Leitura do dump (UTF-16 LE com BOM) ───────────────────────────────────────
function lerDump(src) {
  const buf = fs.readFileSync(src);
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le').slice(1);
  return buf.toString('utf8');
}

// Quebra o conteúdo de VALUES(...) em tokens de topo, respeitando strings
// (aspas simples, com '' = aspa escapada) e parênteses (CAST(...)).
function tokenizeValues(s) {
  const out = [];
  let cur = '', inStr = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "'") {
        if (s[i + 1] === "'") { cur += "''"; i++; }
        else { inStr = false; cur += c; }
      } else cur += c;
    } else if (c === "'") { inStr = true; cur += c; }
    else if (c === '(') { depth++; cur += c; }
    else if (c === ')') { depth--; cur += c; }
    else if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

// Converte um token T-SQL em valor JS.
function mapToken(t) {
  t = t.trim();
  if (/^NULL$/i.test(t)) return null;
  const cast = t.match(/^CAST\(([\s\S]*)\s+AS\s+[\s\S]*\)$/i);
  if (cast) return mapToken(cast[1].trim());
  const str = t.match(/^N?'([\s\S]*)'$/);
  if (str) return str[1].replace(/''/g, "'");
  const num = Number(t);
  return Number.isNaN(num) ? t : num;
}

function main() {
  try { fs.unlinkSync(OUT); } catch {}
  try { fs.unlinkSync(OUT + '-wal'); } catch {}
  try { fs.unlinkSync(OUT + '-shm'); } catch {}

  const db = new DatabaseSync(OUT);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  const reInsert = /^INSERT \[dbo\]\.\[(\w+)\] \(([^)]*)\) VALUES \(([\s\S]*)\)\s*$/;
  const stmtCache = new Map();
  const contagem = {};

  db.exec('BEGIN');
  for (const src of SRCS) {
    if (!fs.existsSync(src)) { console.warn('  (pulado, não encontrado):', path.basename(src)); continue; }
    for (const linha of lerDump(src).split(/\r?\n/)) {
      const m = linha.match(reInsert);
      if (!m) continue;
      const tabela = m[1];
      const cols = m[2].split(',').map(c => c.trim().replace(/^\[|\]$/g, ''));
      const valores = tokenizeValues(m[3]).map(mapToken);
      if (valores.length !== cols.length) {
        throw new Error(`Colunas x valores divergem em ${tabela}: ${cols.length} vs ${valores.length}\n${linha.slice(0, 200)}`);
      }
      const chave = tabela + '|' + cols.join(',');
      let stmt = stmtCache.get(chave);
      if (!stmt) {
        const sql = `INSERT INTO ${tabela} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
        stmt = db.prepare(sql);
        stmtCache.set(chave, stmt);
      }
      stmt.run(...valores);
      contagem[tabela] = (contagem[tabela] || 0) + 1;
    }
  }
  db.exec('COMMIT');

  console.log('Gerado:', OUT);
  for (const t of Object.keys(contagem).sort()) {
    const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    console.log(`  ${t}: ${contagem[t]} inseridos, ${n} na tabela`);
  }
  db.close();
}

main();
