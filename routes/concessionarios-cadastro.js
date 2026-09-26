// ── Módulo Concessionários Cadastro ────────────────────────────────────────
// Módulo PRÓPRIO (não rotina do secad — ver database.js), mesmo departamento
// (Depop). Dado sincronizado automaticamente do CeasaConecta-Gateway (ver
// secad-gateway-sync.js, tabela concessionario_cadastro em depop.db) — 100%
// leitura aqui, sem CRUD manual de campo nenhum. Um concessionário (codigo/
// CODCFO) pode ter mais de 1 linha (1 por contrato/termo, confirmado com
// dado real) — "Ativo" = tem PELO MENOS 1 linha com ativo=1.
const express = require('express');
const { depopDb } = require('../database');
const { requireModulo, requireRotina } = require('../middleware');
const { gerarPdfConcessionarios } = require('../concessionarios-cadastro-pdf');

const router = express.Router();
const cc = requireModulo('concessionarios-cadastro');
const ver = requireRotina('consulta', 'ver');

// Mapeamento cidade (texto livre do CORPORE) → Unidade (mesma tabela
// `unidades` do PAC, reaproveitada aqui por pedido do Alex — as 5 unidades
// batem exatamente com as 5 cidades mais frequentes no cadastro real).
// Constante fixa de propósito (Alex confirmou que não precisa de tela de
// edição) — cidade fora daqui cai no balde "Fora das Unidades". Pra
// estender, é só adicionar uma entrada.
const CIDADE_UNIDADE = {
  'Contagem': 'Contagem',
  'Belo Horizonte': 'Contagem', 'Betim': 'Contagem', 'Ibirité': 'Contagem',
  'Nova Lima': 'Contagem', 'Ribeirão das Neves': 'Contagem', 'Confins': 'Contagem',
  'São Joaquim de Bicas': 'Contagem', 'Igarapé': 'Contagem', 'Mateus Leme': 'Contagem',
  'Esmeraldas': 'Contagem',
  'Uberlândia': 'Uberlândia', 'Uberaba': 'Uberlândia', 'Araguari': 'Uberlândia',
  'Monte Alegre de Minas': 'Uberlândia',
  'Juiz de Fora': 'Juiz de Fora',
  'Barbacena': 'Barbacena', 'Carandaí': 'Barbacena', 'Conselheiro Lafaiete': 'Barbacena',
  'Caratinga': 'Caratinga', 'Ipatinga': 'Caratinga', 'Governador Valadares': 'Caratinga',
  'Santa Bárbara do Leste': 'Caratinga', 'São João do Oriente': 'Caratinga',
};
const FORA_DAS_UNIDADES = 'Fora das Unidades';
function unidadeDaCidade(cidade) {
  return CIDADE_UNIDADE[String(cidade || '').trim()] || FORA_DAS_UNIDADES;
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
    return { codigo: principal.codigo, ativo, unidade: unidadeDaCidade(principal.cidade), itens, principal };
  });
}

// Linhas cruas (1 por contrato) com `unidade` calculada — usado por Pesquisar
// e pelo Relatório. Um concessionário pode ter mais de 1 contrato ATIVO ao
// mesmo tempo (achado real, 143 casos) — "achatar" pra 1 linha por empresa
// escondia contrato de verdade. Aqui cada contrato é sua própria linha.
function linhasComUnidade() {
  return depopDb.prepare(`SELECT * FROM concessionario_cadastro ORDER BY codigo, numero_contrato`).all()
    .map(l => ({ ...l, unidade: unidadeDaCidade(l.cidade) }));
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

  res.json({
    total: grupos.length,
    ativos: grupos.filter(g => g.ativo).length,
    inativos: grupos.filter(g => !g.ativo).length,
    total_contratos: totalContratos,
    ativos_contrato_nulo: ativosContratoNulo,
    por_unidade: porUnidade,
  });
});

router.get('/api/concessionarios-cadastro', cc, ver, (req, res) => {
  const { busca, unidade, ativo } = req.query;
  let linhas = linhasComUnidade();
  if (unidade) linhas = linhas.filter(l => l.unidade === unidade);
  if (ativo === '1') linhas = linhas.filter(l => l.ativo === 1);
  if (ativo === '0') linhas = linhas.filter(l => l.ativo !== 1);
  if (busca && busca.trim()) {
    const termo = busca.trim().toLowerCase();
    linhas = linhas.filter(l =>
      (l.nome || '').toLowerCase().includes(termo) ||
      (l.fantasia || '').toLowerCase().includes(termo) ||
      (l.cnpj || '').includes(termo)
    );
  }
  linhas.sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR') || (a.numero_contrato || '').localeCompare(b.numero_contrato || ''));
  res.json(linhas.map(l => ({
    codigo: l.codigo, numero_contrato: l.numero_contrato, ativo: l.ativo === 1, unidade: l.unidade,
    nome: l.nome, fantasia: l.fantasia, cnpj: l.cnpj, cidade: l.cidade, descricao_ramo: l.descricao_ramo,
  })));
});

router.get('/api/concessionarios-cadastro/:codigo', cc, ver, (req, res) => {
  const codigo = parseInt(req.params.codigo, 10);
  const itens = depopDb.prepare(`SELECT * FROM concessionario_cadastro WHERE codigo = ? ORDER BY ativo DESC, numero_contrato`).all(codigo);
  if (!itens.length) return res.status(404).json({ error: 'Concessionário não encontrado.' });
  const principal = itens.find(i => i.ativo === 1) || itens[0];
  res.json({
    codigo, ativo: itens.some(i => i.ativo === 1), unidade: unidadeDaCidade(principal.cidade),
    principal, contratos: itens,
  });
});

router.post('/api/concessionarios-cadastro/relatorio/pdf', cc, ver, async (req, res) => {
  const { unidade, ativo } = req.body || {};
  let linhas = linhasComUnidade();
  if (unidade) linhas = linhas.filter(l => l.unidade === unidade);
  if (String(ativo) === '1') linhas = linhas.filter(l => l.ativo === 1);
  if (String(ativo) === '0') linhas = linhas.filter(l => l.ativo !== 1);

  const porRamo = new Map();
  linhas.forEach(l => {
    const ramo = l.descricao_ramo || 'Sem ramo informado';
    if (!porRamo.has(ramo)) porRamo.set(ramo, []);
    porRamo.get(ramo).push(l);
  });
  const ramos = Array.from(porRamo.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'))
    .map(([ramo, itens]) => ({
      ramo,
      itens: itens.slice().sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR')),
    }));

  const filtrosPartes = [];
  if (unidade) filtrosPartes.push(`Unidade: ${unidade}`);
  if (String(ativo) === '1') filtrosPartes.push('Somente ativos');
  if (String(ativo) === '0') filtrosPartes.push('Somente inativos');

  try {
    const pdfBuffer = await gerarPdfConcessionarios(ramos, filtrosPartes.join(' · '), req.user.nome_completo || req.user.username);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="concessionarios-cadastro.pdf"');
    res.send(pdfBuffer);
  } catch (e) {
    console.error('[concessionarios-cadastro] erro ao gerar PDF:', e);
    res.status(500).json({ error: 'Falha ao montar o PDF.' });
  }
});

module.exports = router;
