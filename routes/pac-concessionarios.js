// ── DEPLA: módulo "Relatórios Gerais" — "Dados Concessionários" ─────────────
// Virou módulo próprio (2026-11-05, separado do PAC) pra não misturar o
// fluxo de DFD com relatórios soltos do DEPLA — ver migração de rotina em
// database.js (UPDATE rotinas SET modulo_id ...).
// Pedido do Alex, 2026-11-04: dado do CORPORE casado com depop.db
// (TarifaContrato20Anos/AvaliacaoAreaRenovacao) pra formar o relatório
// principal: dados da planilha + contrato/tarifa de uso/valor do ponto/
// outorga calculados do depop (2026-11-11: só o relatório resumido existe —
// o detalhado, 1 coluna por tipo de tarifa, foi removido a pedido do Alex).
//
// MUDANÇA DE FORMATO (2026-11-11): o export real do CORPORE virou um CSV
// (`Depla_2.csv`) bem mais estreito que a planilha wide-pivot original
// (~250 colunas de tarifa) — achado analisando o arquivo real em `data/`.
// Formato: sem cabeçalho, 17 campos por linha, UTF-8, aspas RFC4180 pra
// campo com vírgula (ex: nome de empresa). 1 linha por "unidade física"
// (pavilhão/box) do contrato — quando o mesmo contrato tem várias unidades,
// repete a linha toda trocando só o último campo (código de localização);
// é o equivalente, nesse formato novo, do fan-out por área que a planilha
// antiga tinha. Campos (0-indexed, nomes dados pelo client em
// public/js/pac-concessionarios.js): Codigo_Cfo, Empresa, CNPJ, Cidade,
// Id_Cidade, Contrato_Numero, Ccu_Licenca, Data_Inicio, Data_Vencimento,
// Tarifa_Uso (só "Tarifa de Uso", sem mais pivot de ~250 tipos — o relatório
// nunca precisou de mais que isso desde que o "detalhado" foi removido),
// + 6 campos de bookkeeping contábil não usados aqui (código repetido, id
// interno, sequencial, descrição da rubrica, conta contábil, ordem) e por
// fim o código de localização (pavilhão/box). Cross-validado com 3+ códigos
// conhecidos do depop.db (14, 40, 87) — numero_ccu/data_assinatura/
// data_vencimento/atual_tarifa_uso batem exatamente.
//
// O PROBLEMA DE CASAMENTO (análise original, 2026-11-04, ainda vale): a
// planilha não tem `id_contrato` (chave do depop.db) — só `codigo`,
// `contrato_numero`/termo e `data de início`. Pra maioria das empresas
// existe só 1 id_contrato em TarifaContrato20Anos — casamento direto. Quando
// há mais de um (empresa com +1 CCU no programa de 20 anos) ou mais de um
// termo na planilha pra mesma empresa, a DATA de início do termo bate com
// TarifaContrato20Anos.data_assinatura na quase totalidade dos casos. Os
// poucos restantes (empates de data) ficam com match_confianca='manual' pro
// Alex revisar; sem contrato nenhum no depop = 'sem_match' (fora do
// programa de 20 anos). **Achado 2026-11-11**: mesmo concessionários
// "Demais" (sem_match) às vezes têm um código parecido com CCU e uma data de
// vencimento no CSV (ex: licenças de 25 anos, formato "LIC/.../GPxx") — isso
// NÃO significa renovação; só o casamento por `codigo` contra
// TarifaContrato20Anos/AvaliacaoAreaRenovacao decide `match_confianca`.
const express = require('express');
const { db, depopDb } = require('../database');
const { registrarLog, requireModulo } = require('../middleware');

const router = express.Router();
const relatoriosGerais = requireModulo('relatorios-gerais');

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

// Mesmo filtro usado em routes/secad.js e routes/secad-relatorios.js — Alex
// definiu (2026-11-06) um único número canônico de contratos pra bater em
// todas as telas: Removido e Teste NÃO contam (Fora do Prazo continua
// contando, só sinalizado). Duplicado aqui de propósito, mesma convenção já
// usada nos outros 2 arquivos.
function codigosRemovidos() {
  return new Set(db.prepare(`SELECT codigo FROM concessionario_removido`).all().map(r => r.codigo));
}
const CODIGOS_TESTE = new Set([30000]);

// Mesma regra de prazo final de adesão do SECAD (routes/secad.js,
// prazoFinalAdesao), pelo ano de vencimento do contrato de 20 anos. Duplicada
// aqui (função pura de 3 linhas) pra não acoplar este módulo ao secad.js.
function prazoFinalAdesao(ano) {
  if (ano === 2027) return '30/10/2026';
  if (ano >= 2028 && ano <= 2032) return '18/12/2026';
  return null;
}

// Converte cada linha do CSV (já objeto, chaves dadas pelo client) num
// "termo" no formato que casarComDepop/agruparTarifaDemais esperam. Uma
// linha de CSV = uma unidade física (pavilhão/box); quando o mesmo
// contrato tem várias unidades, várias linhas repetem os mesmos dados —
// isso é resolvido depois por agruparTarifaDemais (agrupa por codigo+valor
// da tarifa), não precisa de agrupamento aqui. `cod_termo` é só uma chave
// NOT NULL do banco, sem significado — sintética por linha.
function linhasParaTermos(linhas) {
  return linhas.map((linha, i) => {
    const tarifaValor = parseFloat(linha['Tarifa_Uso']);
    const tarifas = (linha['Tarifa_Uso'] !== '' && !isNaN(tarifaValor)) ? [{ descricao: 'Tarifa de Uso', valor: tarifaValor }] : [];
    const codigo = parseInt(linha['Codigo_Cfo'], 10) || null;
    return {
      cod_empresa: codigo,
      codigo,
      empresa: String(linha['Empresa'] || '').trim() || null,
      cnpj: String(linha['CNPJ'] || '').trim() || null,
      cidade_planilha: String(linha['Cidade'] || '').trim() || null,
      contrato_numero: String(linha['Contrato_Numero'] || '').trim() || null,
      contrato_data_inicio: String(linha['Data_Inicio'] || '').trim() || null,
      cod_termo: `${linha['Contrato_Numero'] || 'sem-contrato'}#${i}`,
      cod_contrato_juridico: String(linha['Ccu_Licenca'] || '').trim() || null,
      metragem_planilha: 0,
      tarifas,
    };
  });
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

// Pedido do Alex, 2026-11-11: quem NÃO tem contrato de renovação ("Demais")
// às vezes aparece na planilha espalhado em vários termos (1 por área/
// período) com a MESMA Tarifa de Uso repetida — sem tratar isso, o relatório
// mostraria o mesmo concessionário duplicado várias vezes. Agrupa por
// (codigo + valor da Tarifa de Uso, null contando como um valor igual aos
// outros nulos); quando o valor diverge entre termos do mesmo concessionário,
// mantém linhas separadas (a diferença é real). Representante do grupo = termo
// com a data de início mais recente (confirmado com o Alex); metragem soma os
// termos agrupados. Só se aplica a quem NÃO tem renovação — pra renovação a
// Tarifa de Uso já vem agregada (MAX) direto do depop, ver carregarDadosDepop.
function agruparTarifaDemais(termos) {
  const comMatch = termos.filter(t => t.match_confianca !== 'sem_match');
  const semMatch = termos.filter(t => t.match_confianca === 'sem_match');

  const valorTarifaUso = (t) => {
    const tf = t.tarifas.find(x => x.descricao === 'Tarifa de Uso');
    return tf ? tf.valor : null;
  };

  const grupos = new Map();
  semMatch.forEach(t => {
    const chave = `${t.codigo}|${valorTarifaUso(t)}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(t);
  });

  const agrupados = [...grupos.values()].map(grupo => {
    if (grupo.length === 1) return grupo[0];
    const representante = grupo.reduce((maisRecente, atual) =>
      soData(atual.contrato_data_inicio) > soData(maisRecente.contrato_data_inicio) ? atual : maisRecente
    );
    representante.metragem_planilha = grupo.reduce((soma, t) => soma + (t.metragem_planilha || 0), 0);
    return representante;
  });

  return [...comMatch, ...agrupados];
}

// ── Importação (admin-only) ──────────────────────────────────────────────────

router.post('/api/pac/concessionarios/importar', relatoriosGerais, requireAdminGlobal, (req, res) => {
  const { dry_run, nome_arquivo, linhas } = req.body || {};
  if (!Array.isArray(linhas) || !linhas.length) return res.status(400).json({ error: 'Nenhuma linha recebida.' });

  const semCodigo = [];
  const comCodigo = linhas.filter((l, i) => {
    if (!l['Codigo_Cfo'] || isNaN(parseInt(l['Codigo_Cfo'], 10))) { semCodigo.push(i + 2); return false; }
    return true;
  });

  const termos = agruparTarifaDemais(casarComDepop(linhasParaTermos(comCodigo)));
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
      (importacao_id, cod_empresa, codigo, empresa, cnpj, cidade_planilha, contrato_numero, contrato_data_inicio,
       cod_termo, cod_contrato_juridico, metragem_planilha, id_contrato_depop, match_confianca)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        importacaoId, t.cod_empresa, t.codigo, t.empresa, t.cnpj, t.cidade_planilha, t.contrato_numero, t.contrato_data_inicio,
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

router.get('/api/pac/concessionarios/importacoes', relatoriosGerais, requireVer, (req, res) => {
  const lista = db.prepare(`
    SELECT i.*, u.username AS importado_por_username
    FROM depla_concessionarios_importacao i
    LEFT JOIN users u ON u.id = i.importado_por
    ORDER BY i.id DESC
  `).all();
  res.json(lista);
});

// Carrega os campos derivados do depop.db (contrato/tarifa/vencimento/
// avaliação) pros id_contrato_depop pedidos.
function carregarDadosDepop(idsContrato) {
  const tarifaUsoPorContrato = new Map();
  const vencimentoPorContrato = new Map();
  const numeroCcuPorContrato = new Map();
  const dataAssinaturaPorContrato = new Map();
  const avaliacaoPorContrato = new Map();
  const cidadePorContrato = new Map();
  if (!idsContrato.length) {
    return { tarifaUsoPorContrato, vencimentoPorContrato, numeroCcuPorContrato, dataAssinaturaPorContrato, avaliacaoPorContrato, cidadePorContrato };
  }
  const placeholders = idsContrato.map(() => '?').join(',');
  // TarifaContrato20Anos "quebra" (fan-out) um mesmo contrato em várias
  // linhas quando ele tem mais de uma área/sequencial — nesse caso a tarifa
  // (atual_tarifa_uso), o vencimento, o nº do CCU e a data de assinatura são
  // o MESMO valor repetido em cada linha (confirmado: 0 divergência em 249
  // contratos com fan-out), então agrupar com MAX (nunca SUM) dá o valor
  // único correto. "Tarifa de Uso" = atual_tarifa_uso (confirmado pelo Alex,
  // 2026-11-04).
  depopDb.prepare(`
    SELECT id_contrato, MAX(atual_tarifa_uso) AS tarifa_media, MAX(data_vencimento) AS vencimento,
           MAX(numero_ccu) AS numero_ccu, MAX(data_assinatura) AS data_assinatura
    FROM TarifaContrato20Anos WHERE id_contrato IN (${placeholders}) GROUP BY id_contrato
  `).all(...idsContrato).forEach(r => {
    tarifaUsoPorContrato.set(r.id_contrato, r.tarifa_media);
    vencimentoPorContrato.set(r.id_contrato, r.vencimento);
    numeroCcuPorContrato.set(r.id_contrato, r.numero_ccu);
    dataAssinaturaPorContrato.set(r.id_contrato, r.data_assinatura);
  });
  depopDb.prepare(`
    SELECT id_contrato, valor_ponto, valor_30_ceasa
    FROM AvaliacaoAreaRenovacao WHERE id_contrato IN (${placeholders})
  `).all(...idsContrato).forEach(r => avaliacaoPorContrato.set(r.id_contrato, r));
  // Cidade (entreposto) — só existe pra quem tem renovação, via
  // AvaliacaoAreaRenovacao.id_cidade; a planilha do CORPORE não tem coluna
  // de cidade/entreposto por concessionário, então "Demais" fica sem (Alex,
  // 2026-11-11).
  depopDb.prepare(`
    SELECT ar.id_contrato, ci.descricao AS cidade
    FROM AvaliacaoAreaRenovacao ar JOIN Cidade ci ON ci.id = ar.id_cidade
    WHERE ar.id_contrato IN (${placeholders})
  `).all(...idsContrato).forEach(r => cidadePorContrato.set(r.id_contrato, r.cidade));
  return { tarifaUsoPorContrato, vencimentoPorContrato, numeroCcuPorContrato, dataAssinaturaPorContrato, avaliacaoPorContrato, cidadePorContrato };
}

// Pra "Demais" (concessionário sem contrato de renovação de 20 anos) a
// planilha do CORPORE tem sua própria coluna "Tarifa de Uso" — serve de
// de-para no lugar do atual_tarifa_uso do depop, que só existe pra quem tem
// contrato de renovação (Alex, 2026-11-05: "quando for da renovação vem
// dela, quando não for vem da planilha").
function carregarTarifaUsoPlanilha(idsConcessionario) {
  const mapa = new Map();
  if (!idsConcessionario.length) return mapa;
  const placeholders = idsConcessionario.map(() => '?').join(',');
  db.prepare(`
    SELECT concessionario_id, valor FROM depla_concessionarios_tarifa
    WHERE descricao = 'Tarifa de Uso' AND concessionario_id IN (${placeholders})
  `).all(...idsConcessionario).forEach(r => mapa.set(r.concessionario_id, r.valor));
  return mapa;
}

// Monta os campos calculados (contrato/tarifa/ponto/outorga/vencimento) de UM
// concessionário a partir dos mapas de carregarDadosDepop(). Quem tem
// contrato de renovação (match_confianca != 'sem_match') usa os dados do
// depop (nº do CCU, data de assinatura, Tarifa de Uso); quem não tem
// ("Demais") usa o equivalente da própria planilha (nº/data de contrato e
// Tarifa de Uso já tratada por agruparTarifaDemais) — vencimento/ponto/
// outorga não têm equivalente na planilha e ficam em branco pra esses.
function camposDepop(c, dados, tarifaUsoPlanilhaMap) {
  const renovacao = c.match_confianca !== 'sem_match';
  const aval = dados.avaliacaoPorContrato.get(c.id_contrato_depop) || null;
  // Sem divisão nenhuma — valor_ponto/valor_30_ceasa já são o valor real em
  // R$ (mesma leitura direta que routes/secad.js faz pra essas 2 colunas,
  // sem dividir por 1000 em lugar nenhum do app real). Achado do Alex,
  // 2026-11-04: os valores batiam "resumidos" demais por causa da divisão
  // indevida que eu tinha posto aqui.
  const valorPonto = aval ? aval.valor_ponto : null;
  const outorga = aval ? aval.valor_30_ceasa : null;
  const vencimento = dados.vencimentoPorContrato.get(c.id_contrato_depop) || null;
  const anoVencimento = vencimento ? parseInt(vencimento.slice(0, 4), 10) : null;
  return {
    renovacao,
    contrato_vencido_em: vencimento,
    prazo_final_adesao: anoVencimento ? prazoFinalAdesao(anoVencimento) : null,
    contrato_numero: renovacao ? (dados.numeroCcuPorContrato.get(c.id_contrato_depop) || c.contrato_numero || null) : (c.contrato_numero || null),
    contrato_data_inicio: renovacao ? (dados.dataAssinaturaPorContrato.get(c.id_contrato_depop) || c.contrato_data_inicio || null) : (c.contrato_data_inicio || null),
    cidade: renovacao ? (dados.cidadePorContrato.get(c.id_contrato_depop) || c.cidade_planilha || null) : (c.cidade_planilha || null),
    tarifa_uso: renovacao ? (dados.tarifaUsoPorContrato.get(c.id_contrato_depop) || null) : (tarifaUsoPlanilhaMap.get(c.id) ?? null),
    valor_ponto: valorPonto,
    outorga,
  };
}

// Busca os contratos de uma importação — por padrão só os CASADOS com o
// depop (direto/data/manual), já que o módulo é focado em quem está no
// programa de renovação de 20 anos. incluirDemais=true também traz os
// 'sem_match' (concessionários fora do programa — ver flag "Demais" na tela).
// Sem ORDER BY aqui — a ordenação de verdade (por cidade, depois código) só
// dá pra fazer depois de calcular o campo cidade, ver ordenarPorCidadeECodigo().
function buscarContratos(importacaoId, incluirDemais) {
  const filtro = incluirDemais ? '' : `AND match_confianca != 'sem_match'`;
  return db.prepare(`
    SELECT * FROM depla_concessionarios WHERE importacao_id = ? ${filtro}
  `).all(importacaoId);
}

// Pedido do Alex, 2026-11-11: ordenar o relatório por entreposto (cidade) e,
// dentro da mesma cidade, por código do concessionário. Quem não tem cidade
// (sem renovação — a planilha não traz entreposto) vai pro fim da lista.
function ordenarPorCidadeECodigo(linhas) {
  return linhas.sort((a, b) =>
    (a.cidade || '￿').localeCompare(b.cidade || '￿', 'pt-BR') ||
    (a.codigo || 0) - (b.codigo || 0)
  );
}

// "Preciso do validador informando que a quantidade de concessionários no
// Depop bate com o que apresentamos aqui" (Alex, 2026-11-05). Compara o
// total de CONTRATOS de 20 anos e de EMPRESAS distintas no depop.db contra o
// que a importação atual conseguiu casar — e lista o que ficou de fora, pra
// ele julgar se é esperado (ex: dado de teste no depop) ou um problema real.
function validarContraDepop(importacaoId) {
  // Base = AvaliacaoAreaRenovacao (mesmo universo canônico do SECAD), não
  // TarifaContrato20Anos — essa tem 2 id_contrato "órfãos" sem avaliação
  // correspondente (492, 559) e não exclui Removido/Teste. Removido e Teste
  // não contam (regra única definida com o Alex, 2026-11-06); Fora do Prazo
  // continua contando (só é sinalizado, nunca excluído daqui).
  const excluidos = new Set([...codigosRemovidos(), ...CODIGOS_TESTE]);
  const contratosDepop = depopDb.prepare(`
    SELECT id_contrato, codigo, concessionaria AS concessionario, numero_ccu
    FROM AvaliacaoAreaRenovacao
  `).all().filter(c => !excluidos.has(c.codigo));
  const empresasDepop = new Set(contratosDepop.map(c => c.codigo));

  const idsDepop = new Set(contratosDepop.map(c => c.id_contrato));
  const casadosRaw = new Set(db.prepare(`
    SELECT DISTINCT id_contrato_depop FROM depla_concessionarios
    WHERE importacao_id = ? AND id_contrato_depop IS NOT NULL
  `).all(importacaoId).map(r => r.id_contrato_depop));
  // Só conta como "apresentado" quem está no universo canônico — um termo da
  // planilha pode casar com um id_contrato de Removido ou com um órfão sem
  // avaliação (ex: 492, Real Comércio de Miudezas), e esses não entram na
  // conta de nenhum lado (mesma regra do SECAD).
  const casadosSet = new Set([...casadosRaw].filter(id => idsDepop.has(id)));
  const empresasCasadas = new Set(
    db.prepare(`SELECT DISTINCT codigo FROM depla_concessionarios WHERE importacao_id = ? AND match_confianca != 'sem_match'`)
      .all(importacaoId).map(r => r.codigo)
      .filter(codigo => !excluidos.has(codigo))
  );

  const contratosFaltando = contratosDepop.filter(c => !casadosSet.has(c.id_contrato));

  return {
    contratos_depop: contratosDepop.length,
    contratos_apresentados: casadosSet.size,
    empresas_depop: empresasDepop.size,
    empresas_apresentadas: empresasCasadas.size,
    bate: contratosDepop.length === casadosSet.size,
    contratos_faltando: contratosFaltando.map(c => ({
      id_contrato: c.id_contrato, codigo: c.codigo, concessionario: c.concessionario, numero_ccu: c.numero_ccu,
    })),
  };
}

// Cards de resumo do topo da tela — sempre sobre TODOS os concessionários da
// importação (ignora o filtro "Mostrar Demais" da tabela, que é só de
// exibição; os cards são o retrato completo). Pedido do Alex, 2026-11-11.
function calcularCards(importacaoId) {
  const todos = buscarContratos(importacaoId, true);
  const codigosRenovacao = new Set(todos.filter(c => c.match_confianca !== 'sem_match').map(c => c.codigo));
  const codigosDemais = new Set(todos.filter(c => c.match_confianca === 'sem_match').map(c => c.codigo));

  const idsContrato = [...new Set(todos.map(c => c.id_contrato_depop).filter(Boolean))];
  const dadosDepop = carregarDadosDepop(idsContrato);
  const tarifaUsoPlanilha = carregarTarifaUsoPlanilha(todos.map(c => c.id));

  const tarifaPorEntreposto = new Map();
  todos.forEach(c => {
    const renovacao = c.match_confianca !== 'sem_match';
    const tarifa = renovacao ? dadosDepop.tarifaUsoPorContrato.get(c.id_contrato_depop) : tarifaUsoPlanilha.get(c.id);
    if (!tarifa) return;
    // Cidade vem do depop pra quem tem renovação, da própria planilha pra
    // quem não tem (achado 2026-11-11: o CSV novo do CORPORE traz cidade
    // por linha pra todo mundo, não só renovação).
    const cidade = (renovacao ? dadosDepop.cidadePorContrato.get(c.id_contrato_depop) : c.cidade_planilha) || 'Sem entreposto';
    tarifaPorEntreposto.set(cidade, (tarifaPorEntreposto.get(cidade) || 0) + tarifa);
  });

  return {
    total_concessionarios: new Set([...codigosRenovacao, ...codigosDemais]).size,
    total_renovacao: codigosRenovacao.size,
    total_demais: codigosDemais.size,
    tarifa_por_entreposto: [...tarifaPorEntreposto.entries()]
      .map(([cidade, total]) => ({ cidade, total }))
      .sort((a, b) => b.total - a.total),
  };
}

// ── Relatório resumido ───────────────────────────────────────────────────────
// Uma linha por contrato (termo) CASADO com o depop, com tarifa de uso/valor
// do ponto/outorga/vencimento calculados do depop.db. Concessionário sem
// contrato de renovação ("Demais") fica de fora por padrão — só aparece com
// ?incluir_demais=1.
router.get('/api/pac/concessionarios/resumido', relatoriosGerais, requireVer, (req, res) => {
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
  const tarifaUsoPlanilha = carregarTarifaUsoPlanilha(contratos.map(c => c.id));

  const linhas = ordenarPorCidadeECodigo(contratos.map(c => {
    const depop = camposDepop(c, dadosDepop, tarifaUsoPlanilha);
    return {
      codigo: c.codigo,
      empresa: c.empresa,
      cnpj: c.cnpj,
      cidade: depop.cidade,
      renovacao: depop.renovacao,
      prazo_final_adesao: depop.prazo_final_adesao,
      contrato_numero: depop.contrato_numero,
      contrato_data_inicio: depop.contrato_data_inicio,
      contrato_vencido_em: depop.contrato_vencido_em,
      tarifa_uso: depop.tarifa_uso,
      valor_ponto: depop.valor_ponto,
      outorga: depop.outorga,
      match_confianca: c.match_confianca,
    };
  }));

  res.json({
    importacao_id: importacaoId, linhas, total_demais: totalDemais,
    validador: validarContraDepop(importacaoId), cards: calcularCards(importacaoId),
  });
});

module.exports = router;
