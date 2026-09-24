// ── PAC: PDF do Relatório de Orçamento do DFD ───────────────────────────────
// Mesmo padrão de detin-pdf.js/secad-pdf.js (pdf-lib, Escritor com cursor de
// página) — duplicado aqui de propósito (cada módulo tem o próprio arquivo
// de PDF, nenhum módulo compartilhado novo). Pedido do Alex, 2026-09-24:
// "relatorio proprio para analise com todo detalhamento... com possibilidade
// de gerar ate pdf" — 1 seção por Natureza (Orçado/Consumido/Saldo/% + itens
// que compõem o valor), incluindo naturezas SEM nenhum gasto ainda (relatório
// completo, não só o que tem consumo).
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_W = 595.28, PAGE_H = 841.89; // A4 em pontos (72dpi)
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;
const AZUL_PAC = rgb(0x1A / 255, 0x3F / 255, 0x6B / 255);
const VERDE_OK = rgb(0x15 / 255, 0x80 / 255, 0x3D / 255);
const VERMELHO_ESTOUROU = rgb(0xC0 / 255, 0x39 / 255, 0x2B / 255);

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
  if (font.widthOfTextAtSize(texto, size) <= maxWidth) return texto;
  let t = texto;
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
      this.page.drawText('CEASAMINAS', { x: MARGIN, y: this.y, size: 16, font: this.negrito, color: AZUL_PAC });
    }
    if (subtitulo) {
      const larguraSub = this.negrito.widthOfTextAtSize(subtitulo, 10);
      this.page.drawText(subtitulo, { x: PAGE_W - MARGIN - larguraSub, y: this.y - 6, size: 10, font: this.negrito, color: AZUL_PAC });
    }
    this.y -= 42;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 1, color: rgb(0.75, 0.75, 0.75) });
    this.y -= 22;
  }
  titulo(texto, size = 13) {
    this.garantirEspaco(26);
    this.page.drawText(texto, { x: MARGIN, y: this.y, size, font: this.negrito, color: AZUL_PAC });
    this.y -= size + 12;
  }
  subtitulo(texto, cor) {
    this.garantirEspaco(20);
    this.page.drawText(texto, { x: MARGIN, y: this.y, size: 11.5, font: this.negrito, color: cor || rgb(0, 0, 0) });
    this.y -= 18;
  }
  campo(label, valor, cor) {
    const size = 10;
    this.garantirEspaco(15);
    this.page.drawText(label, { x: MARGIN, y: this.y, size, font: this.negrito });
    const lw = this.negrito.widthOfTextAtSize(label + ' ', size);
    this.page.drawText(String(valor ?? '—'), { x: MARGIN + lw, y: this.y, size, font: this.regular, color: cor || rgb(0, 0, 0) });
    this.y -= 15;
  }
  // Vários campos numa linha só (Orçado | Consumido | Saldo | %) — cabe mais
  // informação por natureza sem gastar 4 linhas cada.
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
  linha() {
    this.garantirEspaco(14);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.75, color: rgb(0.82, 0.82, 0.82) });
    this.y -= 14;
  }
}

// Tabela simples (cabeçalho em negrito + linhas), reaproveitada por natureza
// (Setor/Nº PAC/Descrição/Valor).
function desenharTabela(w, negrito, regular, subtitulo, cols, linhas) {
  function cabecalhoTabela() {
    w.garantirEspaco(20);
    let x = MARGIN;
    cols.forEach(c => { w.page.drawText(c.label, { x, y: w.y, size: 9, font: negrito, color: rgb(0.3, 0.3, 0.3) }); x += c.w; });
    w.y -= 14;
    w.linha();
  }
  cabecalhoTabela();
  linhas.forEach(linha => {
    if (w.y - 16 < MARGIN + 20) { w.novaPagina(); w.cabecalho(subtitulo); cabecalhoTabela(); }
    let x = MARGIN;
    cols.forEach((c, i) => {
      const texto = truncar(String(linha.valores[i]), regular, 8.5, c.w - 4);
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
function fmtMoeda(v) {
  return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function codigoDfd(dfd) {
  return `DFD-${String(dfd.id).padStart(3, '0')}-${dfd.ano_base}`;
}

async function carregarLogo(pdfDoc) {
  try {
    const bytes = fs.readFileSync(path.join(__dirname, 'public', 'img', 'Logo Ceasa TI_transp.png'));
    return await pdfDoc.embedPng(bytes);
  } catch { return null; }
}

// dados: { dfd: {id, titulo, ano_base}, orcamento_nome, naturezas: [{natureza,
// valor_orcado, valor_usado, saldo, itens: [{setor_nome, numero_pac,
// codigo_pac, descricao, valor}]}] } — vem de montarRelatorioOrcamentoDfd()
// em routes/pac.js (mesma função monta os dados pra tela E pro PDF).
async function gerarPdfOrcamentoDfd(dados, nomeGerador) {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const negrito = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const logoImg = await carregarLogo(pdfDoc);
  const w = new Escritor(pdfDoc, regular, negrito, logoImg);
  const subtituloPagina = `Orçamento — ${codigoDfd(dados.dfd)}`;

  w.novaPagina();
  w.cabecalho(subtituloPagina);
  w.titulo(`Relatório de Orçamento — ${codigoDfd(dados.dfd)} — ${dados.dfd.titulo}`);
  w.paragrafo(`Orçamento: ${dados.orcamento_nome || '—'}`, 10);
  w.paragrafo(`Gerado em ${dataHojeBr()} por ${nomeGerador}.`, 9);
  w.espaco(4);

  const totalOrcado = dados.naturezas.reduce((s, n) => s + (Number(n.valor_orcado) || 0), 0);
  const totalUsado = dados.naturezas.reduce((s, n) => s + (Number(n.valor_usado) || 0), 0);
  const saldoGeral = totalOrcado - totalUsado;
  w.linha();
  w.camposLinha([
    { label: 'Total Orçado:', valor: fmtMoeda(totalOrcado) },
    { label: 'Total Consumido:', valor: fmtMoeda(totalUsado) },
    { label: 'Saldo Geral:', valor: fmtMoeda(saldoGeral), cor: saldoGeral >= 0 ? VERDE_OK : VERMELHO_ESTOUROU },
  ]);
  w.espaco(10);

  const COLS = [
    { label: 'Setor', w: 90 }, { label: 'Nº PAC', w: 55 }, { label: 'Descrição', w: 290 }, { label: 'Valor', w: 79 },
  ];
  dados.naturezas.forEach(n => {
    w.garantirEspaco(60);
    const estourou = n.saldo < 0;
    const pct = n.valor_orcado > 0 ? (n.valor_usado / n.valor_orcado) * 100 : (n.valor_usado > 0 ? Infinity : 0);
    w.subtitulo(n.natureza, estourou ? VERMELHO_ESTOUROU : undefined);
    w.camposLinha([
      { label: 'Orçado:', valor: fmtMoeda(n.valor_orcado) },
      { label: 'Consumido:', valor: fmtMoeda(n.valor_usado) },
      { label: 'Saldo:', valor: fmtMoeda(n.saldo), cor: estourou ? VERMELHO_ESTOUROU : VERDE_OK },
      { label: '% usado:', valor: pct === Infinity ? '—' : `${pct.toFixed(1)}%` },
    ]);
    if (n.itens.length) {
      const linhas = n.itens.map(i => ({
        valores: [i.setor_nome, i.numero_pac ?? '—', i.descricao || '—', fmtMoeda(i.valor)],
      }));
      desenharTabela(w, negrito, regular, `${subtituloPagina} (continuação)`, COLS, linhas);
    } else {
      w.paragrafo('Nenhum item lançado com esta natureza neste DFD.', 9, rgb(0.5, 0.5, 0.5));
    }
    w.linha();
  });

  w.page.drawText('PAC — Departamento de Planejamento (DEPLA)', { x: MARGIN, y: MARGIN - 28, size: 8.5, font: regular, color: rgb(0.6, 0.6, 0.6) });
  numerarPaginas(pdfDoc, regular);
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

module.exports = { gerarPdfOrcamentoDfd };
