// ── Concessionários Cadastro: relatório de concessionários ──────────────────
// Mesmo padrão de pac-pdf.js/detin-pdf.js (pdf-lib, Escritor com cursor de
// página) — duplicado aqui de propósito (cada módulo tem o próprio arquivo
// de PDF, nenhum módulo compartilhado novo). Dado vem da sincronização do
// CeasaConecta-Gateway (ver secad-gateway-sync.js, tabela
// concessionario_cadastro em depop.db).
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_W = 595.28, PAGE_H = 841.89; // A4 em pontos (72dpi)
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;
const AZUL_CC = rgb(0x15 / 255, 0x65 / 255, 0xC0 / 255);
const VERDE_ATIVO = rgb(0x15 / 255, 0x80 / 255, 0x3D / 255);
const VERMELHO_INATIVO = rgb(0xC0 / 255, 0x39 / 255, 0x2B / 255);

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
    this.logoImg = logoImg || null;
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
      this.page.drawText('CEASAMINAS', { x: MARGIN, y: this.y, size: 16, font: this.negrito, color: AZUL_CC });
    }
    if (subtitulo) {
      const lw = this.negrito.widthOfTextAtSize(subtitulo, 10);
      this.page.drawText(subtitulo, { x: PAGE_W - MARGIN - lw, y: this.y - 6, size: 10, font: this.negrito, color: AZUL_CC });
    }
    this.y -= 42;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 1, color: rgb(0.75, 0.75, 0.75) });
    this.y -= 22;
  }
  titulo(texto, size = 13) {
    this.garantirEspaco(26);
    this.page.drawText(texto, { x: MARGIN, y: this.y, size, font: this.negrito, color: AZUL_CC });
    this.y -= size + 12;
  }
  subtitulo(texto, cor) {
    this.garantirEspaco(20);
    this.page.drawText(texto, { x: MARGIN, y: this.y, size: 11, font: this.negrito, color: cor || rgb(0, 0, 0) });
    this.y -= 17;
  }
  linha() {
    this.garantirEspaco(12);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.75, color: rgb(0.82, 0.82, 0.82) });
    this.y -= 12;
  }
  camposLinha(campos) {
    const size = 9.5;
    this.garantirEspaco(15);
    let x = MARGIN;
    campos.forEach(({ label, valor, cor }) => {
      this.page.drawText(label, { x, y: this.y, size, font: this.negrito });
      x += this.negrito.widthOfTextAtSize(label, size) + 3;
      this.page.drawText(String(valor), { x, y: this.y, size, font: this.regular, color: cor || rgb(0, 0, 0) });
      x += this.regular.widthOfTextAtSize(String(valor), size) + 18;
    });
    this.y -= 16;
  }
  paragrafo(texto, size = 10.5, cor) {
    const linhas = wrapText(texto, this.regular, size, CONTENT_W);
    linhas.forEach(l => {
      this.garantirEspaco(size + 4);
      this.page.drawText(l, { x: MARGIN, y: this.y, size, font: this.regular, color: cor || rgb(0, 0, 0) });
      this.y -= size + 4;
    });
    this.y -= 6;
  }
}

// Tabela com bolinha colorida na 1ª posição (verde/vermelho = ativo/inativo)
// — mesma técnica de detin-pdf.js.
function desenharTabela(w, negrito, regular, subtituloPagina, cols, linhas, dotW = 12) {
  function cabecalhoTabela() {
    w.garantirEspaco(20);
    let x = MARGIN + dotW;
    cols.forEach(c => { w.page.drawText(c.label, { x, y: w.y, size: 9, font: negrito, color: rgb(0.3, 0.3, 0.3) }); x += c.w; });
    w.y -= 14;
    w.linha();
  }
  cabecalhoTabela();
  linhas.forEach(linha => {
    if (w.y - 16 < MARGIN + 20) { w.novaPagina(); w.cabecalho(subtituloPagina); cabecalhoTabela(); }
    if (linha.cor) w.page.drawEllipse({ x: MARGIN + dotW / 2 - 2, y: w.y + 3, xScale: 3, yScale: 3, color: linha.cor });
    let x = MARGIN + dotW;
    cols.forEach((c, i) => {
      const texto = truncar(String(linha.valores[i] ?? '—'), regular, 8.5, c.w - 4);
      w.page.drawText(texto, { x, y: w.y, size: 8.5, font: regular });
      x += c.w;
    });
    w.y -= 15;
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

// ramos: [{ ramo, itens: [{codigo, numero_contrato, ativo (0/1), unidade,
// nome, fantasia, cnpj, cidade, ...}] }] — 1 item por CONTRATO (não por
// empresa: uma empresa com 2 contratos ativos aparece 2 vezes, cada linha
// com seu próprio status) — vem de linhasComUnidade() em
// routes/concessionarios-cadastro.js, mesma função que a tela de Pesquisar
// usa, pra tela e PDF nunca divergirem.
async function gerarPdfConcessionarios(ramos, filtrosTexto, nomeGerador) {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const negrito = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const logoImg = await carregarLogo(pdfDoc);
  const w = new Escritor(pdfDoc, regular, negrito, logoImg);
  const subtituloPagina = 'Concessionários Cadastro';

  w.novaPagina();
  w.cabecalho(subtituloPagina);
  w.titulo('Relatório de Concessionários — Cadastro');
  w.paragrafo(filtrosTexto ? `Filtros aplicados: ${filtrosTexto}` : 'Sem filtros — todos os concessionários.', 9.5);
  w.paragrafo(`Gerado em ${dataHojeBr()} por ${nomeGerador}.`, 9);

  const totalContratos = ramos.reduce((s, r) => s + r.itens.length, 0);
  const totalAtivos = ramos.reduce((s, r) => s + r.itens.filter(i => i.ativo === 1).length, 0);
  w.linha();
  w.camposLinha([
    { label: 'Total de contratos:', valor: totalContratos },
    { label: 'Ativos:', valor: totalAtivos, cor: VERDE_ATIVO },
    { label: 'Inativos:', valor: totalContratos - totalAtivos, cor: VERMELHO_INATIVO },
  ]);
  w.espaco(6);

  const COLS = [
    { label: 'Concessionário', w: 175 }, { label: 'CNPJ', w: 95 },
    { label: 'Unidade', w: 90 }, { label: 'Cidade', w: 90 }, { label: 'Contrato', w: 79 },
  ];
  ramos.forEach(r => {
    w.garantirEspaco(40);
    w.subtitulo(`${r.ramo} (${r.itens.length})`);
    const linhas = r.itens.map(i => ({
      cor: i.ativo === 1 ? VERDE_ATIVO : VERMELHO_INATIVO,
      valores: [
        i.fantasia || i.nome || '—', i.cnpj || '—',
        i.unidade, i.cidade || '—', i.numero_contrato || '—',
      ],
    }));
    desenharTabela(w, negrito, regular, subtituloPagina, COLS, linhas);
    w.espaco(6);
  });

  w.page.drawText('Concessionários Cadastro. Verde = ativo, vermelho = inativo.', {
    x: MARGIN, y: MARGIN - 28, size: 8.5, font: regular, color: rgb(0.6, 0.6, 0.6),
  });
  numerarPaginas(pdfDoc, regular);
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

module.exports = { gerarPdfConcessionarios };
