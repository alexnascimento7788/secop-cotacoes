// ── DETIN: PDF de Análise de Contratos ──────────────────────────────────────
// Mesmo padrão de secad-pdf.js (pdf-lib, Escritor com cursor de página) —
// aqui com logo raster embutida (secad-pdf.js não tinha por não precisar).
// 1 PDF por análise: capa → 1+ página(s) por contrato (dados + as 5
// perguntas/respostas) → página de encerramento com espaço de assinatura.
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_W = 595.28, PAGE_H = 841.89; // A4 em pontos (72dpi)
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;
const AZUL_DETIN = rgb(0x1A / 255, 0x3F / 255, 0x6B / 255);

function wrapText(texto, font, size, maxWidth) {
  const palavras = String(texto || '').split(/\s+/).filter(Boolean);
  const linhas = [];
  let atual = '';
  for (const p of palavras) {
    const tentativa = atual ? `${atual} ${p}` : p;
    if (atual && font.widthOfTextAtSize(tentativa, size) > maxWidth) {
      linhas.push(atual);
      atual = p;
    } else {
      atual = tentativa;
    }
  }
  if (atual) linhas.push(atual);
  return linhas;
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
      this.page.drawText('CEASAMINAS', { x: MARGIN, y: this.y, size: 16, font: this.negrito, color: AZUL_DETIN });
    }
    if (subtitulo) {
      const larguraSub = this.negrito.widthOfTextAtSize(subtitulo, 10);
      this.page.drawText(subtitulo, { x: PAGE_W - MARGIN - larguraSub, y: this.y - 6, size: 10, font: this.negrito, color: AZUL_DETIN });
    }
    this.y -= 42;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 1, color: rgb(0.75, 0.75, 0.75) });
    this.y -= 22;
  }
  titulo(texto, size = 13) {
    this.garantirEspaco(26);
    this.page.drawText(texto, { x: MARGIN, y: this.y, size, font: this.negrito, color: AZUL_DETIN });
    this.y -= size + 12;
  }
  subtitulo(texto) {
    this.garantirEspaco(20);
    this.page.drawText(texto, { x: MARGIN, y: this.y, size: 11, font: this.negrito });
    this.y -= 20;
  }
  campo(label, valor) {
    const size = 10;
    this.garantirEspaco(15);
    this.page.drawText(label, { x: MARGIN, y: this.y, size, font: this.negrito });
    const lw = this.negrito.widthOfTextAtSize(label + ' ', size);
    const texto = String(valor ?? '—');
    if (this.regular.widthOfTextAtSize(texto, size) <= CONTENT_W - lw) {
      this.page.drawText(texto, { x: MARGIN + lw, y: this.y, size, font: this.regular });
      this.y -= 15;
    } else {
      this.y -= 15;
      const linhas = wrapText(texto, this.regular, size, CONTENT_W - lw);
      linhas.forEach(l => {
        this.garantirEspaco(size + 4);
        this.page.drawText(l, { x: MARGIN + lw, y: this.y, size, font: this.regular });
        this.y -= size + 4;
      });
    }
  }
  paragrafo(texto, size = 10.5) {
    const linhas = wrapText(texto, this.regular, size, CONTENT_W);
    linhas.forEach(l => {
      this.garantirEspaco(size + 4);
      this.page.drawText(l, { x: MARGIN, y: this.y, size, font: this.regular });
      this.y -= size + 4;
    });
    this.y -= 6;
  }
  linha() {
    this.garantirEspaco(14);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.75, color: rgb(0.82, 0.82, 0.82) });
    this.y -= 14;
  }
}

function truncar(texto, font, size, maxWidth) {
  if (font.widthOfTextAtSize(texto, size) <= maxWidth) return texto;
  let t = texto;
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

function numerarPaginas(pdfDoc, regular) {
  const paginas = pdfDoc.getPages();
  paginas.forEach((p, i) => {
    const texto = `${i + 1} / ${paginas.length}`;
    const tw = regular.widthOfTextAtSize(texto, 8.5);
    p.drawText(texto, { x: PAGE_W - MARGIN - tw, y: MARGIN - 28, size: 8.5, font: regular, color: rgb(0.6, 0.6, 0.6) });
  });
}

// Tabela simples (cabeçalho em negrito + linhas), com bolinha de farol
// opcional antes da 1ª coluna — reaproveitada pelos relatórios de Lista e
// de Vencimentos. `linhas` = [{ cor?, valores: [...] }].
function desenharTabela(w, negrito, regular, subtitulo, cols, linhas, dotW = 12) {
  function cabecalhoTabela() {
    w.garantirEspaco(20);
    let x = MARGIN + dotW;
    cols.forEach(c => { w.page.drawText(c.label, { x, y: w.y, size: 9, font: negrito, color: rgb(0.3, 0.3, 0.3) }); x += c.w; });
    w.y -= 14;
    w.linha();
  }
  cabecalhoTabela();
  linhas.forEach(linha => {
    if (w.y - 16 < MARGIN + 20) { w.novaPagina(); w.cabecalho(subtitulo); cabecalhoTabela(); }
    if (linha.cor) w.page.drawEllipse({ x: MARGIN + dotW / 2 - 2, y: w.y + 3, xScale: 3, yScale: 3, color: linha.cor });
    let x = MARGIN + dotW;
    cols.forEach((c, i) => {
      const texto = truncar(String(linha.valores[i]), regular, 8.5, c.w - 4);
      w.page.drawText(texto, { x, y: w.y, size: 8.5, font: regular });
      x += c.w;
    });
    w.y -= 15;
  });
}

function dataHojeBr() {
  const h = new Date();
  return `${String(h.getDate()).padStart(2, '0')}/${String(h.getMonth() + 1).padStart(2, '0')}/${h.getFullYear()}`;
}
function fmtBrData(iso) {
  if (!iso) return '—';
  const d = String(iso).split(/[T ]/)[0].split('-');
  return d.length < 3 ? '—' : `${d[2]}/${d[1]}/${d[0]}`;
}
function fmtMoeda(v) {
  if (v === null || v === undefined) return '—';
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const LABEL_RENOVACAO = { renovacao: 'Renovação', nova_licitacao: 'Nova Licitação', extincao: 'Extinção do Serviço' };
const LABEL_TIPO = { servico_continuado: 'Serviço contínuo', licenca: 'Licença', locacao: 'Locação', pagamento_unico: 'Pagamento único' };
const LABEL_STATUS = { ativo: 'Ativo', em_renovacao: 'Em renovação', encerrado: 'Encerrado', cancelado: 'Cancelado' };
const LABEL_ADITIVO = { prazo: 'Prazo', valor: 'Valor', objeto: 'Objeto', rescisao: 'Rescisão' };

// Mesma paleta cíclica de public/js/detin-painel.js (duplicada — convenção do
// projeto, sem módulo compartilhado entre back-end e front-end).
const PALETA_FORNECEDOR_HEX = ['#1A3F6B', '#2A5A94', '#5B8FC7', '#8FB3DA', '#C97A00', '#E08E00', '#1A6B35', '#2E8B47', '#9333ea', '#c0392b'];
function corRgb(hex) {
  const h = hex.replace('#', '');
  return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
}
// Mesmo farol de 5 níveis usado na "fila de ação" do painel (detin-painel.js)
// — os relatórios de lista/vencimentos espelham essa granularidade fina.
function farolInfo(dias) {
  if (dias == null) return rgb(0.61, 0.64, 0.69);
  if (dias < 0) return corRgb('#c0392b');
  if (dias <= 15) return corRgb('#d97706');
  if (dias <= 30) return corRgb('#eab308');
  if (dias <= 60) return corRgb('#16a34a');
  return rgb(0.61, 0.64, 0.69);
}

async function carregarLogo(pdfDoc) {
  try {
    const bytes = fs.readFileSync(path.join(__dirname, 'public', 'img', 'Logo Ceasa TI_transp.png'));
    return await pdfDoc.embedPng(bytes);
  } catch { return null; }
}

// analise: { id, titulo, criado_em, contratos: [{ contrato_id, numero_contrato,
// fornecedor, objeto, data_vencimento, valor_mensal, valor_mensal_efetivo,
// resp_* }] } — vem de analiseCompleta() em routes/detin.js.
async function gerarPdfAnalise(analise, nomeGerador) {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const negrito = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const logoImg = await carregarLogo(pdfDoc);
  const w = new Escritor(pdfDoc, regular, negrito, logoImg);

  // ── 1ª página: Financeiro por Fornecedor (pedido do Alex, 2026-09-17) —
  // mesmo bloco do relatório "Financeiro por Fornecedor" da tela de
  // Contratos, mas escopado só aos contratos DESTA análise (não o portfólio
  // inteiro), pra dar contexto financeiro antes de entrar nas perguntas.
  const dadosFinanceiros = agregarFinanceiro(analise.contratos);
  w.novaPagina();
  w.cabecalho('Financeiro por Fornecedor');
  w.titulo('Financeiro por Fornecedor — Contratos desta Análise');
  w.paragrafo(`Resumo financeiro dos ${analise.contratos.length} contrato(s) incluídos em "${analise.titulo}".`, 9.5);
  w.espaco(6);
  desenharConteudoFinanceiro(w, negrito, regular, dadosFinanceiros);

  // ── Capa ──
  w.novaPagina();
  if (logoImg) {
    const escala = 90 / logoImg.width;
    w.page.drawImage(logoImg, { x: (PAGE_W - 90) / 2, y: PAGE_H - 180, width: 90, height: logoImg.height * escala });
    w.y = PAGE_H - 220;
  } else {
    w.y = PAGE_H - 180;
  }
  const tituloCapa = `Análise de Contratos`;
  const twCapa = negrito.widthOfTextAtSize(tituloCapa, 20);
  w.page.drawText(tituloCapa, { x: (PAGE_W - twCapa) / 2, y: w.y, size: 20, font: negrito, color: AZUL_DETIN });
  w.y -= 30;
  const subCapa = analise.titulo;
  const twSub = regular.widthOfTextAtSize(subCapa, 13);
  w.page.drawText(subCapa, { x: (PAGE_W - twSub) / 2, y: w.y, size: 13, font: regular });
  w.y -= 60;
  [`Data de geração: ${dataHojeBr()}`, `Gerado por: ${nomeGerador}`, `DETIN — Departamento de Tecnologia da Informação`].forEach(l => {
    const tw = regular.widthOfTextAtSize(l, 11);
    w.page.drawText(l, { x: (PAGE_W - tw) / 2, y: w.y, size: 11, font: regular, color: rgb(0.35, 0.35, 0.35) });
    w.y -= 18;
  });

  // ── 1 página por contrato ──
  analise.contratos.forEach(c => {
    w.novaPagina();
    w.cabecalho(`Contrato ${c.numero_contrato || 'S/N'} — ${c.fornecedor}`);
    w.titulo('Dados do Contrato');
    w.campo('1. Número do Contrato:', c.numero_contrato || 'Sem número (serviço informal)');
    w.campo('2. Fornecedor:', c.fornecedor);
    w.campo('3. Vigência:', c.data_vencimento ? `até ${fmtBrData(c.data_vencimento)}` : 'Não estipulada no contrato');
    w.espaco(4);
    w.campo('4. Objeto:', c.objeto || '—');
    w.espaco(6);
    const valorMensalEfetivo = c.valor_mensal_efetivo != null ? c.valor_mensal_efetivo : c.valor_mensal;
    w.campo('5. Valor Mensal:', fmtMoeda(valorMensalEfetivo));
    if (c.valor_mensal_efetivo != null && c.valor_mensal != null && c.valor_mensal_efetivo !== c.valor_mensal) {
      w.campo('   Valor contratual (referência):', fmtMoeda(c.valor_mensal));
    }
    w.espaco(10);
    w.linha();
    w.titulo('Análise');
    w.campo('1. É viável uma redução linear do contrato?', '');
    w.paragrafo(c.resp_reducao_linear || '(não respondido)');
    w.campo('2. Existe necessidade de alteração no objeto/termos?', '');
    w.paragrafo(c.resp_alteracao_objeto || '(não respondido)');
    w.campo('3. Renovação, nova licitação ou extinção?', LABEL_RENOVACAO[c.resp_renovacao] || '(não respondido)');
    w.espaco(4);
    w.campo('4. Sugestão para manutenção com redução de custo?', '');
    w.paragrafo(c.resp_sugestao_reducao || '(não respondido)');
    w.campo('5. Existe contrato com objeto similar?', c.resp_contrato_similar || 'Não');
    if (c.observacoes) {
      w.espaco(4);
      w.campo('Observações:', '');
      w.paragrafo(c.observacoes);
    }
  });

  // ── Encerramento ──
  w.novaPagina();
  w.y = PAGE_H / 2 + 100;
  w.paragrafo('Este relatório consolida a análise dos contratos listados, elaborada pelo DETIN — Departamento de Tecnologia da Informação, para subsidiar decisões de renovação, alteração ou extinção de contratos vigentes.', 11);
  w.espaco(40);
  w.paragrafo(`Contagem/MG, ${dataHojeBr()}.`, 11);
  w.espaco(60);
  w.page.drawLine({ start: { x: MARGIN, y: w.y }, end: { x: MARGIN + 260, y: w.y }, thickness: 1, color: rgb(0.4, 0.4, 0.4) });
  w.espaco(14);
  w.page.drawText(nomeGerador, { x: MARGIN, y: w.y, size: 10.5, font: negrito });
  w.espaco(14);
  w.page.drawText('DETIN — Departamento de Tecnologia da Informação', { x: MARGIN, y: w.y, size: 9.5, font: regular, color: rgb(0.4, 0.4, 0.4) });

  numerarPaginas(pdfDoc, regular);
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

// ── Relatório: Lista de Contratos ───────────────────────────────────────────
async function gerarPdfListaContratos(contratos, filtrosTexto, nomeGerador) {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const negrito = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const logoImg = await carregarLogo(pdfDoc);
  const w = new Escritor(pdfDoc, regular, negrito, logoImg);

  w.novaPagina();
  w.cabecalho('Lista de Contratos');
  w.titulo('Lista de Contratos');
  w.paragrafo(filtrosTexto ? `Filtros aplicados: ${filtrosTexto}` : 'Sem filtros — todos os contratos.', 9.5);
  w.paragrafo(`Gerado em ${dataHojeBr()} por ${nomeGerador}.`, 9);
  w.espaco(2);

  const COLS = [
    { label: 'Nº', w: 60 }, { label: 'Fornecedor', w: 100 }, { label: 'Tipo', w: 85 },
    { label: 'Vencimento', w: 62 }, { label: 'Valor Mensal', w: 85 }, { label: 'Status', w: 79 },
  ];
  let somaValorMensal = 0;
  const linhas = contratos.map(c => {
    const valorMensal = c.valor_mensal_efetivo != null ? c.valor_mensal_efetivo : c.valor_mensal;
    somaValorMensal += valorMensal || 0;
    return {
      cor: farolInfo(c.dias_restantes),
      valores: [
        c.numero_contrato || 'S/N', c.fornecedor, LABEL_TIPO[c.tipo] || c.tipo || '—',
        c.data_vencimento ? fmtBrData(c.data_vencimento) : '—',
        valorMensal != null ? fmtMoeda(valorMensal) : '—', LABEL_STATUS[c.status] || c.status || '—',
      ],
    };
  });
  desenharTabela(w, negrito, regular, 'Lista de Contratos (continuação)', COLS, linhas);

  w.espaco(8);
  w.linha();
  w.campo('Total de contratos:', String(contratos.length));
  w.campo('Soma do valor mensal (contratos listados):', fmtMoeda(somaValorMensal));

  numerarPaginas(pdfDoc, regular);
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

// ── Relatório: Vencimentos ───────────────────────────────────────────────────
async function gerarPdfVencimentos(alertas, dias, nomeGerador) {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const negrito = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const logoImg = await carregarLogo(pdfDoc);
  const w = new Escritor(pdfDoc, regular, negrito, logoImg);

  w.novaPagina();
  w.cabecalho('Relatório de Vencimentos');
  w.titulo('Relatório de Vencimentos');
  w.paragrafo(`Contratos vencidos ou com vencimento em até ${dias} dias, ordenados por urgência.`, 9.5);
  w.paragrafo(`Gerado em ${dataHojeBr()} por ${nomeGerador}.`, 9);
  w.espaco(2);

  const COLS = [
    { label: 'Nº', w: 50 }, { label: 'Fornecedor', w: 95 }, { label: 'Objeto', w: 150 },
    { label: 'Dias', w: 55 }, { label: 'Vencimento', w: 71 },
  ];
  const linhas = alertas.map(c => ({
    cor: farolInfo(c.dias_restantes),
    valores: [
      c.numero_contrato || 'S/N', c.fornecedor, c.objeto || '—',
      c.dias_restantes < 0 ? `Venceu há ${-c.dias_restantes}d` : c.dias_restantes === 0 ? 'Vence hoje' : `${c.dias_restantes} dia(s)`,
      fmtBrData(c.data_vencimento),
    ],
  }));
  if (!linhas.length) {
    w.paragrafo('Nenhum contrato dentro da janela informada.', 10.5);
  } else {
    desenharTabela(w, negrito, regular, 'Relatório de Vencimentos (continuação)', COLS, linhas);
  }

  numerarPaginas(pdfDoc, regular);
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

// ── Financeiro por Fornecedor: conteúdo compartilhado ────────────────────────
// Extraído pra ser reaproveitado como 1ª página do PDF de Análise (pedido do
// Alex, 2026-09-17) — o mesmo bloco (KPIs + termômetro + top fornecedores +
// distribuição por tipo), só muda quem monta a página/cabeçalho ao redor.
function desenharConteudoFinanceiro(w, negrito, regular, dados) {
  const kpis = [
    ['Contratos', String(dados.total_ativos)],
    ['Comprometido por mês', fmtMoeda(dados.valor_mensal_total)],
    ['Projeção anual', fmtMoeda(dados.valor_anual_projetado)],
  ];
  const kpiW = CONTENT_W / 3;
  kpis.forEach(([label, valor], i) => {
    const x = MARGIN + i * kpiW;
    w.page.drawText(valor, { x, y: w.y, size: 16, font: negrito, color: AZUL_DETIN });
    w.page.drawText(label, { x, y: w.y - 15, size: 9, font: regular, color: rgb(0.4, 0.4, 0.4) });
  });
  w.espaco(38);
  w.linha();

  const fornecedores = dados.contratos_por_fornecedor || [];
  const totalValor = fornecedores.reduce((s, f) => s + f.valor_mensal, 0) || 1;

  w.titulo('Distribuição do valor mensal por fornecedor', 12);
  if (!fornecedores.length) {
    w.paragrafo('Nenhum contrato com valor mensal cadastrado.', 10.5);
  } else {
    w.garantirEspaco(24);
    const barH = 20;
    let x = MARGIN;
    fornecedores.forEach((f, i) => {
      const larg = Math.max((f.valor_mensal / totalValor) * CONTENT_W, 2);
      w.page.drawRectangle({ x, y: w.y - barH, width: larg, height: barH, color: corRgb(PALETA_FORNECEDOR_HEX[i % PALETA_FORNECEDOR_HEX.length]) });
      x += larg;
    });
    w.espaco(barH + 14);

    fornecedores.forEach((f, i) => {
      w.garantirEspaco(14);
      const cor = corRgb(PALETA_FORNECEDOR_HEX[i % PALETA_FORNECEDOR_HEX.length]);
      w.page.drawRectangle({ x: MARGIN, y: w.y - 8, width: 9, height: 9, color: cor });
      const pct = ((f.valor_mensal / totalValor) * 100).toFixed(1);
      w.page.drawText(`${f.fornecedor} — ${fmtMoeda(f.valor_mensal)}/mês (${pct}%, ${f.total} contrato(s))`, { x: MARGIN + 14, y: w.y, size: 9.5, font: regular });
      w.y -= 15;
    });

    w.espaco(10);
    w.linha();
    w.titulo('Top fornecedores por valor mensal', 12);
    const top = [...fornecedores].sort((a, b) => b.valor_mensal - a.valor_mensal).slice(0, 8);
    const maxTop = Math.max(...top.map(f => f.valor_mensal), 1);
    const labelW = 130, valW = 80, trackW = CONTENT_W - labelW - valW - 8;
    top.forEach((f, i) => {
      w.garantirEspaco(16);
      w.page.drawText(truncar(f.fornecedor, regular, 9, labelW - 4), { x: MARGIN, y: w.y, size: 9, font: regular });
      const largBarra = Math.max((f.valor_mensal / maxTop) * trackW, 2);
      w.page.drawRectangle({ x: MARGIN + labelW, y: w.y - 2, width: trackW, height: 9, color: rgb(0.9, 0.9, 0.9) });
      w.page.drawRectangle({ x: MARGIN + labelW, y: w.y - 2, width: largBarra, height: 9, color: corRgb(PALETA_FORNECEDOR_HEX[i % PALETA_FORNECEDOR_HEX.length]) });
      w.page.drawText(fmtMoeda(f.valor_mensal), { x: MARGIN + labelW + trackW + 8, y: w.y, size: 8.5, font: negrito });
      w.y -= 16;
    });
  }

  w.espaco(10);
  w.linha();
  w.titulo('Distribuição por tipo de contrato', 12);
  const porTipo = dados.contratos_por_tipo || [];
  if (!porTipo.length) w.paragrafo('Sem dados.', 10.5);
  else porTipo.forEach(t => w.campo(`${LABEL_TIPO[t.tipo] || t.tipo}:`, `${t.total} contrato(s)`));
}

// Agrega fornecedor/tipo a partir de uma lista de contratos (usado tanto
// pelo relatório financeiro do sistema todo quanto, com o subconjunto de
// `analise.contratos`, como 1ª página do PDF de Análise).
function agregarFinanceiro(contratos) {
  const porFornecedor = {};
  const porTipo = {};
  let valorMensalTotal = 0;
  contratos.forEach(c => {
    const vm = (c.valor_mensal_efetivo != null ? c.valor_mensal_efetivo : c.valor_mensal) || 0;
    valorMensalTotal += vm;
    porFornecedor[c.fornecedor] ??= { fornecedor: c.fornecedor, total: 0, valor_mensal: 0 };
    porFornecedor[c.fornecedor].total++;
    porFornecedor[c.fornecedor].valor_mensal += vm;
    if (c.tipo) porTipo[c.tipo] = (porTipo[c.tipo] || 0) + 1;
  });
  return {
    total_ativos: contratos.length,
    valor_mensal_total: valorMensalTotal,
    valor_anual_projetado: valorMensalTotal * 12,
    contratos_por_fornecedor: Object.values(porFornecedor).sort((a, b) => b.valor_mensal - a.valor_mensal),
    contratos_por_tipo: Object.entries(porTipo).map(([tipo, total]) => ({ tipo, total })),
  };
}

// ── Relatório: Financeiro por Fornecedor ─────────────────────────────────────
// Visual (pedido do Alex: "parecido com a página inicial, com indicadores") —
// espelha o termômetro + barras horizontais do painel, desenhados com
// primitivas do pdf-lib em vez de SVG.
async function gerarPdfFinanceiroFornecedor(dados, nomeGerador) {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const negrito = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const logoImg = await carregarLogo(pdfDoc);
  const w = new Escritor(pdfDoc, regular, negrito, logoImg);

  w.novaPagina();
  w.cabecalho('Relatório Financeiro');
  w.titulo('Relatório Financeiro por Fornecedor');
  w.paragrafo(`Gerado em ${dataHojeBr()} por ${nomeGerador}.`, 9.5);
  w.espaco(6);
  desenharConteudoFinanceiro(w, negrito, regular, dados);

  numerarPaginas(pdfDoc, regular);
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

// ── Relatório: Ficha individual do contrato ──────────────────────────────────
async function gerarPdfFichaContrato(c, aditivos, nomeGerador) {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const negrito = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const logoImg = await carregarLogo(pdfDoc);
  const w = new Escritor(pdfDoc, regular, negrito, logoImg);

  w.novaPagina();
  w.cabecalho(`Contrato ${c.numero_contrato || 'S/N'}`);
  w.titulo('Ficha do Contrato');
  w.campo('Número do Contrato:', c.numero_contrato || 'Sem número (serviço informal)');
  w.campo('Fornecedor:', c.fornecedor);
  w.campo('Setor:', c.setor_nome || '—');
  w.campo('Responsável:', c.responsavel_nome || '—');
  w.campo('Tipo:', LABEL_TIPO[c.tipo] || c.tipo || '—');
  w.campo('Modalidade:', c.modalidade || '—');
  w.campo('Nº SEI:', c.numero_sei || '—');
  w.campo('Status:', LABEL_STATUS[c.status] || c.status || '—');
  w.campo('Permite renovação:', c.permite_renovacao || '—');

  w.espaco(6);
  w.linha();
  w.titulo('Vigência', 12);
  w.campo('Data de assinatura:', fmtBrData(c.data_assinatura));
  w.campo('Data de início:', fmtBrData(c.data_inicio));
  const vencTxt = c.data_vencimento
    ? `${fmtBrData(c.data_vencimento)} (${c.dias_restantes == null ? '—' : c.dias_restantes < 0 ? 'vencido há ' + (-c.dias_restantes) + ' dia(s)' : c.dias_restantes + ' dia(s) restante(s)'})`
    : 'Não estipulada no contrato';
  w.campo('Data de vencimento:', vencTxt);

  w.espaco(6);
  w.linha();
  w.titulo('Financeiro', 12);
  w.campo('Valor global:', fmtMoeda(c.valor_global));
  w.campo('Valor anual:', fmtMoeda(c.valor_anual));
  w.campo('Valor mensal (contratual):', fmtMoeda(c.valor_mensal));
  if (c.valor_mensal_efetivo != null) w.campo('Valor mensal efetivo:', fmtMoeda(c.valor_mensal_efetivo));
  w.campo('Frequência de pagamento:', c.frequencia_pagamento || '—');
  if (c.observacao_financeira) { w.espaco(2); w.campo('Observação financeira:', ''); w.paragrafo(c.observacao_financeira); }

  w.espaco(6);
  w.linha();
  w.titulo('Objeto', 12);
  w.paragrafo(c.objeto || '—');
  if (c.itens) { w.espaco(2); w.campo('Itens:', ''); w.paragrafo(c.itens); }
  if (c.observacoes) { w.espaco(4); w.campo('Observações:', ''); w.paragrafo(c.observacoes); }

  if (aditivos.length) {
    w.espaco(6);
    w.linha();
    w.titulo('Aditivos', 12);
    aditivos.forEach(a => {
      w.garantirEspaco(30);
      w.subtitulo(`${a.numero_aditivo || 'Aditivo'} — ${fmtBrData(a.data)} (${LABEL_ADITIVO[a.tipo] || a.tipo})`);
      if (a.descricao) w.paragrafo(a.descricao, 9.5);
      if (a.novo_valor_mensal) w.campo('Novo valor mensal:', fmtMoeda(a.novo_valor_mensal));
      if (a.nova_data_vencimento) w.campo('Nova data de vencimento:', fmtBrData(a.nova_data_vencimento));
      w.espaco(2);
    });
  }

  w.espaco(10);
  w.linha();
  w.paragrafo(`Ficha gerada em ${dataHojeBr()} por ${nomeGerador}.`, 9);

  numerarPaginas(pdfDoc, regular);
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

module.exports = { gerarPdfAnalise, gerarPdfListaContratos, gerarPdfVencimentos, gerarPdfFinanceiroFornecedor, gerarPdfFichaContrato };
