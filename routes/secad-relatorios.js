// ── SECAD/Relatórios: adesão à renovação (importação de planilha + indicadores) ──
// Pedido do Alex, 2026-10-22/23: planilha gerada por ele via query no CORPORE
// (Codigo/CpfCnpj/NumContrato/DataAceite) casada por (codigo, numero_ccu) com
// depop.db/AvaliacaoAreaRenovacao, pra acompanhar quem já "aceitou" a renovação
// dentro do prazo do edital/TCC (prazoFinalAdesao, já existe em routes/secad.js)
// — por prazo × cidade. Arquivo separado de routes/secad.js: a importação é
// gateada por ROLE (igual routes/pac-importacao.js), não por Rotina/Perfil do
// módulo — é ferramenta de admin, orthogonal ao resto do SECAD. Já o relatório
// em si é gateado pela rotina nova 'relatorios-renovacao' (uso executivo, não
// reaproveita secad_cidade_usuarios — confirmado com o Alex, 2026-10-23).
const express = require('express');
const { db, depopDb } = require('../database');
const { registrarLog, requireModulo } = require('../middleware');
const { gerarPdfAdesaoRenovacao } = require('../secad-relatorios-pdf');

const router = express.Router();
const secad = requireModulo('secad');

function requireAdminGlobal(req, res, next) {
  if (req.user.username === 'master' || req.user.role === 'admin_sistema') return next();
  return res.status(403).json({ error: 'Acesso restrito ao administrador do sistema.' });
}

// NÃO usa o requireRotina() genérico de middleware.js — aquele dá bypass
// automático pra role 'consulta' (comportamento certo pras outras rotinas do
// módulo, onde consulta é "lê tudo"), mas o Alex foi explícito, 2026-10-23:
// "a parte de relatório é executiva, e não será liberada para todos" — nem
// pra quem só tem o role consulta. Só master ou quem tiver a rotina
// 'relatorios-renovacao' com "ver" explicitamente no Perfil entra.
function requireRelatoriosVer(req, res, next) {
  if (req.user.username === 'master') return next();
  if (!req.user.perfil_id) return res.status(403).json({ error: 'Você não tem essa permissão.' });
  const row = db.prepare(`
    SELECT pr.ver AS permitido
    FROM perfil_rotinas pr JOIN rotinas r ON r.id = pr.rotina_id
    WHERE pr.perfil_id = ? AND r.slug = 'relatorios-renovacao'
  `).get(req.user.perfil_id);
  if (!row || !row.permitido) return res.status(403).json({ error: 'Você não tem essa permissão.' });
  next();
}

// Mesmo filtro de routes/secad.js (duplicado de propósito, sem módulo
// compartilhado novo — convenção já estabelecida neste projeto).
function codigosRemovidos() {
  return new Set(db.prepare(`SELECT codigo FROM concessionario_removido`).all().map(r => r.codigo));
}

// Mesma regra de routes/secad.js (prazoFinalAdesao) — duplicada de propósito.
function prazoFinalAdesao(ano) {
  if (ano === 2027) return '30/10/2026';
  if (ano >= 2028 && ano <= 2032) return '18/12/2026';
  return null;
}

function normalizarCcu(s) {
  return String(s || '').trim();
}

// ── Importação (admin-only) ──────────────────────────────────────────────────

router.post('/api/secad/relatorios/importar-aceites', secad, requireAdminGlobal, (req, res) => {
  const { dry_run, nome_arquivo, linhas } = req.body || {};
  if (!Array.isArray(linhas) || !linhas.length) return res.status(400).json({ error: 'Nenhuma linha recebida.' });

  const contratos = new Set(
    depopDb.prepare(`SELECT codigo, numero_ccu FROM AvaliacaoAreaRenovacao`).all()
      .map(a => `${a.codigo}|${normalizarCcu(a.numero_ccu)}`)
  );

  const validas = [];
  const invalidas = [];
  linhas.forEach((l, i) => {
    const codigo = parseInt(l.codigo, 10);
    const numero_ccu = normalizarCcu(l.numero_ccu);
    if (!codigo || !numero_ccu) { invalidas.push({ linha: i + 2, motivo: 'Código ou Nº do contrato vazio/inválido' }); return; }
    const casou = contratos.has(`${codigo}|${numero_ccu}`);
    validas.push({
      codigo, numero_ccu, casou,
      cnpj: l.cnpj ? String(l.cnpj).trim() : null,
      data_aceite: l.data_aceite ? String(l.data_aceite).trim() : null,
    });
  });
  const naoCasados = validas.filter(v => !v.casou);

  if (dry_run) {
    return res.json({
      dry_run: true,
      total_linhas: linhas.length,
      validas: validas.length,
      invalidas: invalidas.length,
      invalidas_amostra: invalidas.slice(0, 30),
      casados: validas.length - naoCasados.length,
      nao_casados: naoCasados.length,
      nao_casados_amostra: naoCasados.slice(0, 30),
    });
  }

  const info = db.prepare(`
    INSERT INTO renovacao_aceites_importacao (nome_arquivo, total_linhas, nao_casados, importado_por)
    VALUES (?, ?, ?, ?)
  `).run(nome_arquivo || null, validas.length, naoCasados.length, req.user.user_id);
  const importacaoId = info.lastInsertRowid;

  const inserir = db.prepare(`
    INSERT INTO renovacao_aceites (importacao_id, codigo, cnpj, numero_ccu, data_aceite)
    VALUES (?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    validas.forEach(v => inserir.run(importacaoId, v.codigo, v.cnpj, v.numero_ccu, v.data_aceite));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  registrarLog(req, 'SECAD', 'IMPORTOU_ACEITES_RENOVACAO',
    `Importou ${validas.length} linha(s) de aceite à renovação (lote #${importacaoId}, ${naoCasados.length} sem contrato correspondente)`);
  res.json({ dry_run: false, importacao_id: importacaoId, total_linhas: validas.length, nao_casados: naoCasados.length });
});

router.get('/api/secad/relatorios/importacoes', secad, requireRelatoriosVer, (req, res) => {
  const lotes = db.prepare(`
    SELECT i.id, i.nome_arquivo, i.total_linhas, i.nao_casados, i.criado_em, u.nome_completo, u.username
    FROM renovacao_aceites_importacao i LEFT JOIN users u ON u.id = i.importado_por
    ORDER BY i.id DESC
  `).all().map(l => ({ ...l, importado_por_nome: l.nome_completo || l.username || '—' }));
  res.json(lotes);
});

// ── Relatório de adesão ───────────────────────────────────────────────────────

// Monta os dados do relatório pra UM lote de importação (o mais recente, se
// nenhum id for passado) — mesma função usada pela tela (JSON) e pelo PDF.
function montarRelatorioAdesao(importacaoId, filtroPrazo, filtroCidadeId) {
  const importacao = importacaoId
    ? db.prepare(`SELECT id, nome_arquivo, total_linhas, nao_casados, criado_em FROM renovacao_aceites_importacao WHERE id = ?`).get(importacaoId)
    : db.prepare(`SELECT id, nome_arquivo, total_linhas, nao_casados, criado_em FROM renovacao_aceites_importacao ORDER BY id DESC LIMIT 1`).get();
  if (!importacao) return null;

  const aceites = db.prepare(`SELECT codigo, numero_ccu, data_aceite FROM renovacao_aceites WHERE importacao_id = ?`).all(importacao.id);
  const mapaAceite = new Map(aceites.map(a => [`${a.codigo}|${normalizarCcu(a.numero_ccu)}`, a.data_aceite]));

  const removidos = codigosRemovidos();
  const contratos = depopDb.prepare(`
    SELECT a.codigo, a.numero_ccu, a.data_vencimento, a.id_cidade, c.descricao AS cidade, cli.cliente, cli.cpf_cnpj
    FROM AvaliacaoAreaRenovacao a
    LEFT JOIN Cidade c ON c.id = a.id_cidade
    LEFT JOIN ClienteConcessionario cli ON cli.codigo = a.codigo
  `).all().filter(a => !removidos.has(a.codigo));

  // grupo[prazo] -> cidade[nome] -> {total, aceitaram, pendentes[]}
  const porPrazo = new Map();
  const datasAceiteFiltro = []; // alimenta "evolucao" — só dos contratos que passaram no filtro
  contratos.forEach(c => {
    const ano = parseInt(String(c.data_vencimento || '').slice(0, 4), 10);
    const prazo = prazoFinalAdesao(ano);
    if (!prazo) return; // fora do intervalo previsto — não entra no relatório
    if (filtroPrazo && prazo !== filtroPrazo) return;
    if (filtroCidadeId && c.id_cidade !== filtroCidadeId) return;
    const cidadeNome = c.cidade || 'Sem cidade definida';
    const chave = `${c.codigo}|${normalizarCcu(c.numero_ccu)}`;
    const dataAceite = mapaAceite.get(chave);
    const aceitou = !!dataAceite;
    if (aceitou) datasAceiteFiltro.push(dataAceite);

    if (!porPrazo.has(prazo)) porPrazo.set(prazo, new Map());
    const porCidade = porPrazo.get(prazo);
    if (!porCidade.has(cidadeNome)) porCidade.set(cidadeNome, { total: 0, aceitaram: 0, pendentes: [] });
    const g = porCidade.get(cidadeNome);
    g.total++;
    if (aceitou) g.aceitaram++;
    else g.pendentes.push({
      codigo: c.codigo, concessionario: c.cliente || '—', cnpj: c.cpf_cnpj || '—',
      numero_ccu: c.numero_ccu || '—', cidade: cidadeNome,
    });
  });

  // Evolução dos aceites por data (dentro do filtro ativo) — alimenta o
  // gráfico de timeline na tela; o front soma pra montar a curva acumulada
  // (não precisa de rota própria, usa o mesmo total já calculado abaixo).
  const porData = new Map();
  datasAceiteFiltro.forEach(d => {
    const data = String(d).slice(0, 10);
    porData.set(data, (porData.get(data) || 0) + 1);
  });
  const evolucao = [...porData.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([data, quantidade]) => ({ data, quantidade }));

  const ORDEM_PRAZO = ['30/10/2026', '18/12/2026'];
  const grupos = [...porPrazo.entries()]
    .sort(([a], [b]) => ORDEM_PRAZO.indexOf(a) - ORDEM_PRAZO.indexOf(b))
    .map(([prazo, porCidade]) => {
      const cidades = [...porCidade.entries()]
        .map(([cidade, v]) => ({
          cidade, total: v.total, aceitaram: v.aceitaram, pendentes: v.total - v.aceitaram,
          pct: v.total ? (v.aceitaram / v.total) * 100 : 0,
          _pendentesLista: v.pendentes,
        }))
        .sort((a, b) => a.cidade.localeCompare(b.cidade, 'pt-BR'));
      const totalGrupo = cidades.reduce((acc, c) => ({ total: acc.total + c.total, aceitaram: acc.aceitaram + c.aceitaram }), { total: 0, aceitaram: 0 });
      const listaPendentes = cidades.flatMap(c => c._pendentesLista)
        .sort((a, b) => a.cidade.localeCompare(b.cidade, 'pt-BR') || String(a.concessionario).localeCompare(String(b.concessionario), 'pt-BR'));
      return {
        prazo,
        cidades: cidades.map(({ _pendentesLista, ...c }) => c),
        total: { total: totalGrupo.total, aceitaram: totalGrupo.aceitaram, pendentes: totalGrupo.total - totalGrupo.aceitaram,
                 pct: totalGrupo.total ? (totalGrupo.aceitaram / totalGrupo.total) * 100 : 0 },
        lista_pendentes: listaPendentes,
      };
    });

  return { importacao, grupos, evolucao };
}

router.get('/api/secad/relatorios/adesao', secad, requireRelatoriosVer, (req, res) => {
  const importacaoId = req.query.importacao_id ? Number(req.query.importacao_id) : null;
  const dados = montarRelatorioAdesao(importacaoId, req.query.prazo || null, req.query.cidade_id ? Number(req.query.cidade_id) : null);
  if (!dados) return res.status(404).json({ error: 'Nenhuma importação encontrada ainda.' });
  res.json(dados);
});

router.get('/api/secad/relatorios/cidades', secad, requireRelatoriosVer, (req, res) => {
  res.json(depopDb.prepare(`SELECT id, descricao FROM Cidade ORDER BY descricao`).all());
});

router.get('/api/secad/relatorios/adesao/pdf', secad, requireRelatoriosVer, async (req, res) => {
  try {
    const importacaoId = req.query.importacao_id ? Number(req.query.importacao_id) : null;
    const dados = montarRelatorioAdesao(importacaoId, req.query.prazo || null, req.query.cidade_id ? Number(req.query.cidade_id) : null);
    if (!dados) return res.status(404).json({ error: 'Nenhuma importação encontrada ainda.' });
    const nomeGerador = req.user.nome_completo || req.user.username;
    const bytes = await gerarPdfAdesaoRenovacao(dados, nomeGerador);
    registrarLog(req, 'SECAD', 'GEROU_RELATORIO_ADESAO', `Gerou o relatório de adesão à renovação (lote #${dados.importacao.id})`);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="relatorio-adesao-renovacao.pdf"');
    res.send(bytes);
  } catch (e) {
    console.error('[secad-relatorios] erro gerando PDF:', e);
    res.status(500).json({ error: 'Erro ao gerar o PDF: ' + e.message });
  }
});

module.exports = router;
