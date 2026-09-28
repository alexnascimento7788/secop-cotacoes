// ── Módulo Concessionários Cadastro ────────────────────────────────────────
// Módulo PRÓPRIO (não rotina do secad — ver database.js), mesmo departamento
// (Depop). Dado sincronizado automaticamente do CeasaConecta-Gateway (ver
// secad-gateway-sync.js, tabela concessionario_cadastro em depop.db) — 100%
// leitura aqui, sem CRUD manual de campo nenhum. Um concessionário (codigo/
// CODCFO) pode ter mais de 1 linha (1 por contrato/termo, confirmado com
// dado real) — "Ativo" = tem PELO MENOS 1 linha com ativo=1.
const express = require('express');
const { db, depopDb } = require('../database');
const { requireModulo, requireRotina } = require('../middleware');
const { gerarPdfConcessionarios } = require('../concessionarios-cadastro-pdf');

const router = express.Router();
const cc = requireModulo('concessionarios-cadastro');
const ver = requireRotina('consulta', 'ver');

// Unidade (2026-09-28): vem pronta do Gateway, mapeada lá a partir do código
// ZTERMO.UNIDADE (autoritativo do ERP) — substituiu a heurística por cidade
// que existia aqui antes (que nem cobria Governador Valadares/Uberaba como
// unidades próprias). `unidade` vem null quando o código do CORPORE não bate
// com nenhuma das 7 conhecidas — cai no balde "Fora das Unidades".
const FORA_DAS_UNIDADES = 'Fora das Unidades';
function unidadeDaLinha(l) {
  return l.unidade || FORA_DAS_UNIDADES;
}

// Contratos "ML*" (SUBSTRING(NUMEROCONTRATO,5,3) IN MLA..MLH) — regra de
// negócio que antes vinha embutida no SQL do Gateway excluindo essas linhas
// sempre; por pedido do Alex (2026-09-28) isso não fica mais na API, vira um
// filtro OPCIONAL aqui (visível por padrão, some quando o usuário liga o
// filtro), aplicado igual em Pesquisar e no Relatório PDF pra nunca divergir.
const PREFIXOS_ML_ISENTOS = ['MLA', 'MLB', 'MLC', 'MLD', 'MLE', 'MLF', 'MLG', 'MLH'];
function ehContratoMl(numeroContrato) {
  return PREFIXOS_ML_ISENTOS.includes(String(numeroContrato || '').substring(4, 7));
}

// Tipo de cliente (2026-09-28): FCFO.CODTCF + FTCF.DESCRICAO, vindos prontos
// do Gateway (LEFT JOIN lá — 6 registros reais não têm par em FTCF, ficam
// com `descricao_tipo_cliente` null aqui, caem no fallback abaixo). Exibido
// como "código - descrição" numa linha só (pedido do Alex) — esse mesmo
// texto é o valor usado tanto na lista de opções do filtro (multi-seleção)
// quanto na comparação do IN, pra tela/filtro nunca divergirem.
function tipoClienteExibicao(l) {
  const desc = l.descricao_tipo_cliente || 'Sem tipo informado';
  return l.cod_tipo_cliente ? `${l.cod_tipo_cliente} - ${desc}` : desc;
}

// Agrupa as linhas de contrato por concessionário (codigo) — usado só no
// Dashboard (Total/Ativos/Inativos fazem sentido como contagem de EMPRESA).
// `principal` = a linha ativa (ou a 1ª, se nenhuma ativa).
function concessionariosAgrupados() {
  const linhas = depopDb.prepare(`SELECT * FROM concessionario_cadastro ORDER BY codigo, numero_contrato`).all();
  const porCodigo = new Map();
  linhas.forEach(l => {
    if (!porCodigo.has(l.codigo)) porCodigo.set(l.codigo, []);
    porCodigo.get(l.codigo).push(l);
  });
  return Array.from(porCodigo.values()).map(itens => {
    const ativo = itens.some(i => i.ativo === 1);
    const principal = itens.find(i => i.ativo === 1) || itens[0];
    return { codigo: principal.codigo, ativo, unidade: unidadeDaLinha(principal), itens, principal };
  });
}

// Linhas cruas (1 por contrato) com `unidade` calculada — usado por Pesquisar
// e pelo Relatório. Um concessionário pode ter mais de 1 contrato ATIVO ao
// mesmo tempo (achado real, 143 casos) — "achatar" pra 1 linha por empresa
// escondia contrato de verdade. Aqui cada contrato é sua própria linha.
function linhasComUnidade() {
  return depopDb.prepare(`SELECT * FROM concessionario_cadastro ORDER BY codigo, numero_contrato`).all()
    .map(l => ({ ...l, unidade: unidadeDaLinha(l) }));
}

// Detalhes da última sincronização com o CeasaConecta-Gateway (gravados em
// `config` por secad-gateway-sync.js) — pedido do Alex, 2026-09-28, pra dar
// visibilidade no dashboard do módulo de quando/como foi a última rodada.
function configVal(chave) {
  return db.prepare(`SELECT valor FROM config WHERE chave = ?`).get(chave)?.valor || null;
}
function statusSincronizacao() {
  return {
    ultima_sync: configVal('secad_gateway_ultima_sync'),
    ultima_tentativa: configVal('secad_gateway_ultima_tentativa'),
    status: configVal('secad_gateway_ultimo_status'),
    total: configVal('secad_gateway_ultimo_total'),
    gravados: configVal('secad_gateway_ultimo_gravados'),
    erro: configVal('secad_gateway_ultimo_erro') || null,
  };
}

router.get('/api/concessionarios-cadastro/dashboard', cc, ver, (req, res) => {
  const grupos = concessionariosAgrupados();
  const totalContratos = grupos.reduce((s, g) => s + g.itens.length, 0);
  let ativosContratoNulo = 0;
  grupos.forEach(g => g.itens.forEach(i => {
    if (i.ativo === 1 && (!i.numero_contrato || !String(i.numero_contrato).trim())) ativosContratoNulo++;
  }));
  const porUnidade = {};
  grupos.forEach(g => { porUnidade[g.unidade] = (porUnidade[g.unidade] || 0) + 1; });
  // Lista de ramos/tipos de cliente distintos — usada pra popular os filtros
  // (Pesquisar e Relatório), mesmo espírito do por_unidade acima.
  const ramos = Array.from(new Set(grupos.flatMap(g => g.itens.map(i => i.descricao_ramo || 'Sem ramo informado')))).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const tiposCliente = Array.from(new Set(grupos.flatMap(g => g.itens.map(tipoClienteExibicao)))).sort((a, b) => a.localeCompare(b, 'pt-BR'));

  res.json({
    total: grupos.length,
    ativos: grupos.filter(g => g.ativo).length,
    inativos: grupos.filter(g => !g.ativo).length,
    total_contratos: totalContratos,
    ativos_contrato_nulo: ativosContratoNulo,
    por_unidade: porUnidade,
    ramos,
    tipos_cliente: tiposCliente,
    sincronizacao: statusSincronizacao(),
  });
});

router.get('/api/concessionarios-cadastro', cc, ver, (req, res) => {
  const { busca, unidade, ativo, ocultar_ml, tipos_cliente } = req.query;
  let linhas = linhasComUnidade();
  if (unidade) linhas = linhas.filter(l => l.unidade === unidade);
  if (ativo === '1') linhas = linhas.filter(l => l.ativo === 1);
  if (ativo === '0') linhas = linhas.filter(l => l.ativo !== 1);
  if (String(ocultar_ml) === '1') linhas = linhas.filter(l => !ehContratoMl(l.numero_contrato));
  // Multi-seleção (lista com checkbox → IN) — pedido do Alex, 2026-09-28.
  if (tipos_cliente) {
    const selecionados = String(tipos_cliente).split('|').filter(Boolean);
    if (selecionados.length) linhas = linhas.filter(l => selecionados.includes(tipoClienteExibicao(l)));
  }
  if (busca && busca.trim()) {
    const termo = busca.trim().toLowerCase();
    linhas = linhas.filter(l =>
      (l.nome || '').toLowerCase().includes(termo) ||
      (l.fantasia || '').toLowerCase().includes(termo) ||
      (l.cnpj || '').includes(termo)
    );
  }
  linhas.sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR') || (a.numero_contrato || '').localeCompare(b.numero_contrato || ''));
  // Devolve TODOS os campos da linha/contrato — a tela de detalhe abre a
  // partir do próprio item clicado na lista (sem 2ª requisição), então não
  // pode faltar nada nem misturar dado de outro contrato do mesmo código.
  res.json(linhas.map(l => ({
    codigo: l.codigo, numero_contrato: l.numero_contrato, contrato_juridico: l.contrato_juridico,
    ativo: l.ativo === 1, unidade: l.unidade,
    nome: l.nome, fantasia: l.fantasia, cnpj: l.cnpj, ie: l.ie, descricao_ramo: l.descricao_ramo,
    tipo_cliente: tipoClienteExibicao(l),
    endereco: l.endereco, numero: l.numero, bairro: l.bairro, cidade: l.cidade, cep: l.cep, telefone: l.telefone,
  })));
});

router.post('/api/concessionarios-cadastro/relatorio/pdf', cc, ver, async (req, res) => {
  const { unidade, ativo, ramo, ocultar_ml, tipos_cliente } = req.body || {};
  let linhas = linhasComUnidade();
  if (unidade) linhas = linhas.filter(l => l.unidade === unidade);
  if (String(ativo) === '1') linhas = linhas.filter(l => l.ativo === 1);
  if (String(ativo) === '0') linhas = linhas.filter(l => l.ativo !== 1);
  // Ramo é um FILTRO opcional, não agrupamento obrigatório — quando não
  // informado, o relatório traz todos os ramos juntos (Ramo vira só uma
  // coluna da tabela). Pedido do Alex, 2026-09-26.
  if (ramo) linhas = linhas.filter(l => (l.descricao_ramo || 'Sem ramo informado') === ramo);
  // Mesmo filtro (e mesmo default "visível") da tela de Pesquisar, pra nunca
  // divergir do que o relatório mostra. Pedido do Alex, 2026-09-28.
  if (String(ocultar_ml) === '1') linhas = linhas.filter(l => !ehContratoMl(l.numero_contrato));
  const tiposSelecionados = String(tipos_cliente || '').split('|').filter(Boolean);
  if (tiposSelecionados.length) linhas = linhas.filter(l => tiposSelecionados.includes(tipoClienteExibicao(l)));

  // Ordena por "ID da TOTVS" (codigo/CODCFO) — não mais por nome/ramo.
  linhas.sort((a, b) => a.codigo - b.codigo);
  // Anexa o rótulo já pronto (código - descrição) que o gerador de PDF usa
  // como coluna — evita duplicar a lógica de formatação lá.
  linhas = linhas.map(l => ({ ...l, tipo_cliente: tipoClienteExibicao(l) }));

  const filtrosPartes = [];
  if (unidade) filtrosPartes.push(`Unidade: ${unidade}`);
  if (ramo) filtrosPartes.push(`Ramo: ${ramo}`);
  if (String(ativo) === '1') filtrosPartes.push('Somente ativos');
  if (String(ativo) === '0') filtrosPartes.push('Somente inativos');
  if (String(ocultar_ml) === '1') filtrosPartes.push('Contratos ML ocultos');
  if (tiposSelecionados.length) filtrosPartes.push(`Tipo de Cliente: ${tiposSelecionados.length === 1 ? tiposSelecionados[0] : tiposSelecionados.length + ' selecionados'}`);

  try {
    const pdfBuffer = await gerarPdfConcessionarios(linhas, filtrosPartes.join(' · '), req.user.nome_completo || req.user.username);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="concessionarios-cadastro.pdf"');
    res.send(pdfBuffer);
  } catch (e) {
    console.error('[concessionarios-cadastro] erro ao gerar PDF:', e);
    res.status(500).json({ error: 'Falha ao montar o PDF.' });
  }
});

module.exports = router;
