// ── SECAD/Relatórios: PDF do relatório de adesão à renovação ────────────────
// Mesmo padrão de admin-pdf.js/secad-pdf.js/pac-pdf.js (pdf-lib, Escritor com
// cursor de página) — duplicado aqui de propósito (cada módulo tem o próprio
// arquivo de PDF, nenhum módulo compartilhado novo). Pedido do Alex,
// 2026-10-22/23: indicadores de adesão à renovação (quem já "aceitou" vs.
// quem falta), agrupado por prazo (edital/TCC) × cidade, com logo do CEASA.
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_W = 595.28, PAGE_H = 841.89; // A4 em pontos (72dpi)
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;
const AZUL = rgb(0x1A / 255, 0x3F / 255, 0x6B / 255);
const VERMELHO_PENDENTE = rgb(0xC0 / 255, 0x39 / 255, 0x2B / 255);
const VERDE_OK = rgb(0x2E / 255, 0x7D / 255, 0x32 / 255);
const AMBAR = rgb(0xB4 / 255, 0x6A / 255, 0x00 / 255);
const CINZA_BORDA = rgb(0.8, 0.8, 0.8);

// Versão bem clara de uma cor, pra usar como fundo de caixa/linha sem
// competir com o texto em cima — mistura com branco (fator 0 = cor pura,
// 1 = branco puro).
function tintClaro(cor, fator = 0.9) {
  return rgb(
    cor.red + (1 - cor.red) * fator,
    cor.green + (1 - cor.green) * fator,
    cor.blue + (1 - cor.blue) * fator,
  );
}

// Mesmas 3 faixas usadas na tela (rel-pct-ok/rel-pct-baixo) — ≥80% verde,
// 50–79% âmbar, <50% vermelho.
function corPorPct(pct) {
  if (pct >= 80) return VERDE_OK;
  if (pct >= 50) return AMBAR;
  return VERMELHO_PENDENTE;
}

function truncar(texto, font, size, maxWidth) {
  const t0 = String(texto ?? '');
  if (font.widthOfTextAtSize(t0, size) <= maxWidth) return t0;
  let t = t0;
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

class Escritor {
  constructor(pdfDoc, regular, negrito, logoImg) {
    this.pdfDoc = pdfDoc;
    this.regular = regular;
    this.negrito = negrito;
    this.logoImg = logoImg;
    this.page = null;
    this.y = 0;
  }
  novaPagina() {
    this.page = this.pdfDoc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
    return this.page;
  }
  espaco(h) { this.y -= h; }
  garantirEspaco(h) { if (this.y - h < MARGIN + 20) this.novaPagina(); }
  cabecalho(subtitulo) {
    if (this.logoImg) {
      const escala = 32 / this.logoImg.height;
      this.page.drawImage(this.logoImg, { x: MARGIN, y: this.y - 30, width: this.logoImg.width * escala, height: 32 });
    } else {
      this.page.drawText('CEASAMINAS', { x: MARGIN, y: this.y, size: 16, font: this.negrito, color: AZUL });
    }
    if (subtitulo) {
      const larguraSub = this.negrito.widthOfTextAtSize(subtitulo, 10);
      this.page.drawText(subtitulo, { x: PAGE_W - MARGIN - larguraSub, y: this.y - 6, size: 10, font: this.negrito, color: AZUL });
    }
    this.y -= 42;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 1, color: rgb(0.75, 0.75, 0.75) });
    this.y -= 22;
  }
  titulo(texto, size = 13) {
    this.garantirEspaco(26);
    this.page.drawText(texto, { x: MARGIN, y: this.y, size, font: this.negrito, color: AZUL });
    this.y -= size + 12;
  }
  subtitulo(texto, cor) {
    this.garantirEspaco(20);
    this.page.drawText(texto, { x: MARGIN, y: this.y, size: 11.5, font: this.negrito, color: cor || rgb(0, 0, 0) });
    this.y -= 18;
  }
  paragrafo(texto, size = 10, cor) {
    this.garantirEspaco(size + 4);
    this.page.drawText(texto, { x: MARGIN, y: this.y, size, font: this.regular, color: cor || rgb(0, 0, 0) });
    this.y -= size + 4;
  }
  linha() {
    this.garantirEspaco(14);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.75, color: rgb(0.82, 0.82, 0.82) });
    this.y -= 14;
  }
}

// Tabela simples (cabeçalho em negrito + linhas) — mesmo padrão de
// desenharTabela em admin-pdf.js/pac-pdf.js. `linha.cor` colore a linha toda;
// `linha.coresCol` (array, mesmo tamanho de cols) colore só células
// específicas (usado no % de adesão — resto da linha fica em preto, sóbrio).
function desenharTabela(w, negrito, regular, subtitulo, cols, linhas) {
  function cabecalhoTabela() {
    w.garantirEspaco(20);
    let x = MARGIN;
    cols.forEach(c => { w.page.drawText(c.label, { x, y: w.y, size: 9, font: negrito, color: c.cor || rgb(0.3, 0.3, 0.3) }); x += c.w; });
    w.y -= 14;
    w.linha();
  }
  cabecalhoTabela();
  linhas.forEach(linha => {
    if (w.y - 16 < MARGIN + 20) { w.novaPagina(); w.cabecalho(subtitulo); cabecalhoTabela(); }
    let x = MARGIN;
    cols.forEach((c, i) => {
      const texto = truncar(String(linha.valores[i]), regular, 8.5, c.w - 4);
      const cor = (linha.coresCol && linha.coresCol[i]) || linha.cor || c.cor || rgb(0, 0, 0);
      const fonte = (linha.coresCol && linha.coresCol[i]) ? negrito : regular;
      w.page.drawText(texto, { x, y: w.y, size: 8.5, font: fonte, color: cor });
      x += c.w;
    });
    w.y -= 15;
  });
}

// Capa: 4 caixas com número grande + label, 2x2 — mesmos 4 KPIs já exibidos
// na tela (Total/Aceitaram/Pendentes/% Adesão), calculados globalmente. Fundo
// com tingimento bem claro da cor do KPI + barra de destaque no topo, pra dar
// alguma identidade visual sem fugir do tom sóbrio/executivo.
function desenharCardsCapa(w, negrito, regular, cards) {
  const gap = 14;
  const larguraCaixa = (CONTENT_W - gap) / 2;
  const alturaCaixa = 68;
  const barraH = 4;
  w.garantirEspaco(alturaCaixa * 2 + gap * 2);
  const yInicio = w.y;
  cards.forEach((card, i) => {
    const col = i % 2, lin = Math.floor(i / 2);
    const x = MARGIN + col * (larguraCaixa + gap);
    const yTopo = yInicio - lin * (alturaCaixa + gap);
    const yBase = yTopo - alturaCaixa;
    const cor = card.cor || AZUL;
    w.page.drawRectangle({ x, y: yBase, width: larguraCaixa, height: alturaCaixa, color: tintClaro(cor, 0.93) });
    w.page.drawRectangle({ x, y: yTopo - barraH, width: larguraCaixa, height: barraH, color: cor });
    w.page.drawRectangle({ x, y: yBase, width: larguraCaixa, height: alturaCaixa, borderColor: CINZA_BORDA, borderWidth: 1 });
    w.page.drawText(card.label, { x: x + 16, y: yTopo - 26, size: 9.5, font: regular, color: rgb(0.4, 0.4, 0.4) });
    w.page.drawText(String(card.valor), { x: x + 16, y: yBase + 16, size: 26, font: negrito, color: cor });
  });
  w.y = yInicio - 2 * (alturaCaixa + gap) + gap;
}

// Legenda das 3 faixas de % de adesão (mesmos limiares de corPorPct) —
// contexto rápido de leitura pra quem recebe o relatório impresso.
function desenharLegendaFaixas(w, regular) {
  const itens = [
    { cor: VERDE_OK, texto: '80% ou mais — adesão alta' },
    { cor: AMBAR, texto: '50% a 79% — atenção' },
    { cor: VERMELHO_PENDENTE, texto: 'abaixo de 50% — crítico' },
  ];
  w.garantirEspaco(14);
  let x = MARGIN;
  itens.forEach(it => {
    w.page.drawRectangle({ x, y: w.y - 7, width: 9, height: 9, color: it.cor });
    w.page.drawText(it.texto, { x: x + 14, y: w.y - 6, size: 8.5, font: regular, color: rgb(0.4, 0.4, 0.4) });
    x += 14 + regular.widthOfTextAtSize(it.texto, 8.5) + 22;
  });
  w.y -= 20;
}

// Tabela de resumo da capa — cabeçalho com fundo + linhas zebradas + colunas
// numéricas alinhadas à direita. Visual mais executivo que a tabela simples
// (desenharTabela) usada no detalhe por prazo/cidade.
const COLS_RESUMO = [
  { label: 'Prazo final', w: 160, alinhar: 'esq' },
  { label: 'Total', w: 80, alinhar: 'dir' },
  { label: 'Aceitaram', w: 100, alinhar: 'dir' },
  { label: 'Pendentes', w: 100, alinhar: 'dir' },
  { label: '% Adesão', w: 83, alinhar: 'dir' },
];
function desenharResumoPrazo(w, negrito, regular, grupos) {
  const alturaLinha = 24;
  const larguraTotal = COLS_RESUMO.reduce((s, c) => s + c.w, 0);
  w.garantirEspaco(alturaLinha * (grupos.length + 1) + 6);

  // Cada linha (cabeçalho ou dado) é desenhada com o mesmo pivô: `fundo`
  // pinta o retângulo da linha ANTES do texto, com w.y marcando a posição
  // da baseline do texto, sempre 8pt acima do fundo da linha — consistente
  // entre cabeçalho e dados, nada de offset calculado 2x.
  function linha(valores, size, fonteCol0, fonteResto, cores, corFundo) {
    if (corFundo) w.page.drawRectangle({ x: MARGIN, y: w.y - 8, width: larguraTotal, height: alturaLinha, color: corFundo });
    let x = MARGIN;
    COLS_RESUMO.forEach((c, idx) => {
      const texto = String(valores[idx]);
      const font = idx === 0 ? fonteCol0 : fonteResto;
      const largura = font.widthOfTextAtSize(texto, size);
      const xFinal = c.alinhar === 'dir' ? x + c.w - 10 - largura : x + 10;
      w.page.drawText(texto, { x: xFinal, y: w.y, size, font, color: cores[idx] });
      x += c.w;
    });
    w.y -= alturaLinha;
  }

  linha(COLS_RESUMO.map(c => c.label), 9, negrito, negrito, COLS_RESUMO.map(() => AZUL), tintClaro(AZUL, 0.9));
  grupos.forEach((g, i) => {
    const valores = [g.prazo, g.total.total, g.total.aceitaram, g.total.pendentes, `${g.total.pct.toFixed(1)}%`];
    const cores = [rgb(0, 0, 0), rgb(0, 0, 0), VERDE_OK, g.total.pendentes > 0 ? VERMELHO_PENDENTE : VERDE_OK, corPorPct(g.total.pct)];
    linha(valores, 9.5, regular, negrito, cores, i % 2 === 1 ? rgb(0.97, 0.97, 0.97) : null);
  });
}

function numerarPaginas(pdfDoc, regular) {
  const paginas = pdfDoc.getPages();
  paginas.forEach((p, i) => {
    const texto = `${i + 1} / ${paginas.length}`;
    const tw = regular.widthOfTextAtSize(texto, 8.5);
    p.drawText(texto, { x: PAGE_W - MARGIN - tw, y: MARGIN - 28, size: 8.5, font: regular, color: rgb(0.6, 0.6, 0.6) });
  });
}

function dataHojeBr() {
  const h = new Date();
  return `${String(h.getDate()).padStart(2, '0')}/${String(h.getMonth() + 1).padStart(2, '0')}/${h.getFullYear()}`;
}

async function carregarLogo(pdfDoc) {
  try {
    const bytes = fs.readFileSync(path.join(__dirname, 'public', 'img', 'Logo Ceasa TI_transp.png'));
    return await pdfDoc.embedPng(bytes);
  } catch { return null; }
}

const COLS_CIDADE = [
  { label: 'Cidade', w: 160 }, { label: 'Total', w: 70 }, { label: 'Aceitaram', w: 90 },
  { label: 'Pendentes', w: 90 }, { label: '% Adesão', w: 73 },
];
const COLS_PENDENTES = [
  { label: 'Código', w: 60 }, { label: 'Concessionário', w: 220 },
  { label: 'CNPJ', w: 125 }, { label: 'CCU', w: 98 },
];

// dados: { importacao: {id, criado_em, nome_arquivo, total_linhas, nao_casados},
//          grupos: [{ prazo, cidades: [{cidade, total, aceitaram, pendentes, pct}],
//                     total: {total,aceitaram,pendentes,pct}, lista_pendentes:
//                     [{codigo, concessionario, cnpj, numero_ccu, cidade}] }] }
// — vem de montarRelatorioAdesao() em routes/secad-relatorios.js (mesma
// função monta os dados pra tela E pro PDF).
async function gerarPdfAdesaoRenovacao(dados, nomeGerador) {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const negrito = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const logoImg = await carregarLogo(pdfDoc);
  const w = new Escritor(pdfDoc, regular, negrito, logoImg);
  const subtituloPagina = 'Relatório de Adesão à Renovação';

  // ── Capa: números gerais (soma de todos os prazos/cidades do filtro ativo) ──
  const totalGeral = dados.grupos.reduce((acc, g) => ({
    total: acc.total + g.total.total, aceitaram: acc.aceitaram + g.total.aceitaram,
  }), { total: 0, aceitaram: 0 });
  const pendentesGeral = totalGeral.total - totalGeral.aceitaram;
  const pctGeral = totalGeral.total ? (totalGeral.aceitaram / totalGeral.total) * 100 : 0;

  w.novaPagina();
  w.cabecalho(subtituloPagina);
  w.titulo('Relatório de Adesão à Renovação — CEASA CONECTA', 16);
  w.page.drawRectangle({ x: MARGIN, y: w.y + 10, width: 46, height: 3, color: AZUL });
  w.espaco(6);
  w.paragrafo(`Gerado em ${dataHojeBr()} por ${nomeGerador}.`, 9);
  if (dados.importacao) {
    w.paragrafo(
      `Base: importação "${dados.importacao.nome_arquivo || '—'}" de ${dados.importacao.criado_em || '—'} ` +
      `(${dados.importacao.total_linhas} linha(s), ${dados.importacao.nao_casados} sem contrato correspondente).`,
      8.5, rgb(0.5, 0.5, 0.5));
  }
  w.espaco(12);
  desenharCardsCapa(w, negrito, regular, [
    { label: 'Total de contratos', valor: totalGeral.total },
    { label: 'Aceitaram', valor: totalGeral.aceitaram, cor: VERDE_OK },
    { label: 'Pendentes', valor: pendentesGeral, cor: pendentesGeral > 0 ? VERMELHO_PENDENTE : VERDE_OK },
    { label: '% Adesão geral', valor: `${pctGeral.toFixed(1)}%`, cor: corPorPct(pctGeral) },
  ]);

  // Reconciliação ("de onde vêm esses números") é só da TELA — o Alex foi
  // explícito: o PDF é o relatório executivo, não leva esse texto de
  // metodologia/auditoria. Ver `_relRenderReconciliacao` em
  // public/js/secad-relatorios.js pro equivalente na tela.

  // ── Resumo por prazo (visão geral antes do detalhe página a página) ──────
  w.espaco(16);
  w.subtitulo('Resumo por prazo final');
  desenharResumoPrazo(w, negrito, regular, dados.grupos);
  w.espaco(6);
  desenharLegendaFaixas(w, regular);

  // ── 1 página exclusiva por prazo — nunca começa no meio da anterior ──────
  dados.grupos.forEach(g => {
    w.novaPagina();
    w.cabecalho(subtituloPagina);
    w.subtitulo(g.prazo === 'Fora do prazo previsto' ? g.prazo : `Prazo final: ${g.prazo}`);
    const linhasCidade = g.cidades.map(c => ({
      valores: [c.cidade, c.total, c.aceitaram, c.pendentes, `${c.pct.toFixed(1)}%`],
      coresCol: [undefined, undefined, undefined, undefined, corPorPct(c.pct)],
    }));
    desenharTabela(w, negrito, regular, `${subtituloPagina} (continuação)`, COLS_CIDADE, linhasCidade);
    w.espaco(4);
    w.paragrafo(
      `Total do prazo: ${g.total.total} contrato(s) — ${g.total.aceitaram} aceitaram, ` +
      `${g.total.pendentes} pendente(s) (${g.total.pct.toFixed(1)}% de adesão).`,
      9.5);
    w.espaco(6);

    if (g.lista_pendentes.length) {
      w.garantirEspaco(30);
      w.paragrafo(g.prazo === 'Fora do prazo previsto' ? 'Concessionários pendentes (sem prazo previsto definido):' : `Concessionários pendentes (prazo ${g.prazo}):`, 9.5, VERMELHO_PENDENTE);
      // Sub-cabeçalho por cidade — lista_pendentes já vem ordenada
      // cidade→concessionário, só falta agrupar visualmente em blocos (sem
      // repetir a coluna Cidade — a largura liberada vai pro Concessionário).
      const blocosPorCidade = [];
      g.lista_pendentes.forEach(p => {
        const cidade = p.cidade || 'Sem cidade definida';
        let bloco = blocosPorCidade[blocosPorCidade.length - 1];
        if (!bloco || bloco.cidade !== cidade) { bloco = { cidade, itens: [] }; blocosPorCidade.push(bloco); }
        bloco.itens.push(p);
      });
      blocosPorCidade.forEach(bloco => {
        w.garantirEspaco(18);
        w.paragrafo(`${bloco.cidade} (${bloco.itens.length})`, 9.5, AZUL);
        const linhasPend = bloco.itens.map(p => ({ valores: [p.codigo, p.concessionario || '—', p.cnpj || '—', p.numero_ccu || '—'] }));
        desenharTabela(w, negrito, regular, `${subtituloPagina} (continuação)`, COLS_PENDENTES, linhasPend);
      });
    } else {
      w.paragrafo('Nenhum pendente — 100% de adesão neste prazo.', 9, VERDE_OK);
    }
  });

  w.page.drawText('CEASA CONECTA — Concessionários Renovação', { x: MARGIN, y: MARGIN - 28, size: 8.5, font: regular, color: rgb(0.6, 0.6, 0.6) });
  numerarPaginas(pdfDoc, regular);
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

module.exports = { gerarPdfAdesaoRenovacao };
