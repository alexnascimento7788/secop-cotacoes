// ── DEPLA (PAC): sub-módulo "Dados Concessionários" ─────────────────────────
// Pedido do Alex, 2026-11-04: planilha do CORPORE (Depla_2.xlsx — uma linha
// por ZTERMO com fan-out por área, ~250 colunas de tarifa média por tipo)
// casada com depop.db (TarifaContrato20Anos/AvaliacaoAreaRenovacao) pra
// formar o relatório principal: dados da planilha + área/valor-m²/tarifa de
// uso/valor do ponto/outorga calculados do depop.
//
// O PROBLEMA DE CASAMENTO (análise feita sobre a planilha real, 2026-11-04):
// a planilha não tem id_contrato nem numero_ccu — só Codigo_Cfo (=`codigo`),
// Contrato(numero)/Cod_Termo (1:1 entre si) e Contrato(Data de inicio). Já o
// depop.db identifica contrato por `id_contrato`. Pra maioria das empresas
// (codigo) existe só 1 id_contrato em TarifaContrato20Anos — casamento direto.
// Quando há mais de um (empresa com +1 CCU no programa de 20 anos) ou mais de
// um termo na planilha pra mesma empresa, a DATA de início do termo bate
// exatamente com AvaliacaoAreaRenovacao.data_vencimento... na verdade com
// TarifaContrato20Anos.data_assinatura na quase totalidade dos casos (339
// triviais + 50 resolvidos por data, de 417 empresas com algum contrato no
// depop) — ver amostra de validação no histórico da conversa. Os poucos
// restantes (empates de data) ficam com match_confianca='manual' pro Alex
// revisar; sem contrato nenhum no depop = 'sem_match' (empresa fora do
// programa de 20 anos — os campos adicionais ficam em branco no relatório).
const express = require('express');
const { db, depopDb } = require('../database');
const { registrarLog, requireModulo } = require('../middleware');

const router = express.Router();
const pac = requireModulo('pac');

// Colunas fixas da planilha (o resto das colunas, 1 por tipo de tarifa, é
// pivot dinâmico — ver seedRotinas/depla_concessionarios_tarifa).
const COLS_BASE = [
  'Cod_Empresa', 'Codigo_Cfo', 'Empresa', 'CNPJ', 'Contrato(numero)',
  'Contrato(Data de inicio)', 'Cod_Termo', 'Cod_Contrato_Juridico', 'Metragem(Area)',
  // Duplicadas pela própria query do CORPORE (CFO.CODCOLIGADA/CODCFO de novo,
  // via TS.* no SELECT final) — não são tarifa, viram ruído no pivot se não
  // forem excluídas aqui também.
  'CODCOLIGADA', 'CODCFO',
];

function requireAdminGlobal(req, res, next) {
  if (req.user.username === 'master' || req.user.role === 'admin_sistema') return next();
  return res.status(403).json({ error: 'Acesso restrito ao administrador do sistema.' });
}

function requireVer(req, res, next) {
  if (req.user.username === 'master') return next();
  if (!req.user.perfil_id) return res.status(403).json({ error: 'Você não tem essa permissão.' });
  const row = db.prepare(`
    SELECT pr.ver AS permitido
    FROM perfil_rotinas pr JOIN rotinas r ON r.id = pr.rotina_id
    WHERE pr.perfil_id = ? AND r.slug = 'pac-concessionarios'
  `).get(req.user.perfil_id);
  if (!row || !row.permitido) return res.status(403).json({ error: 'Você não tem essa permissão.' });
  next();
}

function soData(s) {
  return String(s || '').trim().slice(0, 10);
}

// Mesma regra de prazo final de adesão do SECAD (routes/secad.js,
// prazoFinalAdesao), pelo ano de vencimento do contrato de 20 anos. Duplicada
// aqui (função pura de 3 linhas) pra não acoplar este módulo ao secad.js.
function prazoFinalAdesao(ano) {
  if (ano === 2027) return '30/10/2026';
  if (ano >= 2028 && ano <= 2032) return '18/12/2026';
  return null;
}

// Agrupa as linhas cruas da planilha por Cod_Termo (dedup do fan-out por
// área) e extrai o pivot de tarifas em formato longo [{descricao, valor}].
function agruparPorTermo(linhas) {
  const porTermo = new Map();
  linhas.forEach(linha => {
    const codTermo = String(linha['Cod_Termo'] || '').trim();
    if (!codTermo) return;
    const metragem = parseFloat(linha['Metragem(Area)']) || 0;
    if (!porTermo.has(codTermo)) {
      const tarifas = [];
      Object.keys(linha).forEach(col => {
        if (COLS_BASE.includes(col)) return;
        const valor = parseFloat(linha[col]);
        if (!isNaN(valor) && valor !== 0 && linha[col] !== '') tarifas.push({ descricao: col, valor });
      });
      porTermo.set(codTermo, {
        cod_empresa: parseInt(linha['Cod_Empresa'], 10) || null,
        codigo: parseInt(linha['Codigo_Cfo'], 10) || null,
        empresa: String(linha['Empresa'] || '').trim() || null,
        cnpj: String(linha['CNPJ'] || '').trim() || null,
        contrato_numero: String(linha['Contrato(numero)'] || '').trim() || null,
        contrato_data_inicio: String(linha['Contrato(Data de inicio)'] || '').trim() || null,
        cod_termo: codTermo,
        cod_contrato_juridico: String(linha['Cod_Contrato_Juridico'] || '').trim() || null,
        metragem_planilha: metragem,
        tarifas,
      });
    } else {
      porTermo.get(codTermo).metragem_planilha += metragem;
    }
  });
  return [...porTermo.values()];
}

// Casa cada termo da planilha com um id_contrato de TarifaContrato20Anos,
// agrupando por `codigo` (empresa) e desambiguando por data quando precisa.
function casarComDepop(termos) {
  const porCodigoDepop = new Map();
  depopDb.prepare(`SELECT DISTINCT codigo, id_contrato, data_assinatura FROM TarifaContrato20Anos`).all()
    .forEach(r => {
      if (!porCodigoDepop.has(r.codigo)) porCodigoDepop.set(r.codigo, []);
      const lista = porCodigoDepop.get(r.codigo);
      if (!lista.some(x => x.id_contrato === r.id_contrato)) lista.push(r);
    });

  const porCodigoTermos = new Map();
  termos.forEach(t => {
    if (!porCodigoTermos.has(t.codigo)) porCodigoTermos.set(t.codigo, []);
    porCodigoTermos.get(t.codigo).push(t);
  });

  porCodigoTermos.forEach((termosDaEmpresa, codigo) => {
    const candidatos = porCodigoDepop.get(codigo) || [];
    if (!candidatos.length) {
      termosDaEmpresa.forEach(t => { t.id_contrato_depop = null; t.match_confianca = 'sem_match'; });
      return;
    }
    if (candidatos.length === 1 && termosDaEmpresa.length === 1) {
      termosDaEmpresa[0].id_contrato_depop = candidatos[0].id_contrato;
      termosDaEmpresa[0].match_confianca = 'direto';
      return;
    }
    // Desambiguação por data (contrato_data_inicio == data_assinatura),
    // pareamento guloso: cada candidato só é usado 1 vez.
    const candidatosLivres = [...candidatos];
    termosDaEmpresa.forEach(t => {
      const dataTermo = soData(t.contrato_data_inicio);
      const idx = candidatosLivres.findIndex(c => soData(c.data_assinatura) === dataTermo);
      if (idx >= 0) {
        t.id_contrato_depop = candidatosLivres[idx].id_contrato;
        t.match_confianca = (candidatos.length === 1 && termosDaEmpresa.length === 1) ? 'direto' : 'data';
        candidatosLivres.splice(idx, 1);
      } else {
        t.id_contrato_depop = null;
        t.match_confianca = 'sem_match';
      }
    });
    // Sobrou candidato(s) e termo(s) sem data batida, nos dois lados — pareia
    // na ordem em que aparecem e marca pra revisão manual (empate de data,
    // ou nenhuma data bateu) em vez de deixar sem dado algum.
    const termosSemMatch = termosDaEmpresa.filter(t => t.match_confianca === 'sem_match');
    const n = Math.min(termosSemMatch.length, candidatosLivres.length);
    for (let i = 0; i < n; i++) {
      termosSemMatch[i].id_contrato_depop = candidatosLivres[i].id_contrato;
      termosSemMatch[i].match_confianca = 'manual';
    }
  });

  return termos;
}

// ── Importação (admin-only) ──────────────────────────────────────────────────

router.post('/api/pac/concessionarios/importar', pac, requireAdminGlobal, (req, res) => {
  const { dry_run, nome_arquivo, linhas } = req.body || {};
  if (!Array.isArray(linhas) || !linhas.length) return res.status(400).json({ error: 'Nenhuma linha recebida.' });

  const semCodigo = [];
  const comCodigo = linhas.filter((l, i) => {
    if (!l['Codigo_Cfo'] || isNaN(parseInt(l['Codigo_Cfo'], 10))) { semCodigo.push(i + 2); return false; }
    return true;
  });

  const termos = casarComDepop(agruparPorTermo(comCodigo));
  const porConfianca = { direto: 0, data: 0, manual: 0, sem_match: 0 };
  termos.forEach(t => porConfianca[t.match_confianca]++);
  const amostraRevisao = termos
    .filter(t => t.match_confianca === 'manual' || t.match_confianca === 'sem_match')
    .slice(0, 30)
    .map(t => ({ codigo: t.codigo, empresa: t.empresa, contrato_numero: t.contrato_numero, confianca: t.match_confianca }));

  if (dry_run) {
    return res.json({
      dry_run: true,
      total_linhas: linhas.length,
      linhas_sem_codigo: semCodigo.length,
      total_termos: termos.length,
      casados_direto: porConfianca.direto,
      casados_por_data: porConfianca.data,
      casados_manual: porConfianca.manual,
      sem_match: porConfianca.sem_match,
      amostra_revisao: amostraRevisao,
    });
  }

  const inserirImportacao = db.prepare(`
    INSERT INTO depla_concessionarios_importacao (nome_arquivo, total_linhas, total_termos, casados, importado_por)
    VALUES (?, ?, ?, ?, ?)
  `);
  const inserirTermo = db.prepare(`
    INSERT INTO depla_concessionarios
      (importacao_id, cod_empresa, codigo, empresa, cnpj, contrato_numero, contrato_data_inicio,
       cod_termo, cod_contrato_juridico, metragem_planilha, id_contrato_depop, match_confianca)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const inserirTarifa = db.prepare(`
    INSERT INTO depla_concessionarios_tarifa (concessionario_id, descricao, valor) VALUES (?, ?, ?)
  `);
  // Cabeçalho (depla_concessionarios_importacao) tem que estar DENTRO da
  // mesma transação dos termos/tarifas — senão um erro no meio do forEach
  // reverte só os detalhes e deixa um registro "fantasma" (0 termos) no
  // cabeçalho (achado real em produção, 2026-11-04, lote TESTE_ROLLBACK).
  let importacaoId;
  db.exec('BEGIN');
  try {
    const info = inserirImportacao.run(
      nome_arquivo || null, linhas.length, termos.length,
      porConfianca.direto + porConfianca.data + porConfianca.manual, req.user.user_id
    );
    importacaoId = info.lastInsertRowid;
    termos.forEach(t => {
      const r = inserirTermo.run(
        importacaoId, t.cod_empresa, t.codigo, t.empresa, t.cnpj, t.contrato_numero, t.contrato_data_inicio,
        t.cod_termo, t.cod_contrato_juridico, t.metragem_planilha, t.id_contrato_depop, t.match_confianca
      );
      const concessionarioId = r.lastInsertRowid;
      t.tarifas.forEach(tf => inserirTarifa.run(concessionarioId, tf.descricao, tf.valor));
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  registrarLog(req, 'PAC', 'IMPORTOU_CONCESSIONARIOS',
    `Importou ${termos.length} contrato(s) de concessionários (lote #${importacaoId}, ${porConfianca.sem_match} sem contrato no depop, ${porConfianca.manual} pra revisão manual)`);
  res.json({ dry_run: false, importacao_id: importacaoId, total_termos: termos.length, ...porConfianca });
});

router.get('/api/pac/concessionarios/importacoes', pac, requireVer, (req, res) => {
  const lista = db.prepare(`
    SELECT i.*, u.username AS importado_por_username
    FROM depla_concessionarios_importacao i
    LEFT JOIN users u ON u.id = i.importado_por
    ORDER BY i.id DESC
  `).all();
  res.json(lista);
});

// Carrega os campos derivados do depop.db (área/tarifa/vencimento/avaliação)
// pros id_contrato_depop pedidos — usado pelo resumido E pelo detalhado.
function carregarDadosDepop(idsContrato) {
  const areaPorContrato = new Map();
  const tarifaUsoPorContrato = new Map();
  const vencimentoPorContrato = new Map();
  const avaliacaoPorContrato = new Map();
  if (!idsContrato.length) return { areaPorContrato, tarifaUsoPorContrato, vencimentoPorContrato, avaliacaoPorContrato };
  const placeholders = idsContrato.map(() => '?').join(',');
  // TarifaContrato20Anos "quebra" (fan-out) a área de um mesmo contrato em
  // várias linhas quando ele tem mais de uma área/sequencial — nesse caso a
  // metragem soma, mas a tarifa (atual_tarifa_uso) e o vencimento são o MESMO
  // valor repetido em cada linha (confirmado: 0 divergência em 249 contratos
  // com fan-out), então agrupar com MAX (nunca SUM) dá o valor único correto.
  // "Tarifa de Uso" = atual_tarifa_uso (confirmado pelo Alex, 2026-11-04).
  // NÃO existe coluna real de "valor por m²" no depop — fica null por
  // enquanto (Alex confirmou, 2026-11-04: "percebi que não temos").
  depopDb.prepare(`
    SELECT id_contrato, SUM(area_m2) AS area_total,
           MAX(atual_tarifa_uso) AS tarifa_media, MAX(data_vencimento) AS vencimento
    FROM TarifaContrato20Anos WHERE id_contrato IN (${placeholders}) GROUP BY id_contrato
  `).all(...idsContrato).forEach(r => {
    areaPorContrato.set(r.id_contrato, r.area_total);
    tarifaUsoPorContrato.set(r.id_contrato, r.tarifa_media);
    vencimentoPorContrato.set(r.id_contrato, r.vencimento);
  });
  depopDb.prepare(`
    SELECT id_contrato, valor_ponto, valor_30_ceasa
    FROM AvaliacaoAreaRenovacao WHERE id_contrato IN (${placeholders})
  `).all(...idsContrato).forEach(r => avaliacaoPorContrato.set(r.id_contrato, r));
  return { areaPorContrato, tarifaUsoPorContrato, vencimentoPorContrato, avaliacaoPorContrato };
}

// Monta os campos calculados (área/valor-m²/tarifa/ponto/outorga/vencimento)
// de UM concessionário a partir dos mapas de carregarDadosDepop().
function camposDepop(c, dados) {
  const area = dados.areaPorContrato.get(c.id_contrato_depop) || null;
  const aval = dados.avaliacaoPorContrato.get(c.id_contrato_depop) || null;
  const valorPonto = aval ? aval.valor_ponto / 1000 : null;
  const outorga = aval ? aval.valor_30_ceasa / 1000 : null;
  const vencimento = dados.vencimentoPorContrato.get(c.id_contrato_depop) || null;
  const anoVencimento = vencimento ? parseInt(vencimento.slice(0, 4), 10) : null;
  return {
    contrato_vencido_em: vencimento,
    prazo_final_adesao: anoVencimento ? prazoFinalAdesao(anoVencimento) : null,
    area_m2: area,
    valor_m2: null, // sem coluna real no depop pra isso ainda (Alex, 2026-11-04)
    tarifa_uso: dados.tarifaUsoPorContrato.get(c.id_contrato_depop) || null,
    valor_ponto: valorPonto,
    outorga,
  };
}

// Busca os contratos de uma importação — por padrão só os CASADOS com o
// depop (direto/data/manual), já que o módulo é focado em quem está no
// programa de renovação de 20 anos. incluirDemais=true também traz os
// 'sem_match' (concessionários fora do programa — ver flag "Demais" na tela).
function buscarContratos(importacaoId, incluirDemais) {
  const filtro = incluirDemais ? '' : `AND match_confianca != 'sem_match'`;
  return db.prepare(`
    SELECT * FROM depla_concessionarios WHERE importacao_id = ? ${filtro} ORDER BY empresa, contrato_numero
  `).all(importacaoId);
}

// ── Relatório resumido ───────────────────────────────────────────────────────
// Uma linha por contrato (termo) CASADO com o depop, com área/tarifa de
// uso/valor do ponto/outorga/vencimento calculados do depop.db. Concessionário
// sem contrato de renovação ("Demais") fica de fora por padrão — só aparece
// com ?incluir_demais=1.
router.get('/api/pac/concessionarios/resumido', pac, requireVer, (req, res) => {
  const importacaoId = req.query.importacao_id
    ? Number(req.query.importacao_id)
    : db.prepare(`SELECT MAX(id) AS id FROM depla_concessionarios_importacao`).get()?.id;
  if (!importacaoId) return res.json({ importacao_id: null, linhas: [], total_demais: 0 });

  const incluirDemais = req.query.incluir_demais === '1';
  const contratos = buscarContratos(importacaoId, incluirDemais);
  const totalDemais = db.prepare(`
    SELECT COUNT(*) n FROM depla_concessionarios WHERE importacao_id = ? AND match_confianca = 'sem_match'
  `).get(importacaoId).n;

  const idsContrato = [...new Set(contratos.map(c => c.id_contrato_depop).filter(Boolean))];
  const dadosDepop = carregarDadosDepop(idsContrato);

  const linhas = contratos.map(c => ({
    codigo: c.codigo,
    empresa: c.empresa,
    cnpj: c.cnpj,
    contrato_numero: c.contrato_numero,
    contrato_data_inicio: c.contrato_data_inicio,
    ...camposDepop(c, dadosDepop),
    match_confianca: c.match_confianca,
  }));

  res.json({ importacao_id: importacaoId, linhas, total_demais: totalDemais });
});

// ── Relatório detalhado (secundário) ─────────────────────────────────────────
// Em árvore: por concessionário, os mesmos dados do resumido + TODOS os itens
// de tarifa não-nulos da planilha (descrição/valor, formato longo). Mesmo
// filtro de "Demais" do resumido.
router.get('/api/pac/concessionarios/detalhado', pac, requireVer, (req, res) => {
  const importacaoId = req.query.importacao_id
    ? Number(req.query.importacao_id)
    : db.prepare(`SELECT MAX(id) AS id FROM depla_concessionarios_importacao`).get()?.id;
  if (!importacaoId) return res.json({ importacao_id: null, linhas: [], total_demais: 0 });

  const incluirDemais = req.query.incluir_demais === '1';
  const contratos = buscarContratos(importacaoId, incluirDemais);
  const totalDemais = db.prepare(`
    SELECT COUNT(*) n FROM depla_concessionarios WHERE importacao_id = ? AND match_confianca = 'sem_match'
  `).get(importacaoId).n;

  const idsContrato = [...new Set(contratos.map(c => c.id_contrato_depop).filter(Boolean))];
  const dadosDepop = carregarDadosDepop(idsContrato);

  const idsConcessionario = contratos.map(c => c.id);
  const tarifasPorConcessionario = new Map();
  if (idsConcessionario.length) {
    const placeholders = idsConcessionario.map(() => '?').join(',');
    db.prepare(`
      SELECT concessionario_id, descricao, valor FROM depla_concessionarios_tarifa
      WHERE concessionario_id IN (${placeholders}) ORDER BY descricao
    `).all(...idsConcessionario).forEach(r => {
      if (!tarifasPorConcessionario.has(r.concessionario_id)) tarifasPorConcessionario.set(r.concessionario_id, []);
      tarifasPorConcessionario.get(r.concessionario_id).push({ descricao: r.descricao, valor: r.valor });
    });
  }

  const linhas = contratos.map(c => {
    const depop = camposDepop(c, dadosDepop);
    return {
      codigo: c.codigo,
      empresa: c.empresa,
      cnpj: c.cnpj,
      contrato_numero: c.contrato_numero,
      contrato_data_inicio: c.contrato_data_inicio,
      ...depop,
      match_confianca: c.match_confianca,
      itens_planilha: tarifasPorConcessionario.get(c.id) || [],
    };
  });

  res.json({ importacao_id: importacaoId, linhas, total_demais: totalDemais });
});

module.exports = router;
