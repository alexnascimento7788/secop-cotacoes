// ── PAC: motor de importação de planilhas + Console SQL ───────────────────────
// Ferramenta administrativa (master/admin_sistema, nunca admin_operacional)
// pra migrar o PAC 2026 das planilhas Excel de cada setor pro sistema, mais um
// console SQL genérico pros 3 bancos. Arquivo separado de routes/pac.js (que
// já tinha ~700 linhas e é gateado por Perfil/Rotina por departamento — essa
// ferramenta não é: acesso é só por `role`, ortogonal ao Perfil, mesmo motivo
// pelo qual `routes/admin.js` gateia essas rotas globais direto por role em
// vez de rotina). É a ÚNICA exceção documentada ao comentário no topo de
// routes/pac.js ("PAC só usa a conexão principal — nunca depopDb/anexosDb") —
// aqui isso é literalmente o pedido (Console SQL nos 3 bancos).
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, depopDb, anexosDb } = require('../database');
const { registrarLog, requireModulo, gerarCodigoPac } = require('../middleware');
const crypto = require('crypto');

const router = express.Router();
const pac = requireModulo('pac');

// Campos de contrato (grupo B+C) que ganham "Não informado" em vez de NULL
// quando vêm em branco na planilha — ver comentário no loop de parsing da
// Fase 1 pra motivo.
const SLUGS_CONTRATO_SENTINELA = new Set(['possui_contrato', 'numero_contrato', 'razao_social', 'data_vencimento', 'contrato_renovado']);

function requireAdminGlobal(req, res, next) {
  if (req.user.username === 'master' || req.user.role === 'admin_sistema') return next();
  return res.status(403).json({ error: 'Acesso restrito ao administrador do sistema.' });
}

// Guarda mais estrita, só pro "apagar tudo" — é uma ação destrutiva permanente
// na ferramenta (existe pra facilitar o ciclo de teste do Alex agora, mas
// continua lá depois que os dados forem reais). Restrita a `master` mesmo,
// não a qualquer admin_sistema (que tem acesso normal ao resto do arquivo).
function requireMasterSomente(req, res, next) {
  if (req.user.username === 'master') return next();
  return res.status(403).json({ error: 'Ação restrita ao usuário master.' });
}

// ── Leitura pros dropdowns da tela ─────────────────────────────────────────────
// Rotas próprias (não reaproveita GET /api/pac/dfds etc. de routes/pac.js) de
// propósito: aquelas são gateadas por requireRotina('pac-gestao','ver')/
// requireRotinaPac, que só deixa passar master/consulta OU quem tem um Perfil
// concedido no PAC — um admin_sistema "puro" (sem nenhum Perfil de PAC) tomaria
// 403 nelas, contrariando o pedido de que TODO admin_sistema use esta
// ferramenta, não só quem também tem acesso de negócio ao PAC.
router.get('/api/pac/importacao/dfds', pac, requireAdminGlobal, (_req, res) => {
  res.json(db.prepare(`SELECT id, ano_base, titulo, status FROM dfds ORDER BY ano_base DESC, id DESC`).all());
});

router.get('/api/pac/importacao/setores', pac, requireAdminGlobal, (_req, res) => {
  res.json(db.prepare(`SELECT id, nome FROM setores WHERE ativo = 1 ORDER BY ordem`).all());
});

// Catálogo padrão completo — usado no preview quando o DFD ainda nem existe
// ("+ Criar novo DFD"), já que um DFD novo nasce com TODAS as colunas ativas
// do catálogo (mesmo comportamento de POST /api/pac/dfds em routes/pac.js).
router.get('/api/pac/importacao/colunas-catalogo', pac, requireAdminGlobal, (_req, res) => {
  const rows = db.prepare(`
    SELECT id, slug, label, tipo_input, lista, obrigatoria
    FROM dfd_colunas_catalogo WHERE ativa = 1 AND slug != 'numero_item' ORDER BY ordem_padrao
  `).all();
  res.json(rows);
});

router.get('/api/pac/importacao/dfds/:id/colunas-ativas', pac, requireAdminGlobal, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.slug, c.label, c.tipo_input, c.lista, c.obrigatoria
    FROM dfd_colunas_ativas ca JOIN dfd_colunas_catalogo c ON c.id = ca.coluna_id
    WHERE ca.dfd_id = ? AND c.slug != 'numero_item'
    ORDER BY ca.ordem
  `).all(req.params.id);
  res.json(rows);
});

router.get('/api/pac/importacao/dfds/:id/itens-existentes', pac, requireAdminGlobal, (req, res) => {
  const setorId = Number(req.query.setor_id);
  if (!setorId) return res.status(400).json({ error: 'setor_id é obrigatório' });
  const n = db.prepare(`SELECT COUNT(*) AS n FROM dfd_itens WHERE dfd_id = ? AND setor_id = ? AND excluido_em IS NULL`)
    .get(req.params.id, setorId).n;
  res.json({ total: n });
});

// ── Parsing de planilha (regras da seção 2 do prompt original) ────────────────

// Excel guarda data como número serial (dias desde 1899-12-30 — bug histórico
// de compatibilidade com o Lotus 1-2-3 que nunca foi corrigido). 40000–55000
// cobre ~2009–2050, faixa realista pra dado de PAC. Aceita também DD/MM/AAAA
// e ISO (cobre o caso do SheetJS já ter devolvido um Date, virado string no
// JSON antes de chegar aqui).
function parseDataSerial(bruto) {
  const s = String(bruto).trim();
  const num = Number(s.replace(',', '.'));
  if (!isNaN(num) && num >= 40000 && num <= 55000) {
    const iso = new Date(Date.UTC(1899, 11, 30) + num * 86400000).toISOString().slice(0, 10);
    return { valor: iso, alerta: `data serial Excel (${s}) convertida pra ${iso}` };
  }
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (br) return { valor: `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`, alerta: null };
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return { valor: iso[1], alerta: null };
  return { valor: null, alerta: `data "${s}" não reconhecida, campo ficou vazio` };
}

// Aceita número puro, "R$ 1.234,56", "1.234,56", "1234.56". Inválido/vazio: 0.00 + alerta.
function parseMoedaServidor(bruto) {
  if (typeof bruto === 'number' && !isNaN(bruto)) return { valor: bruto, alerta: null };
  const s = String(bruto).trim();
  const limpo = s.replace(/[R$\s]/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const v = parseFloat(limpo);
  if (isNaN(v)) return { valor: 0, alerta: `valor "${s}" inválido, importado como 0,00` };
  return { valor: v, alerta: null };
}

// "TU", "RDC", "MLP", com ou sem percentual, em QUALQUER ordem ("60% TU" OU
// "TU 60%" OU "TU = 60%") e com qualquer separador entre combinações (barra,
// traço, "e", vírgula...) — o parser não depende do separador, só acha cada
// par "<fonte><percentual>" onde ele estiver no texto, então "TU 40% RDC 40%
// e MLP 20%" funciona igual a "TU 40% / RDC 40% / MLP 20%". Achado real em
// planilhas de setores diferentes usando a ordem oposta à do exemplo
// original do prompt — por isso as duas ordens precisam ser aceitas.
function parseFontePagadora(bruto) {
  const s = String(bruto).trim();
  const upper = s.toUpperCase();
  if (['TU', 'RDC', 'MLP'].includes(upper)) return { valor: upper, alerta: null };

  const re = /(\d{1,3})\s*%\s*(TU|RDC|MLP)\b|\b(TU|RDC|MLP)\s*=?\s*(\d{1,3})\s*%/gi;
  const combinacoes = [];
  let m;
  while ((m = re.exec(s))) {
    combinacoes.push(m[2] ? { fonte: m[2].toUpperCase(), pct: Number(m[1]) } : { fonte: m[3].toUpperCase(), pct: Number(m[4]) });
  }
  if (combinacoes.length === 1) return { valor: combinacoes[0].fonte, alerta: null };
  if (combinacoes.length > 1) {
    // Empate no percentual: fica com a primeira fonte citada no texto (sort
    // estável — só troca quando acha um percentual estritamente maior).
    let escolhida = combinacoes[0];
    combinacoes.forEach(c => { if (c.pct > escolhida.pct) escolhida = c; });
    return { valor: escolhida.fonte, alerta: `"${s}" tinha combinação de fontes, usada "${escolhida.fonte}" (maior percentual)` };
  }

  // Fonte(s) citada(s) sem nenhum percentual junto (ex.: "TU e RDC").
  const citadas = [...s.matchAll(/\b(TU|RDC|MLP)\b/gi)].map(x => x[1].toUpperCase());
  if (citadas.length === 1) return { valor: citadas[0], alerta: null };
  if (citadas.length > 1) return { valor: citadas[0], alerta: `"${s}" citava mais de uma fonte sem percentual, usada a primeira ("${citadas[0]}")` };

  return { valor: s, alerta: `fonte pagadora "${s}" não reconhecida, importada como texto` };
}

function normalizarTexto(s) {
  return String(s).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Match case-insensitive/sem-acento contra dfd_parametros_lista. Sem match
// exato: achado real testando a planilha real do Alex (2026-09-06) — a
// coluna "Subitem" de algumas planilhas vem composta com o Tipo do Item
// junto ("Serviço Continuado", "Material Permanente", "Serviço Não
// Continuado"), nunca batendo com o cadastro (que só tem a palavra "pura":
// Permanente/Consumo/Continuado/Não Continuado/Obras). Fallback: se o texto
// bruto CONTÉM uma opção cadastrada inteira, usa ela — entre várias que
// batam (ex.: "continuado" também é substring de "não continuado"), fica
// com a mais específica (a mais longa). Continua transparente: entra um
// alerta explicando a inferência, não silenciosa.
// Auto-cadastro (2026-09-06, pedido explícito do Alex): categoria nova de
// verdade (ex.: "Material de Copa" do Depad — setor com subitens próprios,
// diferentes do padrão Permanente/Consumo/Continuado/Não Continuado/Obras)
// vira opção permanente em Parâmetros na hora, sem precisar cadastrar manual
// antes de tentar de novo. SÓ na importação REAL (`dryRun=false`) — "Simular"
// não pode gravar nada em lugar nenhum, nem aqui (contrato do dry-run,
// v4.17.0). `UNIQUE (lista, valor)` em dfd_parametros_lista deixa o
// `INSERT OR IGNORE` seguro mesmo com o mesmo valor novo se repetindo em
// várias linhas do mesmo lote.
function matchParametroLista(lista, bruto, dryRun) {
  const alvo = normalizarTexto(bruto);
  const opcoes = db.prepare(`SELECT valor FROM dfd_parametros_lista WHERE lista = ? AND ativo = 1`).all(lista);
  const achado = opcoes.find(o => normalizarTexto(o.valor) === alvo);
  if (achado) return { valor: achado.valor, alerta: null };

  const contidas = opcoes.filter(o => alvo.includes(normalizarTexto(o.valor)));
  if (contidas.length) {
    const maisEspecifica = contidas.reduce((a, b) => normalizarTexto(b.valor).length > normalizarTexto(a.valor).length ? b : a);
    return { valor: maisEspecifica.valor, tipo: 'inferido',
      alerta: `"${bruto}" não bate exatamente com nada cadastrado, mas contém "${maisEspecifica.valor}" — usado esse` };
  }

  const valorLimpo = String(bruto).trim();
  if (dryRun) {
    return { valor: valorLimpo, tipo: 'novo',
      alerta: `"${valorLimpo}" não está cadastrado em Parâmetros (lista "${lista}") — será cadastrado automaticamente ao importar de verdade` };
  }
  const ordem = db.prepare(`SELECT COALESCE(MAX(ordem), 0) + 1 AS o FROM dfd_parametros_lista WHERE lista = ?`).get(lista).o;
  db.prepare(`INSERT OR IGNORE INTO dfd_parametros_lista (lista, valor, ordem) VALUES (?, ?, ?)`).run(lista, valorLimpo, ordem);
  return { valor: valorLimpo, tipo: 'novo',
    alerta: `"${valorLimpo}" não estava cadastrado em Parâmetros (lista "${lista}") — cadastrado automaticamente` };
}

// Conta ocorrências de um valor bruto que não bateu EXATO em nenhuma opção
// cadastrada (select) ou fonte reconhecida — alimenta o resumo por coluna.
// Separado em dois grupos porque têm proposta de tratamento diferente:
// "inferido" já existia no cadastro (só a grafia divergia), "novo" é
// categoria de verdade nova (auto-cadastrada ou a cadastrar).
function registrarNaoReconhecido(stat, bruto, tipo) {
  if (!stat) return;
  const chave = String(bruto).trim();
  const mapa = tipo === 'inferido' ? stat.inferidos : tipo === 'novo' ? stat.novos : stat.naoReconhecidos;
  mapa.set(chave, (mapa.get(chave) || 0) + 1);
}

// Vira o "resumo por coluna" que a tela mostra ANTES do log linha-a-linha —
// já com uma proposta de tratamento por linha do resumo, não só o número cru.
function topOcorrencias(mapa) {
  return [...mapa.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([valor, ocorrencias]) => ({ valor, ocorrencias }));
}

function montarResumoColunas(statsColunas, totalLinhas, dryRun) {
  return [...statsColunas.values()].map(s => {
    const naoReconhecidos = topOcorrencias(s.naoReconhecidos); // fonte pagadora não reconhecida — sem auto-cadastro
    const inferidos = topOcorrencias(s.inferidos);             // já existia no cadastro, só a grafia divergia
    const novos = topOcorrencias(s.novos);                     // categoria de verdade nova (auto-cadastro, ver matchParametroLista)

    let proposta = null;
    if (!s.mapeada) {
      proposta = 'Nenhuma coluna da planilha foi mapeada pra este campo — se ele deveria vir preenchido, confira o mapeamento.';
    } else if (s.sentinela) {
      // Coluna de contrato: vazia na planilha vira "Não informado" (dado
      // histórico esperado, não uma falha) — não é a mesma coisa que uma
      // coluna comum vindo vazia. Pedido do Alex, 2026-09-07: "o item em
      // contrato não informado não pode ser considerado nulo, pois faz parte
      // da importação". Mostra a contagem (transparência), sem soar alarme.
      if (s.vazias > 0) proposta = `Vazia em ${s.vazias} de ${totalLinhas} linha(s) — normal pra dado histórico, grava "Não informado" automaticamente (não é uma falha de importação).`;
    } else if (s.vazias === totalLinhas && totalLinhas > 0) {
      proposta = s.obrigatoria
        ? null // obrigatória vazia sempre vira erro de linha, já visível no log
        : 'Veio vazia em 100% das linhas — confira se a coluna certa da planilha foi mapeada aqui, ou se o setor realmente não preenche este campo.';
    } else if (s.vazias > 0 && s.vazias >= totalLinhas * 0.5) {
      proposta = `Veio vazia em ${s.vazias} de ${totalLinhas} linha(s) — mais da metade. Vale conferir a planilha de origem.`;
    }
    if (naoReconhecidos.length) {
      const resumoValores = naoReconhecidos.map(n => `"${n.valor}" (${n.ocorrencias}x)`).join(', ');
      proposta = (proposta ? proposta + ' ' : '') + `Valor(es) não reconhecido(s): ${resumoValores} — importado(s) como texto, confira a planilha.`;
    }
    if (inferidos.length) {
      const resumoValores = inferidos.map(n => `"${n.valor}" (${n.ocorrencias}x)`).join(', ');
      proposta = (proposta ? proposta + ' ' : '') + `Valor(es) inferido(s) a partir de opção já cadastrada: ${resumoValores}.`;
    }
    if (novos.length) {
      const resumoValores = novos.map(n => `"${n.valor}" (${n.ocorrencias}x)`).join(', ');
      // Categoria nova de select (ex.: subitem próprio de um setor) é
      // auto-cadastrada em Parâmetros na importação REAL (v4.17.3) — a
      // mensagem aqui reflete isso, não é mais "considere cadastrar".
      proposta = (proposta ? proposta + ' ' : '') + (dryRun
        ? `Valor(es) novo(s) pra Parâmetros: ${resumoValores} — serão cadastrados automaticamente quando importar de verdade.`
        : `Valor(es) novo(s) cadastrados automaticamente em Parâmetros: ${resumoValores}.`);
    }
    return { slug: s.slug, label: s.label, mapeada: s.mapeada, obrigatoria: s.obrigatoria, sentinela: s.sentinela,
      preenchidas: s.preenchidas, vazias: s.vazias, naoReconhecidos: [...naoReconhecidos, ...inferidos, ...novos], proposta };
  });
}

function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function versaoAtual() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; }
  catch { return '?'; }
}

function cabecalhoSql({ fase, dfdInfo, setorInfo, total }) {
  return [
    `-- ============================================`,
    `-- CEASA CONECTA — Importação PAC`,
    `-- Fase: ${fase}`,
    `-- DFD: ${dfdInfo}`,
    `-- Setor: ${setorInfo}`,
    `-- Total de registros: ${total}`,
    `-- Gerado em: ${new Date().toISOString()}`,
    `-- Versão do sistema: ${versaoAtual()}`,
    `-- Banco de destino: secop.db`,
    `-- ============================================`,
    `-- INSTRUÇÕES: Executar via DBeaver ou sqlite3 CLI`,
    `-- no arquivo secop.db do ambiente de destino.`,
    `-- Verificar a versão do sistema antes de aplicar.`,
    `-- ============================================`,
    ``,
    `BEGIN TRANSACTION;`,
    ``,
  ].join('\n');
}

// ── Fase 1: Lançamentos DFD ────────────────────────────────────────────────────
// Recebe as linhas JÁ remapeadas pro slug do sistema (o fuzzy-match do
// cabeçalho da planilha é feito no cliente, em pac-importacao.js — mesmo
// espírito do SheetJS já usado em novo-processo.js: parse/mapeamento no
// navegador, servidor só recebe dado pronto).
router.post('/api/pac/importacao/dfd', pac, requireAdminGlobal, (req, res) => {
  const { dfd_id, ano_base, titulo, setor_id, mapeamento, modo, linhas, dry_run } = req.body || {};
  if (!setor_id) return res.status(400).json({ error: 'Setor é obrigatório' });
  if (!Array.isArray(linhas) || !linhas.length) return res.status(400).json({ error: 'Nenhuma linha pra importar' });
  if (!['substituir', 'adicionar'].includes(modo)) return res.status(400).json({ error: 'Modo inválido' });
  // Simulação — pedido do Alex (2026-09-06): o alerta de valor não
  // reconhecido só aparecia DEPOIS de já ter gravado no banco, sem chance de
  // corrigir antes. Com dry_run:true roda a MESMA lógica (parsing, matching,
  // resumo por coluna) mas não grava nada — nem cria DFD novo, nem
  // soft-delete, nem INSERT de item/valor. Front chama isso a partir de um
  // botão "Simular" antes de liberar o "Importar de verdade".
  const dryRun = !!dry_run;

  const setor = db.prepare(`SELECT id, nome FROM setores WHERE id = ?`).get(setor_id);
  if (!setor) return res.status(404).json({ error: 'Setor não encontrado' });

  let dfdId, dfd, colunasAtivas;
  if (dfd_id === 'novo') {
    if (!ano_base || !titulo) return res.status(400).json({ error: 'Ano base e título são obrigatórios pra criar o DFD' });
    if (dryRun) {
      // Nada é criado — colunas "ativas" de um DFD que ainda não existe são,
      // por definição, todo o catálogo ativo (mesmo cálculo que rodaria de
      // verdade ao criar o DFD, só sem persistir).
      dfdId = null;
      dfd = { ano_base: Number(ano_base), titulo: String(titulo).trim() };
      colunasAtivas = db.prepare(`
        SELECT id, slug, label, obrigatoria, tipo_input, lista FROM dfd_colunas_catalogo
        WHERE ativa = 1 AND slug != 'numero_item' ORDER BY ordem_padrao
      `).all();
    } else {
      const info = db.prepare(`INSERT INTO dfds (ano_base, titulo, criado_por) VALUES (?, ?, ?)`)
        .run(Number(ano_base), String(titulo).trim(), req.user.user_id);
      dfdId = info.lastInsertRowid;
      // Mesmo comportamento de POST /api/pac/dfds (routes/pac.js): colunas
      // ativas começam todas pré-selecionadas — sem isso o DFD nasce sem
      // NENHUMA coluna mapeável e a importação falharia sempre.
      const colunasCatalogo = db.prepare(`SELECT id, ordem_padrao FROM dfd_colunas_catalogo WHERE ativa = 1 ORDER BY ordem_padrao`).all();
      const insColunaAtiva = db.prepare(`INSERT INTO dfd_colunas_ativas (dfd_id, coluna_id, ordem) VALUES (?, ?, ?)`);
      colunasCatalogo.forEach(c => insColunaAtiva.run(dfdId, c.id, c.ordem_padrao));
      dfd = db.prepare(`SELECT ano_base, titulo FROM dfds WHERE id = ?`).get(dfdId);
      colunasAtivas = db.prepare(`
        SELECT c.id, c.slug, c.label, c.obrigatoria, c.tipo_input, c.lista
        FROM dfd_colunas_ativas ca JOIN dfd_colunas_catalogo c ON c.id = ca.coluna_id
        WHERE ca.dfd_id = ? AND c.slug != 'numero_item'
      `).all(dfdId);
    }
  } else {
    dfdId = Number(dfd_id);
    dfd = db.prepare(`SELECT ano_base, titulo FROM dfds WHERE id = ?`).get(dfdId);
    if (!dfd) return res.status(404).json({ error: 'DFD não encontrado' });
    colunasAtivas = db.prepare(`
      SELECT c.id, c.slug, c.label, c.obrigatoria, c.tipo_input, c.lista
      FROM dfd_colunas_ativas ca JOIN dfd_colunas_catalogo c ON c.id = ca.coluna_id
      WHERE ca.dfd_id = ? AND c.slug != 'numero_item'
    `).all(dfdId);
    if (!dryRun) db.prepare(`INSERT OR IGNORE INTO dfd_setores (dfd_id, setor_id) VALUES (?, ?)`).run(dfdId, setor_id);
  }
  if (!colunasAtivas.length) return res.status(400).json({ error: 'Este DFD ainda não tem nenhuma coluna ativa configurada.' });

  const sqlPartes = [];
  let numeroAtual;
  if (modo === 'substituir') {
    if (!dryRun) {
      db.prepare(`UPDATE dfd_itens SET excluido_em = datetime('now') WHERE dfd_id = ? AND setor_id = ? AND excluido_em IS NULL`)
        .run(dfdId, setor_id);
      // Idempotente por natureza: reaplicar o mesmo UPDATE 2x não faz nada da
      // 2ª vez em diante (a condição "excluido_em IS NULL" já não bate mais).
      sqlPartes.push(`UPDATE dfd_itens SET excluido_em = datetime('now') WHERE dfd_id = ${dfdId} AND setor_id = ${setor_id} AND excluido_em IS NULL;`, ``);
    }
    numeroAtual = 0; // recomeça a numeração do zero pra esse setor neste DFD
  } else {
    numeroAtual = dfdId
      ? db.prepare(`SELECT COALESCE(MAX(numero_item), 0) AS m FROM dfd_itens WHERE dfd_id = ? AND setor_id = ?`).get(dfdId, setor_id).m
      : 0;
  }

  // INSERT normal (id autoincrement, igual todo resto do sistema) pra execução
  // real; o id que sai em lastInsertRowid é reaproveitado, EXPLÍCITO, no texto
  // do .sql gerado — mesma convenção de "id sempre explícito" documentada em
  // project_secop_homolog_migracoes, sem depender de last_insert_rowid() dentro
  // do próprio script.
  const insertItem = db.prepare(`
    INSERT INTO dfd_itens (dfd_id, setor_id, numero_item, criado_por, numero_pac, id_pac, codigo_pac)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertValor = db.prepare(`INSERT INTO dfd_itens_valores (item_id, coluna_id, valor) VALUES (?, ?, ?)`);

  // numero_pac (Momento 1, ver middleware.js) nasce JÁ na importação com o
  // MESMO valor local do numero_item que a linha está recebendo — só vira
  // sequencial global do DFD inteiro quando o DEPLA gerar a consolidação
  // (POST /gerar-consolidacao em routes/pac.js). codigo_pac (SIGLA-NNNN) usa
  // essa mesma sequência, formatado — é o rótulo que nunca muda depois.
  let importados = 0, comAlertas = 0, comErro = 0;
  let numeroPacInicial = null, numeroPacFinal = null;
  const log = [];

  // Resumo por coluna — o log linha-a-linha só mostra ALERTA quando um valor
  // preenchido não foi reconhecido; uma célula em branco em campo opcional
  // (não obrigatório) é uma importação normal, sem alerta nenhum, então uma
  // coluna inteira vindo vazia (ex.: "Subitem" nunca preenchido na planilha)
  // passava batido, sem nada em tela que ajudasse o Alex a perceber e
  // diagnosticar se é dado real do setor ou uma falha de mapeamento. Conta
  // aqui, por coluna: quantas vieram preenchidas/vazias e quais valores
  // brutos não bateram em nenhuma opção cadastrada (com proposta de ação).
  const slugsMapeados = new Set(Object.values(mapeamento || {}));
  const statsColunas = new Map(colunasAtivas.map(c => [c.slug, {
    slug: c.slug, label: c.label, obrigatoria: !!c.obrigatoria, mapeada: slugsMapeados.has(c.slug),
    // Coluna de contrato com sentinela ("Não informado" em vez de NULL, ver
    // loop abaixo) — vazia na planilha É o comportamento esperado pra dado
    // histórico, não uma falha de mapeamento/preenchimento. Sinalizada aqui
    // pra montarResumoColunas() não tratar como alerta (pedido do Alex,
    // 2026-09-07: "o item em contrato não informado não pode ser considerado
    // nulo, pois faz parte da importação").
    sentinela: SLUGS_CONTRATO_SENTINELA.has(c.slug) && c.tipo_input !== 'data',
    preenchidas: 0, vazias: 0, naoReconhecidos: new Map(), inferidos: new Map(), novos: new Map(),
  }]));

  if (!dryRun) {
    registrarLog(req, 'PAC', 'IMPORTACAO_INICIOU',
      `Iniciou importação de lançamentos (Fase 1) — DFD "${dfd.titulo}" (${dfd.ano_base}), setor "${setor.nome}", ${linhas.length} linha(s), modo "${modo}"`);
  }

  linhas.forEach((linha, idx) => {
    const numeroLinha = idx + 1;
    const valoresFinal = {}; // coluna_id -> valor tratado (string ou null)
    const alertasLinha = [];
    // Campos flagados (alerta OU erro) desta linha, um item por coluna —
    // pedido do Alex, 2026-09-06: "não ter autonomia de alterar já na
    // importação e não na planilha". Guarda slug/bruto pra o front (só no
    // "Simular") oferecer um campo de correção inline por linha+coluna, sem
    // precisar editar a planilha e reimportar do zero.
    const camposLinha = [];
    let erroLinha = null;

    for (const coluna of colunasAtivas) {
      const bruto = linha[coluna.slug];
      const vazio = bruto === undefined || bruto === null || String(bruto).trim() === '';
      const stat = statsColunas.get(coluna.slug);

      if (vazio) {
        if (stat) stat.vazias++;
        if (coluna.obrigatoria) {
          erroLinha = `Campo obrigatório "${coluna.label}" vazio`;
          camposLinha.push({ coluna_id: coluna.id, slug: coluna.slug, label: coluna.label, bruto: '', mensagem: erroLinha });
          break;
        }
        // Dado histórico: célula de contrato em branco não é "ainda não
        // respondido" (isso é Pendente, pra item lançado ao vivo) — é "nunca
        // foi capturado nesta planilha". Grava explícito em vez de NULL, pra
        // não se confundir com pendência real numa auditoria futura. Não
        // reaproveita a sentinela 1900-01-01 do "Não" deliberado (grupo C
        // data) — aquela tem outro significado (contrato confirmado
        // inexistente); aqui simplesmente não sabemos, então a data fica NULL
        // mesmo (o marcador "Não informado" já vive em possui_contrato).
        valoresFinal[coluna.id] = SLUGS_CONTRATO_SENTINELA.has(coluna.slug) && coluna.tipo_input !== 'data'
          ? 'Não informado' : null;
        continue;
      }
      if (stat) stat.preenchidas++;

      if (coluna.tipo_input === 'data') {
        const r = parseDataSerial(bruto);
        valoresFinal[coluna.id] = r.valor;
        if (r.alerta) { alertasLinha.push(`${coluna.label}: ${r.alerta}`); camposLinha.push({ coluna_id: coluna.id, slug: coluna.slug, label: coluna.label, bruto: String(bruto), mensagem: r.alerta }); }
      } else if (coluna.tipo_input === 'moeda') {
        const r = parseMoedaServidor(bruto);
        valoresFinal[coluna.id] = String(r.valor);
        if (r.alerta) { alertasLinha.push(`${coluna.label}: ${r.alerta}`); camposLinha.push({ coluna_id: coluna.id, slug: coluna.slug, label: coluna.label, bruto: String(bruto), mensagem: r.alerta }); }
      } else if (coluna.slug === 'fonte_pagadora') {
        const r = parseFontePagadora(bruto);
        valoresFinal[coluna.id] = r.valor;
        if (r.alerta) { alertasLinha.push(`${coluna.label}: ${r.alerta}`); registrarNaoReconhecido(stat, bruto); camposLinha.push({ coluna_id: coluna.id, slug: coluna.slug, label: coluna.label, bruto: String(bruto), mensagem: r.alerta }); }
      } else if (coluna.tipo_input === 'select' && coluna.lista) {
        const r = matchParametroLista(coluna.lista, bruto, dryRun);
        valoresFinal[coluna.id] = r.valor;
        if (r.alerta) { alertasLinha.push(`${coluna.label}: ${r.alerta}`); registrarNaoReconhecido(stat, bruto, r.tipo); camposLinha.push({ coluna_id: coluna.id, slug: coluna.slug, label: coluna.label, bruto: String(bruto), mensagem: r.alerta }); }
      } else {
        valoresFinal[coluna.id] = String(bruto).trim();
      }
    }

    if (erroLinha) {
      comErro++;
      log.push({ tipo: 'erro', linha: numeroLinha, mensagem: erroLinha, campos: camposLinha });
      return;
    }

    numeroAtual++;
    const numeroPac = String(numeroAtual);
    numeroPacInicial ??= numeroPac;
    numeroPacFinal = numeroPac;

    if (!dryRun) {
      const idPac = crypto.randomUUID();
      const codigoPac = gerarCodigoPac(setor, numeroAtual);
      const itemId = insertItem.run(dfdId, setor_id, numeroAtual, req.user.user_id, numeroPac, idPac, codigoPac).lastInsertRowid;
      sqlPartes.push(`INSERT OR IGNORE INTO dfd_itens (id, dfd_id, setor_id, numero_item, criado_por, numero_pac, id_pac, codigo_pac) VALUES (${itemId}, ${dfdId}, ${setor_id}, ${numeroAtual}, ${req.user.user_id}, ${sqlLit(numeroPac)}, ${sqlLit(idPac)}, ${sqlLit(codigoPac)});`);

      Object.entries(valoresFinal).forEach(([colunaId, valor]) => {
        insertValor.run(itemId, Number(colunaId), valor);
        sqlPartes.push(`INSERT OR IGNORE INTO dfd_itens_valores (item_id, coluna_id, valor) VALUES (${itemId}, ${colunaId}, ${sqlLit(valor)});`);
      });
    }

    importados++;
    const acao = dryRun ? 'ficaria' : 'foi';
    if (alertasLinha.length) {
      comAlertas++;
      log.push({ tipo: 'alerta', linha: numeroLinha, mensagem: alertasLinha.join('; '), campos: camposLinha });
    } else {
      log.push({ tipo: 'sucesso', linha: numeroLinha, mensagem: `Item #${numeroAtual} ${acao} importado` });
    }
  });

  // Sem gravação, o .sql (que referencia id real via lastInsertRowid) não faz
  // sentido — o botão de baixar/aplicar só aparece depois do "Importar de
  // verdade".
  const sqlGerado = dryRun ? null : cabecalhoSql({
    fase: '1 - Lançamentos DFD',
    dfdInfo: `${dfd.titulo} (${dfd.ano_base})`,
    setorInfo: setor.nome,
    total: importados,
  }) + sqlPartes.join('\n') + '\n\nCOMMIT;\n';

  if (!dryRun) {
    registrarLog(req, 'PAC', 'IMPORTACAO_CONCLUIU',
      `Concluiu importação de lançamentos (Fase 1) — DFD #${dfdId}: ${importados} importados, ${comAlertas} com alerta, ${comErro} com erro`);
  }

  res.json({
    dfd_id: dfdId, dry_run: dryRun, importados, alertas: comAlertas, erros: comErro, log, sql_gerado: sqlGerado, mapeamento,
    numero_pac_inicial: numeroPacInicial, numero_pac_final: numeroPacFinal,
    resumo_colunas: montarResumoColunas(statsColunas, linhas.length, dryRun),
  });
});

// ── Fase 2: Acompanhamento (independente da Fase 1) ───────────────────────────
router.post('/api/pac/importacao/acompanhamento', pac, requireAdminGlobal, (req, res) => {
  const { dfd_id, mapeamento, linhas } = req.body || {};
  if (!dfd_id) return res.status(400).json({ error: 'DFD é obrigatório' });
  if (!Array.isArray(linhas) || !linhas.length) return res.status(400).json({ error: 'Nenhuma linha pra importar' });

  const dfdId = Number(dfd_id);
  const dfd = db.prepare(`SELECT id, ano_base, titulo FROM dfds WHERE id = ?`).get(dfdId);
  if (!dfd) return res.status(404).json({ error: 'DFD não encontrado' });

  const insertSolicitacao = db.prepare(`
    INSERT INTO pac_solicitacoes
      (dfd_id, item_id, numero_sei, numero_movimento, data_requisicao, valor_tu_mlp, valor_rdc, criado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStatus = db.prepare(`UPDATE dfd_itens SET status_execucao = ? WHERE id = ?`);

  const sqlPartes = [];
  let atualizados = 0, solicitacoesCriadas = 0, comErro = 0;
  const log = [];

  registrarLog(req, 'PAC', 'IMPORTACAO_INICIOU',
    `Iniciou importação de acompanhamento (Fase 2) — DFD "${dfd.titulo}" (${dfd.ano_base}), ${linhas.length} linha(s)`);

  linhas.forEach((linha, idx) => {
    const numeroLinha = idx + 1;
    const numeroPacBruto = linha.numero_pac !== undefined && linha.numero_pac !== null ? String(linha.numero_pac).trim() : '';
    const semVinculo = !numeroPacBruto || normalizarTexto(numeroPacBruto) === 'nao tem';

    let itemId = null;
    if (!semVinculo) {
      const item = db.prepare(`SELECT id FROM dfd_itens WHERE dfd_id = ? AND numero_pac = ? AND excluido_em IS NULL`).get(dfdId, numeroPacBruto);
      if (!item) {
        comErro++;
        log.push({ tipo: 'erro', linha: numeroLinha, mensagem: `numero_pac "${numeroPacBruto}" não encontrado neste DFD` });
        return;
      }
      itemId = item.id;
    }

    const statusExecucao = linha.status_execucao ? String(linha.status_execucao).trim() : null;
    const dataR = linha.data_solicitacao ? parseDataSerial(linha.data_solicitacao).valor : null;
    const valorTuMlp = linha.valor_tu_mlp !== undefined && linha.valor_tu_mlp !== '' ? parseMoedaServidor(linha.valor_tu_mlp).valor : 0;
    const valorRdc = linha.valor_rdc !== undefined && linha.valor_rdc !== '' ? parseMoedaServidor(linha.valor_rdc).valor : 0;
    const numeroSei = linha.numero_sei ? String(linha.numero_sei).trim() : null;
    // "numero_totvs" (nome do mapeamento pro Alex, mais claro que "movimento")
    // grava no numero_movimento que já existia — reaproveitado, não duplicado
    // (era literalmente rotulado "Nº Movimento (TOTVS)" na tela de Solicitações).
    const numeroTotvs = linha.numero_totvs ? String(linha.numero_totvs).trim() : null;

    if (itemId && statusExecucao) {
      updateStatus.run(statusExecucao, itemId);
      sqlPartes.push(`UPDATE dfd_itens SET status_execucao = ${sqlLit(statusExecucao)} WHERE id = ${itemId};`);
      atualizados++;
    }

    const solId = insertSolicitacao.run(dfdId, itemId, numeroSei, numeroTotvs, dataR, valorTuMlp, valorRdc, req.user.user_id).lastInsertRowid;
    sqlPartes.push(
      `INSERT INTO pac_solicitacoes (id, dfd_id, item_id, numero_sei, numero_movimento, data_requisicao, valor_tu_mlp, valor_rdc, criado_por) VALUES ` +
      `(${solId}, ${dfdId}, ${itemId === null ? 'NULL' : itemId}, ${sqlLit(numeroSei)}, ${sqlLit(numeroTotvs)}, ${sqlLit(dataR)}, ${valorTuMlp}, ${valorRdc}, ${req.user.user_id});`
    );
    solicitacoesCriadas++;
    log.push({
      tipo: 'sucesso', linha: numeroLinha,
      mensagem: semVinculo ? 'Solicitação sem vínculo (contratação não planejada)' : `Vinculada ao item nº PAC ${numeroPacBruto}`,
    });
  });

  const sqlGerado = cabecalhoSql({
    fase: '2 - Acompanhamento',
    dfdInfo: `${dfd.titulo} (${dfd.ano_base})`,
    setorInfo: 'Todos',
    total: solicitacoesCriadas,
  }) + sqlPartes.join('\n') + '\n\nCOMMIT;\n';

  registrarLog(req, 'PAC', 'IMPORTACAO_CONCLUIU',
    `Concluiu importação de acompanhamento (Fase 2) — DFD #${dfdId}: ${atualizados} status atualizados, ${solicitacoesCriadas} solicitações criadas, ${comErro} com erro`);

  res.json({ atualizados, solicitacoes_criadas: solicitacoesCriadas, erros: comErro, log, sql_gerado: sqlGerado, mapeamento });
});

// ── Apagar tudo do PAC (só pra acelerar o ciclo de teste) ──────────────────────
// Zera TODOS os DFDs e tudo que depende deles (dfd_itens, valores, pedidos de
// edição, solicitações, consolidações) — via `DELETE FROM dfds` + cascade
// (PRAGMA foreign_keys=ON já ligado em database.js). NÃO mexe em `setores`
// nem em `dfd_colunas_catalogo`/`dfd_parametros_lista`: aquilo é configuração
// do módulo, não dado de teste — apagar isso quebraria o PAC inteiro (um DFD
// novo nasce copiando o catálogo).
router.get('/api/pac/importacao/resumo-apagar-tudo', pac, requireAdminGlobal, (_req, res) => {
  res.json({
    dfds: db.prepare(`SELECT COUNT(*) AS n FROM dfds`).get().n,
    itens: db.prepare(`SELECT COUNT(*) AS n FROM dfd_itens`).get().n,
    solicitacoes: db.prepare(`SELECT COUNT(*) AS n FROM pac_solicitacoes`).get().n,
  });
});

router.post('/api/pac/importacao/apagar-tudo', pac, requireMasterSomente, (req, res) => {
  const totalDfds = db.prepare(`SELECT COUNT(*) AS n FROM dfds`).get().n;
  db.prepare(`DELETE FROM dfds`).run();
  try {
    db.prepare(`
      DELETE FROM sqlite_sequence WHERE name IN
      ('dfds','dfd_itens','dfd_itens_valores','dfd_setores','dfd_colunas_ativas','dfd_pedidos_edicao','pac_consolidacoes','pac_solicitacoes')
    `).run();
  } catch { /* sqlite_sequence só existe se alguma AUTOINCREMENT já rodou — inofensivo se faltar */ }
  registrarLog(req, 'PAC', 'APAGOU_TUDO_PAC', `Apagou TODOS os DFDs e dados ligados via Importação (${totalDfds} DFD(s)) — reset de teste`);
  res.json({ ok: true, dfds_apagados: totalDfds });
});

// ── Console SQL ────────────────────────────────────────────────────────────────
const BANCOS = { secop: db, depop: depopDb, anexos: anexosDb };
const DML_BLOQUEADO_DEPOP = /^\s*(insert|update|delete|drop|alter|create)\b/i;

// Árvore de estrutura do banco (tabelas/views/índices/triggers + colunas) —
// pra alimentar o painel lateral do Console SQL. `sqlite_master` e
// `PRAGMA table_info` já são suficientes, sem precisar de nenhuma lib nova.
// Nome de tabela/view aqui vem sempre do próprio sqlite_master (nunca de
// entrada do usuário), então interpolar no PRAGMA com aspas duplicadas é
// seguro — não dá pra usar parâmetro (`?`) dentro de um PRAGMA.
router.get('/api/pac/importacao/console-sql/schema', pac, requireAdminGlobal, (req, res) => {
  const banco = req.query.banco;
  if (!BANCOS[banco]) return res.status(400).json({ error: 'Banco inválido' });
  const conexao = BANCOS[banco];

  const objetos = conexao.prepare(`
    SELECT type, name, tbl_name FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 ELSE 4 END, name COLLATE NOCASE
  `).all();

  const colunas = {};
  objetos.filter(o => o.type === 'table' || o.type === 'view').forEach(o => {
    try {
      const ident = '"' + o.name.replace(/"/g, '""') + '"';
      colunas[o.name] = conexao.prepare(`PRAGMA table_info(${ident})`).all()
        .map(c => ({ nome: c.name, tipo: c.type, pk: !!c.pk, notnull: !!c.notnull }));
    } catch { colunas[o.name] = []; }
  });

  res.json({ objetos, colunas });
});

router.post('/api/pac/importacao/console-sql', pac, requireAdminGlobal, (req, res) => {
  const { banco, sql } = req.body || {};
  if (!BANCOS[banco]) return res.status(400).json({ error: 'Banco inválido' });
  if (!sql || !String(sql).trim()) return res.status(400).json({ error: 'Informe o SQL' });

  const conexao = BANCOS[banco];
  // Split simples por ";" — não é um parser SQL completo, então um ";" dentro
  // de uma string literal quebraria isso. Aceitável pro uso pretendido
  // (console de admin digitando query, não SQL gerado por terceiros).
  const statements = String(sql).split(';').map(s => s.trim()).filter(Boolean);
  if (!statements.length) return res.status(400).json({ error: 'Nenhum statement encontrado' });

  const resultados = [];
  let totalAfetadas = 0;
  for (const stmt of statements) {
    if (banco === 'depop' && DML_BLOQUEADO_DEPOP.test(stmt)) {
      resultados.push({ erro: 'depop.db é somente leitura por convenção — INSERT/UPDATE/DELETE/DROP/CREATE/ALTER bloqueados nesta rota.' });
      continue;
    }
    try {
      const isSelect = /^\s*(select|pragma)\b/i.test(stmt);
      if (isSelect) {
        const linhas = conexao.prepare(stmt).all();
        const colunas = linhas.length ? Object.keys(linhas[0]) : [];
        resultados.push({ colunas, linhas: linhas.map(l => colunas.map(c => l[c])) });
      } else {
        const info = conexao.prepare(stmt).run();
        totalAfetadas += info.changes || 0;
        resultados.push({ ok: true, changes: info.changes || 0 });
      }
    } catch (e) {
      resultados.push({ erro: e.message });
    }
  }

  registrarLog(req, 'PAC', 'CONSOLE_SQL',
    `Executou SQL no banco "${banco}" (${statements.length} statement(s)): ${sql.slice(0, 200)}`);

  res.json({ resultados, changes: totalAfetadas });
});

// ── Baixar o .sql gerado por uma importação já concluída ──────────────────────
// O front manda de volta o texto que a própria importação devolveu (não fica
// guardado no servidor) — essa rota só formata a resposta como download.
router.post('/api/pac/importacao/baixar-sql', pac, requireAdminGlobal, (req, res) => {
  const { sql_gerado, nome_arquivo } = req.body || {};
  if (!sql_gerado) return res.status(400).json({ error: 'Nada pra baixar' });
  registrarLog(req, 'PAC', 'BAIXOU_SQL', `Baixou o arquivo .sql gerado (${nome_arquivo || 'importacao.sql'})`);
  res.set('Content-Type', 'application/sql; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${nome_arquivo || 'importacao.sql'}"`);
  res.send(sql_gerado);
});

module.exports = router;
