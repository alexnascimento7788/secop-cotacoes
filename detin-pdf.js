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

  // ── Numeração de página (última passada, total já conhecido) ──
  const paginas = pdfDoc.getPages();
  paginas.forEach((p, i) => {
    const texto = `${i + 1} / ${paginas.length}`;
    const tw = regular.widthOfTextAtSize(texto, 8.5);
    p.drawText(texto, { x: PAGE_W - MARGIN - tw, y: MARGIN - 28, size: 8.5, font: regular, color: rgb(0.6, 0.6, 0.6) });
  });

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

module.exports = { gerarPdfAnalise };
