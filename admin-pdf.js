// ── Admin: PDF do Relatório de Acessos por Módulo ───────────────────────────
// Mesmo padrão de secad-pdf.js/detin-pdf.js/pac-pdf.js (pdf-lib, Escritor com
// cursor de página) — duplicado aqui de propósito (cada módulo tem o próprio
// arquivo de PDF, nenhum módulo compartilhado novo). Pedido do Alex,
// 2026-10-20: "relatorio de acessos por usuario por modulo, usuarios que
// nunca logaram por modulo" — 1 seção por módulo (quem acessou + quantas
// vezes + último acesso, e quem nunca acessou apesar de ter o módulo
// liberado), com o logo do CEASA no cabeçalho.
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_W = 595.28, PAGE_H = 841.89; // A4 em pontos (72dpi)
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;
const AZUL = rgb(0x1A / 255, 0x3F / 255, 0x6B / 255);
const VERMELHO_NUNCA = rgb(0xC0 / 255, 0x39 / 255, 0x2B / 255);
const CINZA_INATIVO = rgb(0.55, 0.55, 0.55);

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
  linha() {
    this.garantirEspaco(14);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.75, color: rgb(0.82, 0.82, 0.82) });
    this.y -= 14;
  }
}

// Tabela simples (cabeçalho em negrito + linhas) — mesmo padrão de
// desenharTabela em pac-pdf.js.
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

// criado_em no banco é DATETIME em UTC (SQLite CURRENT_TIMESTAMP) — mesma
// conversão que o admin.html já faz no navegador (fmtDataHora), só que fixando
// o fuso explicitamente aqui (código roda no servidor, não no navegador do
// Alex) em vez de depender do fuso do SO.
function fmtDataHoraBr(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return String(iso);
  return d.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

async function carregarLogo(pdfDoc) {
  try {
    const bytes = fs.readFileSync(path.join(__dirname, 'public', 'img', 'Logo Ceasa TI_transp.png'));
    return await pdfDoc.embedPng(bytes);
  } catch { return null; }
}

const COLS_ACESSOS = [
  { label: 'Usuário', w: 150 }, { label: 'Total de acessos', w: 85 },
  { label: 'Primeiro acesso', w: 125 }, { label: 'Último acesso', w: 123 },
];
const COLS_NUNCA = [
  { label: 'Usuário', w: 280 }, { label: 'Situação da conta', w: 150 },
];

// dados: { modulos: [{ id, slug, nome, acessos: [{username, nome_completo,
// ativo, total_acessos, primeiro_acesso, ultimo_acesso}], nunca_logaram:
// [{username, nome_completo, ativo}] }] } — vem de montarRelatorioAcessos()
// em routes/admin.js (mesma função monta os dados pra tela E pro PDF).
async function gerarPdfRelatorioAcessos(dados, nomeGerador) {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const negrito = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const logoImg = await carregarLogo(pdfDoc);
  const w = new Escritor(pdfDoc, regular, negrito, logoImg);
  const subtituloPagina = 'Relatório de Acessos';

  w.novaPagina();
  w.cabecalho(subtituloPagina);
  w.titulo('Relatório de Acessos por Módulo — CEASA CONECTA');
  w.paragrafo(`Gerado em ${dataHojeBr()} por ${nomeGerador}.`, 9);
  w.espaco(6);

  dados.modulos.forEach(m => {
    w.garantirEspaco(60);
    w.subtitulo(m.nome);

    if (m.acessos.length) {
      const linhas = m.acessos.map(a => ({
        valores: [
          `${a.nome_completo || a.username}${a.ativo ? '' : ' (inativo)'}`,
          a.total_acessos,
          fmtDataHoraBr(a.primeiro_acesso),
          fmtDataHoraBr(a.ultimo_acesso),
        ],
        cor: a.ativo ? undefined : CINZA_INATIVO,
      }));
      desenharTabela(w, negrito, regular, `${subtituloPagina} (continuação)`, COLS_ACESSOS, linhas);
    } else {
      w.paragrafo('Nenhum acesso registrado neste módulo ainda.', 9, rgb(0.5, 0.5, 0.5));
    }
    w.espaco(6);

    w.garantirEspaco(30);
    w.paragrafo('Usuários com o módulo liberado que nunca acessaram:', 9.5);
    if (m.nunca_logaram.length) {
      const linhas = m.nunca_logaram.map(u => ({
        valores: [`${u.nome_completo || u.username}`, u.ativo ? 'Ativa' : 'Inativa'],
        cor: VERMELHO_NUNCA,
      }));
      desenharTabela(w, negrito, regular, `${subtituloPagina} (continuação)`, COLS_NUNCA, linhas);
    } else {
      w.paragrafo('Nenhum — todos que têm acesso já entraram ao menos uma vez.', 9, rgb(0.5, 0.5, 0.5));
    }
    w.linha();
  });

  if (dados.sem_modulo && dados.sem_modulo.length) {
    w.garantirEspaco(40);
    w.subtitulo('Usuários sem nenhum módulo liberado', VERMELHO_NUNCA);
    w.paragrafo('Têm conta no sistema, mas nenhum módulo foi liberado ainda — não aparecem em nenhuma lista acima.', 9, rgb(0.5, 0.5, 0.5));
    const linhas = dados.sem_modulo.map(u => ({
      valores: [
        `${u.nome_completo || u.username}${u.ativo ? '' : ' (inativo)'}`,
        u.senha_provisoria ? 'Aguardando 1º acesso (senha provisória)' : 'Ativa, sem módulo',
      ],
      cor: VERMELHO_NUNCA,
    }));
    desenharTabela(w, negrito, regular, subtituloPagina, COLS_NUNCA, linhas);
    w.linha();
  }

  w.page.drawText('CEASA CONECTA — Administração', { x: MARGIN, y: MARGIN - 28, size: 8.5, font: regular, color: rgb(0.6, 0.6, 0.6) });
  numerarPaginas(pdfDoc, regular);
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

module.exports = { gerarPdfRelatorioAcessos };
