// ── SECAD: PDF único (Comunicado + Nota Técnica + Protocolo) ──────────────────
// Pedido do Alex (2026-09-17): os 3 documentos precisam sair "tudo junto", num
// PDF só, por concessionário. Comunicado e Protocolo são desenhados aqui com
// pdf-lib (texto simples, sem logo — a impressão em tela via window.print()
// continua existindo à parte, em public/js/secad.js, pra visualização/2ª via
// avulsa). A Nota Técnica NUNCA é redesenhada — é um PDF já pronto, com
// assinatura digital, só copiado (copyPages) pra dentro do arquivo final, byte
// a byte, preservando o conteúdo original dela.
//
// Ordem de páginas por contrato: Comunicado → Nota Técnica → Protocolo — se
// repete pra cada contrato do lote (cada concessionário recebe o pacote
// completo, não só a carta).
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_W = 595.28, PAGE_H = 841.89; // A4 em pontos (72dpi)
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;
const AZUL_SECAD = rgb(0x15 / 255, 0x65 / 255, 0xC0 / 255); // mesmo azul do módulo SECAD (cor em database.js)
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
  garantirEspaco(h) { if (this.y - h < MARGIN) this.novaPagina(); }
  // subtitulo (opcional, texto pequeno alinhado à direita): usado pelos
  // relatórios tabulares novos (Concessionários Cadastro); as cartas
  // (Comunicado/Protocolo) chamam cabecalho() sem argumento, como sempre.
  cabecalho(subtitulo) {
    if (this.logoImg) {
      const escala = 32 / this.logoImg.height;
      this.page.drawImage(this.logoImg, { x: MARGIN, y: this.y - 30, width: this.logoImg.width * escala, height: 32 });
    } else {
      this.page.drawText('CEASAMINAS', { x: MARGIN, y: this.y, size: 16, font: this.negrito });
      this.page.drawText('Centrais de Abastecimento de Minas Gerais S.A', {
        x: MARGIN, y: this.y - 15, size: 8.5, font: this.regular, color: rgb(0.4, 0.4, 0.4) });
    }
    if (subtitulo) {
      const lw = this.negrito.widthOfTextAtSize(subtitulo, 10);
      this.page.drawText(subtitulo, { x: PAGE_W - MARGIN - lw, y: this.y - 6, size: 10, font: this.negrito, color: AZUL_SECAD });
    }
    this.y -= 34;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 1, color: rgb(0.75, 0.75, 0.75) });
    this.y -= 22;
  }
  titulo(texto) {
    this.garantirEspaco(26);
    this.page.drawText(texto, { x: MARGIN, y: this.y, size: 12.5, font: this.negrito });
    this.y -= 24;
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
  campo(label, valor) {
    const size = 10;
    this.garantirEspaco(15);
    this.page.drawText(label, { x: MARGIN, y: this.y, size, font: this.negrito });
    const lw = this.negrito.widthOfTextAtSize(label + ' ', size);
    const texto = String(valor ?? '—');
    // Valor cabe numa linha só (caso comum) — desenha ao lado do rótulo. Se não
    // couber (ex: razão social bem longa), quebra em várias linhas indentadas
    // sob o rótulo, sem estourar a margem direita da página.
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
  item(numero, texto, size = 10.5) {
    const prefixo = `${numero}. `;
    const larguraPrefixo = this.negrito.widthOfTextAtSize(prefixo, size);
    const linhas = wrapText(texto, this.regular, size, CONTENT_W - larguraPrefixo);
    linhas.forEach((l, i) => {
      this.garantirEspaco(size + 4);
      if (i === 0) this.page.drawText(prefixo, { x: MARGIN, y: this.y, size, font: this.negrito });
      this.page.drawText(l, { x: MARGIN + larguraPrefixo, y: this.y, size, font: this.regular });
      this.y -= size + 4;
    });
    this.y -= 4;
  }
}

function dataHojeBr() {
  const h = new Date();
  return `${String(h.getDate()).padStart(2, '0')}/${String(h.getMonth() + 1).padStart(2, '0')}/${h.getFullYear()}`;
}

function truncar(texto, font, size, maxWidth) {
  const t0 = String(texto ?? '');
  if (font.widthOfTextAtSize(t0, size) <= maxWidth) return t0;
  let t = t0;
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

async function carregarLogo(pdfDoc) {
  try {
    const bytes = fs.readFileSync(path.join(__dirname, 'public', 'img', 'Logo Ceasa TI_transp.png'));
    return await pdfDoc.embedPng(bytes);
  } catch { return null; }
}

// Tabela com bolinha colorida na 1ª posição (verde/vermelho = ativo/inativo)
// — mesma técnica de detin-pdf.js (achado bom o bastante pra repetir: uma
// bolinha antes da linha comunica status sem gastar uma coluna inteira).
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

// Mesmo texto/regra de public/js/secad.js:comunicadoPaper() — mantidos em
// arquivos separados de propósito (um roda no navegador pra pré-visualização/
// 2ª via avulsa, este roda no servidor pro PDF final); ao mudar o texto de um,
// replicar no outro.
function paginaComunicado(w, c) {
  w.novaPagina();
  w.cabecalho();
  w.titulo(`COMUNICADO OFICIAL — CEASAMINAS Nº ${c.numero_comunicado}`);
  w.campo('À empresa:', c.empresa);
  w.campo('CNPJ nº:', c.cnpj);
  w.campo('Endereço:', c.endereco);
  w.espaco(6);
  w.campo('Contrato de concessão de uso nº:', c.numero_ccu);
  w.campo('Área/espaço concedido:', c.area);
  w.campo('Ano de vencimento original:', c.ano_vencimento);
  w.espaco(10);
  w.paragrafo('Assunto: Notificação de elegibilidade e instruções para prorrogação antecipada de contrato — Edital de Chamamento de Interessados nº 001/2026.');
  w.paragrafo('Prezado(a) Concessionário(a),');
  w.paragrafo('A CENTRAIS DE ABASTECIMENTO DE MINAS GERAIS S/A — CEASAMINAS informa que a empresa acima qualificada se encontra elegível para requerer a prorrogação antecipada do Contrato de Concessão de Uso (CCU) citado acima, nos termos e condições do Edital de Chamamento de Interessados nº 001/2026.');
  w.item(1, `O prazo para adesão e envio da documentação é até ${c.prazo_final}.`);
  w.item(2, 'Para acessar a plataforma para envio da documentação, utilize as credenciais individuais abaixo:');
  w.espaco(2);
  w.campo('Endereço de acesso:', c.url_acesso);
  w.campo('Login de acesso:', c.login);
  w.campo('Senha provisória:', c.senha);
  w.espaco(8);
  w.item(3, 'Condições financeiras, prazos, cronograma, exigências e demais informações estão descritas no Edital de Chamamento de Interessados nº 001/2026, disponível no site www.ceasaminas.com.br.');
  w.item(4, 'A não adesão no prazo estabelecido implica na renúncia ao direito subjetivo à renovação do contrato proposta no Termo de Compromisso de Conduta (TCC) firmado com o MPMG.');
  w.item(5, 'Em caso de dúvidas: para suporte técnico e recuperação de senha, contate dpo@ceasaminas.com.br; para esclarecimentos sobre documentos ou regras do Edital, contate cpl@ceasaminas.com.br.');
  w.espaco(16);
  w.paragrafo('Diretoria Executiva — CEASAMINAS', 9);
}

// Mesmo texto/regra de public/js/secad.js:protocoloPaper() — ver nota acima.
function paginaProtocolo(w, c) {
  w.novaPagina();
  w.cabecalho();
  w.titulo(`PROTOCOLO DE ENTREGA Nº ${c.protocolo_numero || '—'}`);
  w.campo('Referente ao Comunicado Oficial nº:', c.numero_comunicado);
  w.campo('Código do concessionário:', c.codigo);
  w.campo('À empresa:', c.empresa);
  w.campo('CNPJ nº:', c.cnpj);
  w.campo('Contrato de concessão de uso nº:', c.numero_ccu);
  w.campo('Área/espaço concedido:', c.area);
  w.espaco(10);
  w.paragrafo(`Declaro ter recebido da CEASAMINAS o Comunicado Oficial nº ${c.numero_comunicado} e a Nota Técnica de Avaliação de Área, referente à notificação de elegibilidade e instruções para a prorrogação antecipada do contrato de concessão de uso acima identificado, incluindo as credenciais individuais de acesso à plataforma de adesão.`);
  w.paragrafo(`Declaro estar ciente de que o prazo para adesão é até ${c.prazo_final}, e que a não adesão no prazo implica renúncia ao direito de renovação nos termos do Edital de Chamamento de Interessados nº 001/2026.`);
  w.espaco(24);
  w.campo('Recebido por (nome legível):', '_______________________________________________');
  w.espaco(20);
  w.campo('CPF / RG:', '________________________________');
  w.espaco(20);
  w.campo('Data do recebimento:', '______/______/__________');
  w.espaco(26);
  w.campo('Assinatura:', '_______________________________________________');
  w.espaco(22);
  w.paragrafo(`Emitido em ${dataHojeBr()} — CEASAMINAS`, 9);
}

// comunicados: array de objetos vindos de montarComunicado(...).comunicado.
// notaTecnicaBuffer: Buffer do PDF assinado (obrigatório — quem chama já barrou
// a geração antes se não existir, ver motivo 'sem_nota_tecnica' em routes/secad.js).
async function gerarPdfComunicados(comunicados, notaTecnicaBuffer) {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const negrito = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const w = new Escritor(pdfDoc, regular, negrito);

  const notaTecnicaDoc = await PDFDocument.load(notaTecnicaBuffer);
  const indices = notaTecnicaDoc.getPageIndices();

  for (const c of comunicados) {
    paginaComunicado(w, c);
    const paginasNota = await pdfDoc.copyPages(notaTecnicaDoc, indices);
    paginasNota.forEach(p => pdfDoc.addPage(p));
    paginaProtocolo(w, c);
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

// ── Concessionários Cadastro: relatório agrupado por ramo de atividade ───────
// ramos: [{ ramo, itens: [{codigo, numero_contrato, ativo (0/1), unidade,
// nome, fantasia, cnpj, cidade, ...}] }] — 1 item por CONTRATO (não por
// empresa: uma empresa com 2 contratos ativos aparece 2 vezes, cada linha
// com seu próprio status) — vem de linhasComUnidade() em routes/secad.js,
// mesma função que a tela de Pesquisar usa, pra tela e PDF nunca divergirem.
// ~20-25 linhas cabem por página nesse tamanho de fonte/coluna.
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

  w.page.drawText('SECAD — Concessionários Cadastro. Verde = ativo, vermelho = inativo.', {
    x: MARGIN, y: MARGIN - 28, size: 8.5, font: regular, color: rgb(0.6, 0.6, 0.6),
  });
  numerarPaginas(pdfDoc, regular);
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

module.exports = { gerarPdfComunicados, gerarPdfConcessionarios };
