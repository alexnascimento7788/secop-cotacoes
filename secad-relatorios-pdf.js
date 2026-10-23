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
// desenharTabela em admin-pdf.js/pac-pdf.js.
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
      w.page.drawText(texto, { x, y: w.y, size: 8.5, font: regular, color: linha.cor || c.cor || rgb(0, 0, 0) });
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

  w.novaPagina();
  w.cabecalho(subtituloPagina);
  w.titulo('Relatório de Adesão à Renovação — CEASA CONECTA');
  w.paragrafo(`Gerado em ${dataHojeBr()} por ${nomeGerador}.`, 9);
  if (dados.importacao) {
    w.paragrafo(
      `Base: importação "${dados.importacao.nome_arquivo || '—'}" de ${dados.importacao.criado_em || '—'} ` +
      `(${dados.importacao.total_linhas} linha(s), ${dados.importacao.nao_casados} sem contrato correspondente).`,
      8.5, rgb(0.5, 0.5, 0.5));
  }
  w.espaco(6);

  dados.grupos.forEach(g => {
    w.garantirEspaco(60);
    w.subtitulo(`Prazo final: ${g.prazo}`);
    const linhasCidade = g.cidades.map(c => ({
      valores: [c.cidade, c.total, c.aceitaram, c.pendentes, `${c.pct.toFixed(1)}%`],
      cor: c.pendentes > 0 ? undefined : VERDE_OK,
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
      w.paragrafo(`Concessionários pendentes (prazo ${g.prazo}):`, 9.5, VERMELHO_PENDENTE);
      const linhasPend = g.lista_pendentes.map(p => ({
        valores: [p.codigo, p.concessionario || '—', p.cnpj || '—', p.numero_ccu || '—'],
      }));
      desenharTabela(w, negrito, regular, `${subtituloPagina} (continuação)`, COLS_PENDENTES, linhasPend);
    } else {
      w.paragrafo('Nenhum pendente — 100% de adesão neste prazo.', 9, VERDE_OK);
    }
    w.linha();
  });

  w.page.drawText('CEASA CONECTA — Concessionários Renovação', { x: MARGIN, y: MARGIN - 28, size: 8.5, font: regular, color: rgb(0.6, 0.6, 0.6) });
  numerarPaginas(pdfDoc, regular);
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

module.exports = { gerarPdfAdesaoRenovacao };
