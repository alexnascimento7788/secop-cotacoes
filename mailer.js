// Motor de notificação por e-mail — transversal ao CEASA CONECTA (não conhece
// PAC/SECOP/SECAD em lugar nenhum aqui; quem sabe "quando disparar o quê" é
// cada routes/*.js, chamando enfileirar() com o slug do template certo). 1ª
// aplicação real são os eventos do PAC (ver routes/pac.js), mas nada neste
// arquivo depende disso — outro módulo pode chamar enfileirar() do mesmo
// jeito, sem migração nova.
//
// Fila (email_fila) é só uma tabela: enfileirar() é uma escrita SÍNCRONA no
// SQLite (node:sqlite não é async), então já é "fire and forget" pela própria
// natureza — quem chama nunca espera rede nenhuma. O envio de verdade (SMTP)
// só acontece depois, dentro de processarFila(), rodando sozinho a cada 60s.
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { db } = require('./database');

// ── Criptografia da senha SMTP (AES-256-CBC, chave derivada de EMAIL_SECRET) ──
// Sem variável de ambiente configurada, cai num fallback fixo (funciona, mas
// não é segredo de verdade) — avisado alto no console pra não passar
// despercebido em produção. Mesmo padrão de "fallback com aviso" que
// getCpfHubKey() já usa pra config secreta (ver middleware.js).
const SEGREDO = process.env.EMAIL_SECRET || (() => {
  console.warn('[email] EMAIL_SECRET não definida no ambiente — usando chave fixa de fallback (NÃO seguro para produção). Configure a variável de ambiente EMAIL_SECRET.');
  return 'ceasa-conecta-email-fallback-inseguro';
})();
const CHAVE = crypto.scryptSync(SEGREDO, 'ceasa-conecta-email-salt', 32);

function encriptarSenha(senhaPlain) {
  if (!senhaPlain) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', CHAVE, iv);
  const enc = Buffer.concat([cipher.update(String(senhaPlain), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${enc.toString('hex')}`;
}
function decriptarSenha(senhaEnc) {
  if (!senhaEnc || !senhaEnc.includes(':')) return '';
  try {
    const [ivHex, encHex] = senhaEnc.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', CHAVE, Buffer.from(ivHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

function fmtDataBr(iso) {
  if (!iso) return '';
  const d = String(iso).split(/[T ]/)[0].split('-');
  return d.length < 3 ? String(iso) : `${d[2]}/${d[1]}/${d[0]}`;
}

function getConfig() {
  return db.prepare(`SELECT * FROM email_config ORDER BY id DESC LIMIT 1`).get() || null;
}

function montarTransporter(config) {
  const opts = {
    host: config.host,
    port: config.port,
    secure: !!config.secure,
    auth: config.usuario ? { user: config.usuario, pass: decriptarSenha(config.senha_enc) } : undefined,
  };
  // "Servidor legado" (opt-in, desligado por padrão, com aviso na tela) —
  // achado real, 2026-09-10: smtp.ceasaminas.com.br só fala TLSv1 com cifra
  // fraca e está com certificado vencido desde 2019; o OpenSSL moderno do
  // Node recusa isso por padrão (proteção correta) — isto aqui deliberadamente
  // desliga essa proteção só quando o Alex marcar a opção, sabendo do risco
  // (conexão fica exposta a interceptação, mesma exposição que o Outlook já
  // tinha o tempo todo com esse servidor, só que agora explícita e visível).
  if (config.tls_legado) {
    opts.tls = { minVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0', rejectUnauthorized: false };
  }
  return nodemailer.createTransport(opts);
}

async function testarConexao() {
  const config = getConfig();
  if (!config || !config.host) return { ok: false, erro: 'Configuração de SMTP não cadastrada.' };
  try {
    const transporter = montarTransporter(config);
    await transporter.verify();
    db.prepare(`UPDATE email_config SET testado_em = datetime('now') WHERE id = ?`).run(config.id);
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

// ── Resolução de destinatários ────────────────────────────────────────────
// Tipos genéricos o bastante pra qualquer módulo — hoje só o PAC usa, mas
// nada aqui é específico dele além do nome dos tipos ('pac_depla' etc.).
function resolverDestinatarios(tipo, contexto = {}) {
  switch (tipo) {
    case 'pac_depla':
      // Todo usuário com 'ver' na rotina pac-gestao (o "DEPLA" de fato) —
      // mesma checagem que o servidor já faz em requireRotina('pac-gestao','ver').
      return db.prepare(`
        SELECT DISTINCT u.email AS email, COALESCE(u.nome_completo, u.username) AS nome
        FROM user_modulos um
        JOIN modulos m ON m.id = um.modulo_id AND m.slug = 'pac'
        JOIN perfil_rotinas pr ON pr.perfil_id = um.perfil_id
        JOIN rotinas r ON r.id = pr.rotina_id AND r.slug = 'pac-gestao' AND pr.ver = 1
        JOIN users u ON u.id = um.user_id
        WHERE u.ativo = 1 AND u.email IS NOT NULL AND TRIM(u.email) != ''
      `).all();
    case 'setor':
      if (!contexto.setor_id) return [];
      return db.prepare(`
        SELECT DISTINCT u.email AS email, COALESCE(u.nome_completo, u.username) AS nome
        FROM setor_usuarios su JOIN users u ON u.id = su.user_id
        WHERE su.setor_id = ? AND u.ativo = 1 AND u.email IS NOT NULL AND TRIM(u.email) != ''
      `).all(contexto.setor_id);
    case 'admin_operacional_pac': {
      const mod = db.prepare(`SELECT departamento_id FROM modulos WHERE slug = 'pac'`).get();
      if (!mod || !mod.departamento_id) return [];
      return db.prepare(`
        SELECT email AS email, COALESCE(nome_completo, username) AS nome FROM users
        WHERE role = 'admin_operacional' AND departamento_id = ? AND ativo = 1 AND email IS NOT NULL AND TRIM(email) != ''
      `).all(mod.departamento_id);
    }
    case 'usuario': {
      if (!contexto.user_id) return [];
      const u = db.prepare(`SELECT email AS email, COALESCE(nome_completo, username) AS nome FROM users WHERE id = ? AND ativo = 1`).get(contexto.user_id);
      return (u && u.email && String(u.email).trim()) ? [u] : [];
    }
    case 'admin_sistema':
      // Genérico (não específico de módulo nenhum) — usado hoje pelos
      // alertas de vencimento de contrato do DETIN nos 2 estágios mais
      // urgentes (15 dias e contagem diária), além do responsável do contrato.
      return db.prepare(`
        SELECT email AS email, COALESCE(nome_completo, username) AS nome FROM users
        WHERE role = 'admin_sistema' AND ativo = 1 AND email IS NOT NULL AND TRIM(email) != ''
      `).all();
    default:
      return [];
  }
}

// ── Enfileirar ────────────────────────────────────────────────────────────
// Nunca lança exceção — qualquer erro (template inexistente, variável
// faltando etc.) só é logado no console; a operação que chamou isto (criar
// DFD, responder pedido...) nunca pode falhar por causa do e-mail.
const VARS_GLOBAIS = { plataforma: 'CEASA CONECTA', ano: String(new Date().getFullYear()), url_sistema: process.env.URL_SISTEMA || '' };

function substituirVars(texto, vars) {
  return String(texto || '').replace(/\{\{(\w+)\}\}/g, (m, chave) => (vars[chave] !== undefined && vars[chave] !== null) ? String(vars[chave]) : '');
}

function enfileirar(templateSlug, variaveis = {}, destinatariosExtras = [], opcoes = {}) {
  try {
    const template = db.prepare(`SELECT * FROM email_templates WHERE slug = ? AND ativo = 1`).get(templateSlug);
    if (!template) return null; // template não existe ou foi desativado pelo admin — silenciosamente não envia

    // Dedup diário opcional (job de lembrete de prazo usa isso pra não
    // reenviar o mesmo aviso se rodar 2x no mesmo dia) — ver `chave_dedup`
    // em database.js.
    if (opcoes.chaveDedup) {
      const jaExiste = db.prepare(`
        SELECT 1 FROM email_fila WHERE template_slug = ? AND chave_dedup = ? AND date(criado_em) = date('now')
      `).get(templateSlug, opcoes.chaveDedup);
      if (jaExiste) return null;
    }

    const fixos = db.prepare(`SELECT email, nome FROM email_destinatarios_fixos WHERE template_slug = ? AND ativo = 1`).all(templateSlug);
    const todos = [...fixos, ...destinatariosExtras];
    const vistos = new Set();
    const destinatarios = todos.filter(d => {
      const email = d && d.email && String(d.email).trim().toLowerCase();
      if (!email || vistos.has(email)) return false;
      vistos.add(email);
      return true;
    }).map(d => ({ email: String(d.email).trim(), nome: d.nome || '' }));

    if (!destinatarios.length) return null; // ninguém pra receber — não faz sentido gravar fila vazia

    const vars = { ...VARS_GLOBAIS, ...variaveis };
    const assunto_resolvido = substituirVars(template.assunto, vars);
    const corpo_html_resolvido = substituirVars(template.corpo_html, vars);
    const corpo_texto_resolvido = substituirVars(template.corpo_texto, vars);

    const config = getConfig();
    const status = (config && config.ativo) ? 'pendente' : 'cancelado';

    const info = db.prepare(`
      INSERT INTO email_fila (template_slug, assunto_resolvido, corpo_html_resolvido, corpo_texto_resolvido, destinatarios, status, agendado_para, chave_dedup)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(templateSlug, assunto_resolvido, corpo_html_resolvido, corpo_texto_resolvido,
      JSON.stringify(destinatarios), status, opcoes.agendadoPara || null, opcoes.chaveDedup || null);
    return info.lastInsertRowid;
  } catch (e) {
    console.error(`[email] falha ao enfileirar "${templateSlug}":`, e.message);
    return null;
  }
}

// ── Processamento da fila ────────────────────────────────────────────────
async function processarFila() {
  const resumo = { processados: 0, enviados: 0, erros: 0 };
  try {
    const config = getConfig();
    if (!config || !config.ativo) return resumo; // sem SMTP ativo, nem tenta — fica tudo pendente até reativar

    const itens = db.prepare(`
      SELECT * FROM email_fila WHERE status = 'pendente' AND (agendado_para IS NULL OR agendado_para <= datetime('now'))
      ORDER BY criado_em ASC LIMIT 10
    `).all();
    if (!itens.length) return resumo;

    const transporter = montarTransporter(config);
    for (const item of itens) {
      resumo.processados++;
      let destinatarios = [];
      try { destinatarios = JSON.parse(item.destinatarios); } catch { destinatarios = []; }
      try {
        await transporter.sendMail({
          from: config.remetente_nome ? `"${config.remetente_nome}" <${config.remetente_email}>` : config.remetente_email,
          to: destinatarios.map(d => d.nome ? `"${d.nome}" <${d.email}>` : d.email).join(', '),
          subject: item.assunto_resolvido,
          html: item.corpo_html_resolvido,
          text: item.corpo_texto_resolvido || undefined,
        });
        db.prepare(`UPDATE email_fila SET status = 'enviado', processado_em = datetime('now') WHERE id = ?`).run(item.id);
        db.prepare(`
          INSERT INTO email_log (fila_id, template_slug, assunto, destinatarios, status_final, tentativas_total, enviado_em)
          VALUES (?, ?, ?, ?, 'enviado', ?, datetime('now'))
        `).run(item.id, item.template_slug, item.assunto_resolvido, item.destinatarios, item.tentativas + 1);
        resumo.enviados++;
      } catch (e) {
        const tentativas = item.tentativas + 1;
        if (tentativas >= item.max_tentativas) {
          db.prepare(`UPDATE email_fila SET status = 'erro', tentativas = ?, erro_msg = ?, processado_em = datetime('now') WHERE id = ?`)
            .run(tentativas, e.message, item.id);
          db.prepare(`
            INSERT INTO email_log (fila_id, template_slug, assunto, destinatarios, status_final, erro_msg, tentativas_total)
            VALUES (?, ?, ?, ?, 'erro', ?, ?)
          `).run(item.id, item.template_slug, item.assunto_resolvido, item.destinatarios, e.message, tentativas);
          db.prepare(`INSERT INTO email_alertas (tipo, mensagem) VALUES ('fila_erro', ?)`)
            .run(`Falha ao enviar "${item.assunto_resolvido}" após ${tentativas} tentativa(s): ${e.message}`);
        } else {
          db.prepare(`UPDATE email_fila SET tentativas = ?, erro_msg = ? WHERE id = ?`).run(tentativas, e.message, item.id);
        }
        resumo.erros++;
      }
    }
  } catch (e) {
    // Nunca deixa escapar — o motor não pode derrubar o processo por causa
    // de um problema pontual (ex.: SMTP fora do ar bem na hora do verify).
    console.error('[email] erro inesperado processando a fila:', e.message);
  }
  return resumo;
}

// ── Job diário de lembrete de prazo ──────────────────────────────────────
function verificarLembretesPrazo() {
  try {
    const dias1 = parseInt(db.prepare(`SELECT valor FROM config WHERE chave = 'email_lembrete_dias_1'`).get()?.valor, 10) || 7;
    const dias2 = parseInt(db.prepare(`SELECT valor FROM config WHERE chave = 'email_lembrete_dias_2'`).get()?.valor, 10) || 2;
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);

    const dfds = db.prepare(`SELECT id, titulo, ano_base, data_entrega FROM dfds WHERE status = 'aberto' AND data_entrega IS NOT NULL`).all();
    dfds.forEach(dfd => {
      const prazo = new Date(String(dfd.data_entrega).slice(0, 10) + 'T00:00:00');
      if (isNaN(prazo.getTime())) return;
      const diasRestantes = Math.round((prazo - hoje) / 86400000);
      if (diasRestantes !== dias1 && diasRestantes !== dias2) return;

      const setoresPendentes = db.prepare(`
        SELECT s.id, s.nome FROM dfd_setores ds JOIN setores s ON s.id = ds.setor_id
        WHERE ds.dfd_id = ? AND ds.finalizado_em IS NULL
      `).all(dfd.id);
      if (!setoresPendentes.length) return;

      const templateSlug = diasRestantes === dias2 ? 'pac.dfd.lembrete.prazo.urgente' : 'pac.dfd.lembrete.prazo';
      setoresPendentes.forEach(setor => {
        const destinatarios = resolverDestinatarios('setor', { setor_id: setor.id });
        if (diasRestantes === dias2) {
          destinatarios.push(...resolverDestinatarios('admin_operacional_pac', {}));
        }
        enfileirar(templateSlug, {
          dfd_titulo: dfd.titulo, dfd_ano: dfd.ano_base, dfd_prazo: fmtDataBr(dfd.data_entrega),
          dias_restantes: diasRestantes, nome_setor: setor.nome, nome_gestor: setor.nome,
        }, destinatarios, { chaveDedup: `dfd:${dfd.id}:setor:${setor.id}:${templateSlug}` });
      });
    });
  } catch (e) {
    console.error('[email] erro no job de lembrete de prazo:', e.message);
  }
}

// ── Job diário de vencimento de contratos (DETIN) ────────────────────────
// Mesma ideia de verificarLembretesPrazo() acima, adaptada pro DETIN: 4
// estágios fixos (60/30/15 dias e contagem regressiva diária de 10 a 1),
// não parametrizáveis (diferente do PAC) porque o pedido original já veio
// com os 4 limiares definidos. Dedup por dia+contrato+template evita
// reenviar se o job rodar mais de 1x no mesmo dia.
function verificarVencimentosDetin() {
  try {
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const contratos = db.prepare(`
      SELECT * FROM detin_contratos WHERE excluido = 0 AND status = 'ativo' AND data_vencimento IS NOT NULL
    `).all();
    contratos.forEach(c => {
      const alvo = new Date(String(c.data_vencimento).slice(0, 10) + 'T00:00:00');
      if (isNaN(alvo.getTime())) return;
      const dias = Math.round((alvo - hoje) / 86400000);

      let templateSlug = null;
      if (dias === 60) templateSlug = 'detin.contrato.alerta.60';
      else if (dias === 30) templateSlug = 'detin.contrato.alerta.30';
      else if (dias === 15) templateSlug = 'detin.contrato.alerta.15';
      else if (dias > 0 && dias <= 10) templateSlug = 'detin.contrato.alerta.diario';
      if (!templateSlug) return;

      const destinatarios = c.responsavel_id ? resolverDestinatarios('usuario', { user_id: c.responsavel_id }) : [];
      if (templateSlug === 'detin.contrato.alerta.15' || templateSlug === 'detin.contrato.alerta.diario') {
        destinatarios.push(...resolverDestinatarios('admin_sistema', {}));
      }
      if (!destinatarios.length) return; // ninguém responsável cadastrado e nenhum admin_sistema com e-mail — nada a fazer

      enfileirar(templateSlug, {
        numero_contrato: c.numero_contrato || 'sem número', fornecedor: c.fornecedor, objeto: c.objeto || '',
        data_vencimento: fmtDataBr(c.data_vencimento), dias_restantes: dias,
        nome_responsavel: destinatarios[0]?.nome || '',
      }, destinatarios, { chaveDedup: `detin:${c.id}:${templateSlug}` });
    });
  } catch (e) {
    console.error('[email] erro no job de vencimento de contratos (DETIN):', e.message);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────
let _motorIniciado = false;
function iniciarMotor() {
  if (_motorIniciado) return; // proteção contra dupla chamada (nunca deveria acontecer)
  _motorIniciado = true;

  // Itens presos de um restart anterior (nasceram há mais de 10min e nunca
  // foram processados) — alerta o master e processa na hora, não espera o
  // próximo tick de 60s.
  try {
    const presos = db.prepare(`
      SELECT COUNT(*) AS n FROM email_fila
      WHERE status = 'pendente' AND processado_em IS NULL AND criado_em <= datetime('now', '-10 minutes')
    `).get().n;
    if (presos > 0) {
      db.prepare(`INSERT INTO email_alertas (tipo, mensagem) VALUES ('motor_parado', ?)`)
        .run(`${presos} e-mail(s) ficaram presos na fila (provavelmente o servidor caiu/reiniciou) — processando agora.`);
    }
  } catch (e) { console.error('[email] erro verificando fila presa no startup:', e.message); }

  processarFila();
  setInterval(processarFila, 60 * 1000);

  // Job diário — roda 1x já no startup (cobre o caso de o servidor ficar
  // ligado o dia inteiro sem reiniciar perto da hora certa) e depois a cada
  // hora; o dedup por dia (chave_dedup) garante que não duplica mesmo
  // rodando várias vezes no mesmo dia.
  verificarLembretesPrazo();
  setInterval(verificarLembretesPrazo, 60 * 60 * 1000);

  verificarVencimentosDetin();
  setInterval(verificarVencimentosDetin, 60 * 60 * 1000);
}

module.exports = {
  iniciarMotor, processarFila, enfileirar, resolverDestinatarios,
  testarConexao, encriptarSenha, decriptarSenha, fmtDataBr,
};
