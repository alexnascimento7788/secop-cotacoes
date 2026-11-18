// ── CPL: Comunicação Concessionários (parcelamento da outorga) ─────────────
// Pedido do Alex, 2026-11-18: concessionário que já deu aceite à renovação
// (ver renovacao_aceites, routes/secad-relatorios.js) mas cuja planilha de
// aceite não trazia o informe de quantas parcelas da outorga — esta tela
// deixa a CPL solicitar isso por e-mail (individual/seleção/em massa) e
// acompanhar quem já respondeu. Ver cpl_parcelamento_concessionarios em
// database.js pro modelo de dados — sem FK pro depop.db, mesma convenção já
// usada em validacao_contrato/renovacao_aceites (ligação só por valor).
const express = require('express');
const { db } = require('../database');
const { registrarLog, requireModulo, requireRotina, n } = require('../middleware');
const mailer = require('../mailer');

const router = express.Router();
const cpl = requireModulo('cpl-comunicacao');
const verGate = requireRotina('comunicacao-parcelamento', 'ver');
const incluirGate = requireRotina('comunicacao-parcelamento', 'incluir');
const alterarGate = requireRotina('comunicacao-parcelamento', 'alterar');
const excluirGate = requireRotina('comunicacao-parcelamento', 'excluir');

// Mesmo padrão de routes/secad-relatorios.js / pac-importacao.js: importar
// planilha é ferramenta de admin, role-gated, ortogonal ao Perfil/Rotina do
// módulo (que controla a TELA, não a importação).
function requireAdminGlobal(req, res, next) {
  if (req.user.username === 'master' || req.user.role === 'admin_sistema') return next();
  return res.status(403).json({ error: 'Acesso restrito ao administrador do sistema.' });
}

function normalizarCcu(s) {
  return String(s || '').trim();
}

// ── Sincronização a partir da importação de aceites (SECAD/Relatórios) ────
// Chamada por routes/secad-relatorios.js depois de confirmar uma importação
// de aceites — SÓ age em linhas que trouxerem e-mail (planilha nova, com as
// colunas Email1/Email2/Telefone/TelefoneWhatsApp); linha sem e-mail não
// toca nesta tabela (planilha antiga, 4 colunas, continua 100% inalterada).
// Nunca lança exceção — uma falha aqui não pode derrubar a importação do
// SECAD, que é o fluxo "de verdade" e já estava funcionando antes da CPL.
function sincronizarNovosAceites(linhas, usuarioId) {
  try {
    const avisoEmail = db.prepare(`SELECT valor FROM config WHERE chave = 'cpl_email_aviso_novo'`).get()?.valor || 'cpl@ceasaminas.com.br';
    linhas.forEach(l => {
      const temEmail = (l.email1 && String(l.email1).trim()) || (l.email2 && String(l.email2).trim());
      if (!temEmail || !l.data_aceite) return;
      const codigo = l.codigo;
      const numero_ccu = normalizarCcu(l.numero_ccu);
      const existente = db.prepare(`SELECT id FROM cpl_parcelamento_concessionarios WHERE codigo = ? AND numero_ccu = ?`).get(codigo, numero_ccu);
      if (existente) {
        // Já conhecido — só atualiza dados de contato/aceite, nunca o
        // progresso (habilitado/autorizado/parcelas) já decidido pela CPL.
        db.prepare(`
          UPDATE cpl_parcelamento_concessionarios
          SET cnpj = COALESCE(?, cnpj), email1 = ?, email2 = ?, telefone = ?, telefone_whatsapp = ?,
              data_aceite = ?, atualizado_em = datetime('now')
          WHERE id = ?
        `).run(n(l.cnpj), n(l.email1), n(l.email2), n(l.telefone), n(l.telefone_whatsapp), n(l.data_aceite), existente.id);
        return;
      }
      // Novo concessionário com aceite — nasce pronto pra envio (habilitado +
      // autorizado), CPL que decide desautorizar se necessário (pedido
      // explícito do Alex: "ja inserir deixando o envio pronto, informar a
      // cpl e eles acessam e somente autorizam ou desautorizam").
      const info = db.prepare(`
        INSERT INTO cpl_parcelamento_concessionarios
          (codigo, numero_ccu, cnpj, email1, email2, telefone, telefone_whatsapp, data_aceite, habilitado, autorizado_cpl)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
      `).run(codigo, numero_ccu, n(l.cnpj), n(l.email1), n(l.email2), n(l.telefone), n(l.telefone_whatsapp), n(l.data_aceite));

      mailer.enfileirar('cpl.parcelamento.novo_concessionario', {
        concessionario_nome: `Concessionário ${codigo}`, codigo: String(codigo), numero_ccu,
        cnpj: l.cnpj || '—', email: l.email1 || l.email2 || '—', data_aceite: mailer.fmtDataBr(l.data_aceite),
      }, [{ email: avisoEmail }]);

      registrarLog({ user: { username: null, user_id: usuarioId }, headers: {}, socket: {} }, 'CPL', 'NOVO_CONCESSIONARIO',
        `Novo concessionário com aceite (código ${codigo}, contrato ${numero_ccu}) incluído na Comunicação de Parcelamento`, null, usuarioId);
    });
  } catch (e) {
    console.error('[cpl] erro sincronizando novos aceites:', e.message);
  }
}

// ── Listagem / detalhe ──────────────────────────────────────────────────────
function situacaoConcessionario(c) {
  if (c.parcelas_informado) return 'informado';
  if (!c.autorizado_cpl || !c.habilitado) return 'desabilitado';
  if (c.envios_qtd > 0) return c.email_retornado ? 'retornado' : 'aguardando';
  return 'pendente';
}

router.get('/api/cpl-comunicacao/concessionarios', cpl, verGate, (req, res) => {
  const { status, busca } = req.query;
  const linhas = db.prepare(`
    SELECT * FROM cpl_parcelamento_concessionarios WHERE ocultado = 0 ORDER BY razao_social, codigo
  `).all().map(c => ({ ...c, situacao: situacaoConcessionario(c) }));
  let filtradas = linhas;
  if (status) filtradas = filtradas.filter(c => c.situacao === status);
  if (busca && String(busca).trim()) {
    const alvo = String(busca).trim().toLowerCase();
    filtradas = filtradas.filter(c =>
      String(c.codigo).includes(alvo) || (c.razao_social || '').toLowerCase().includes(alvo) ||
      (c.cnpj || '').includes(alvo) || (c.numero_ccu || '').toLowerCase().includes(alvo));
  }
  res.json(filtradas);
});

router.get('/api/cpl-comunicacao/concessionarios/:id', cpl, verGate, (req, res) => {
  const c = db.prepare(`SELECT * FROM cpl_parcelamento_concessionarios WHERE id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Concessionário não encontrado' });
  const envios = db.prepare(`
    SELECT e.id, e.teste, e.criado_em, f.status AS status_envio, f.erro_msg
    FROM cpl_parcelamento_envios e LEFT JOIN email_fila f ON f.id = e.email_fila_id
    WHERE e.concessionario_id = ? ORDER BY e.id DESC
  `).all(c.id);
  res.json({ ...c, situacao: situacaoConcessionario(c), envios });
});

router.get('/api/cpl-comunicacao/metricas', cpl, verGate, (req, res) => {
  const linhas = db.prepare(`SELECT * FROM cpl_parcelamento_concessionarios WHERE ocultado = 0`).all();
  const m = { total: linhas.length, pendente: 0, aguardando: 0, retornado: 0, informado: 0, desabilitado: 0, envios_total: 0 };
  linhas.forEach(c => { m[situacaoConcessionario(c)]++; m.envios_total += c.envios_qtd; });
  res.json(m);
});

// ── Ações sobre um concessionário ───────────────────────────────────────────
router.patch('/api/cpl-comunicacao/concessionarios/:id', cpl, alterarGate, (req, res) => {
  const c = db.prepare(`SELECT id FROM cpl_parcelamento_concessionarios WHERE id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Concessionário não encontrado' });
  const { observacao } = req.body || {};
  db.prepare(`UPDATE cpl_parcelamento_concessionarios SET observacao = ?, atualizado_em = datetime('now') WHERE id = ?`)
    .run(n(observacao), c.id);
  registrarLog(req, 'CPL', 'EDITOU_OBSERVACAO', `Editou a observação do concessionário #${c.id}`);
  res.json({ ok: true });
});

router.patch('/api/cpl-comunicacao/concessionarios/:id/autorizacao', cpl, alterarGate, (req, res) => {
  const c = db.prepare(`SELECT id, parcelas_informado FROM cpl_parcelamento_concessionarios WHERE id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Concessionário não encontrado' });
  const autorizado = !!(req.body || {}).autorizado;
  // Reautorizar não reabre quem já respondeu (parcelas_informado) — não teria
  // mais sentido pedir de novo. Desautorizar sempre desabilita o envio.
  const habilitado = autorizado && !c.parcelas_informado ? 1 : 0;
  db.prepare(`UPDATE cpl_parcelamento_concessionarios SET autorizado_cpl = ?, habilitado = ?, atualizado_em = datetime('now') WHERE id = ?`)
    .run(autorizado ? 1 : 0, habilitado, c.id);
  registrarLog(req, 'CPL', autorizado ? 'AUTORIZOU' : 'DESAUTORIZOU', `${autorizado ? 'Autorizou' : 'Desautorizou'} o envio pro concessionário #${c.id}`);
  res.json({ ok: true, habilitado: !!habilitado });
});

router.patch('/api/cpl-comunicacao/concessionarios/:id/retorno', cpl, alterarGate, (req, res) => {
  const c = db.prepare(`SELECT id FROM cpl_parcelamento_concessionarios WHERE id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Concessionário não encontrado' });
  const { parcelas_qtd, email_retornado } = req.body || {};
  if (!parcelas_qtd || !String(parcelas_qtd).trim()) return res.status(400).json({ error: 'Informe a quantidade de parcelas (ex: à vista, 12x, 60x).' });
  db.prepare(`
    UPDATE cpl_parcelamento_concessionarios
    SET parcelas_informado = 1, parcelas_qtd = ?, parcelas_origem = 'manual', email_retornado = ?,
        habilitado = 0, atualizado_em = datetime('now')
    WHERE id = ?
  `).run(String(parcelas_qtd).trim(), email_retornado === false ? 0 : 1, c.id);
  registrarLog(req, 'CPL', 'REGISTROU_RETORNO', `Registrou retorno do concessionário #${c.id}: ${String(parcelas_qtd).trim()}`);
  res.json({ ok: true });
});

router.delete('/api/cpl-comunicacao/concessionarios/:id', cpl, excluirGate, (req, res) => {
  const c = db.prepare(`SELECT id FROM cpl_parcelamento_concessionarios WHERE id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Concessionário não encontrado' });
  db.prepare(`UPDATE cpl_parcelamento_concessionarios SET ocultado = 1, atualizado_em = datetime('now') WHERE id = ?`).run(c.id);
  registrarLog(req, 'CPL', 'OCULTOU', `Ocultou o concessionário #${c.id} da lista`);
  res.json({ ok: true });
});

// ── Config (e-mail de teste interno) ────────────────────────────────────────
router.get('/api/cpl-comunicacao/config', cpl, verGate, (req, res) => {
  const email_teste_interno = db.prepare(`SELECT valor FROM config WHERE chave = 'cpl_email_teste_interno'`).get()?.valor || '';
  res.json({ email_teste_interno });
});

router.put('/api/cpl-comunicacao/config', cpl, alterarGate, (req, res) => {
  const { email_teste_interno } = req.body || {};
  db.prepare(`INSERT INTO config (chave, valor) VALUES ('cpl_email_teste_interno', ?)
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(String(email_teste_interno || '').trim());
  registrarLog(req, 'CPL', 'CONFIGUROU_TESTE', `Alterou o e-mail de teste interno`);
  res.json({ ok: true });
});

// ── Envio de e-mail (individual / seleção / em massa) ──────────────────────
// "Pacotes menores" contra blacklist (pedido explícito do Alex) já é
// estrutural: mailer.processarFila() só processa até 10 itens por tick de
// 60s (ver mailer.js) — enfileirar aqui N itens de uma vez já sai pro SMTP em
// lotes de 10/min automaticamente, sem precisar de lógica de agendamento
// própria nesta rota.
router.post('/api/cpl-comunicacao/enviar', cpl, incluirGate, (req, res) => {
  const { ids, modo_teste } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Nenhum concessionário selecionado.' });

  let emailTeste = null;
  if (modo_teste) {
    emailTeste = db.prepare(`SELECT valor FROM config WHERE chave = 'cpl_email_teste_interno'`).get()?.valor;
    if (!emailTeste || !emailTeste.trim()) {
      return res.status(400).json({ error: 'Cadastre o e-mail de teste interno antes de usar o modo teste.' });
    }
  }

  const enviados = [];
  const pulados = [];
  ids.forEach(id => {
    const c = db.prepare(`SELECT * FROM cpl_parcelamento_concessionarios WHERE id = ?`).get(id);
    if (!c || c.ocultado) { pulados.push({ id, motivo: 'não encontrado' }); return; }
    if (!modo_teste && (!c.habilitado || !c.autorizado_cpl)) { pulados.push({ id, motivo: 'desabilitado' }); return; }

    let destinatarios;
    if (modo_teste) {
      destinatarios = [{ email: emailTeste.trim(), nome: `[TESTE] ${c.razao_social || c.codigo}` }];
    } else {
      destinatarios = [c.email1, c.email2].filter(e => e && String(e).trim())
        .map(e => ({ email: String(e).trim() }));
      if (!destinatarios.length) { pulados.push({ id, motivo: 'sem e-mail cadastrado' }); return; }
    }

    const filaId = mailer.enfileirar('cpl.parcelamento.solicitacao', {
      concessionario_nome: c.razao_social || `Concessionário ${c.codigo}`,
      numero_ccu: c.numero_ccu,
    }, destinatarios, {});
    if (!filaId) { pulados.push({ id, motivo: 'falha ao enfileirar (template inativo ou sem conta de e-mail configurada)' }); return; }

    db.prepare(`INSERT INTO cpl_parcelamento_envios (concessionario_id, email_fila_id, teste, enviado_por) VALUES (?, ?, ?, ?)`)
      .run(c.id, filaId, modo_teste ? 1 : 0, req.user.user_id);
    if (!modo_teste) {
      db.prepare(`UPDATE cpl_parcelamento_concessionarios SET envios_qtd = envios_qtd + 1, ultimo_envio_em = datetime('now') WHERE id = ?`).run(c.id);
    }
    enviados.push(id);
  });

  registrarLog(req, 'CPL', modo_teste ? 'ENVIOU_TESTE' : 'ENVIOU_SOLICITACAO',
    `${modo_teste ? '[TESTE] ' : ''}Enfileirou solicitação de parcelamento pra ${enviados.length} concessionário(s), ${pulados.length} pulado(s)`);
  res.json({ enviados: enviados.length, pulados });
});

// ── Importação: planilha "já informado o parcelamento" ────────────────────
// Mesmo padrão de routes/secad-relatorios.js (client parseia via SheetJS,
// manda linhas já mapeadas; servidor valida/casa/confirma em 2 passos). Linha
// sem match em cpl_parcelamento_concessionarios ainda é registrada (cria um
// registro mínimo já desabilitado) — o objetivo é só "não precisa perguntar
// de novo pra este", independente da ordem em que os dois imports rodaram.
router.post('/api/cpl-comunicacao/importar-parcelamento-informado', cpl, requireAdminGlobal, (req, res) => {
  const { dry_run, nome_arquivo, linhas } = req.body || {};
  if (!Array.isArray(linhas) || !linhas.length) return res.status(400).json({ error: 'Nenhuma linha recebida.' });

  const existentes = new Set(
    db.prepare(`SELECT codigo, numero_ccu FROM cpl_parcelamento_concessionarios`).all()
      .map(r => `${r.codigo}|${normalizarCcu(r.numero_ccu)}`)
  );

  const validas = [];
  const invalidas = [];
  linhas.forEach((l, i) => {
    const codigo = parseInt(l.codigo, 10);
    const numero_ccu = normalizarCcu(l.numero_ccu);
    if (!codigo || !numero_ccu) { invalidas.push({ linha: i + 2, motivo: 'Código ou Nº do contrato vazio/inválido' }); return; }
    if (!l.parcelas_qtd || !String(l.parcelas_qtd).trim()) { invalidas.push({ linha: i + 2, motivo: 'Quantidade de parcelas vazia' }); return; }
    validas.push({
      codigo, numero_ccu, parcelas_qtd: String(l.parcelas_qtd).trim(),
      cnpj: l.cnpj ? String(l.cnpj).trim() : null,
      ja_existe: existentes.has(`${codigo}|${numero_ccu}`),
    });
  });

  if (dry_run) {
    return res.json({
      dry_run: true, total_linhas: linhas.length, validas: validas.length, invalidas: invalidas.length,
      invalidas_amostra: invalidas.slice(0, 30),
      ja_cadastrados: validas.filter(v => v.ja_existe).length,
      novos_registros: validas.filter(v => !v.ja_existe).length,
    });
  }

  const upsert = db.prepare(`
    INSERT INTO cpl_parcelamento_concessionarios (codigo, numero_ccu, cnpj, parcelas_informado, parcelas_qtd, parcelas_origem, habilitado, autorizado_cpl)
    VALUES (?, ?, ?, 1, ?, 'importacao', 0, 0)
    ON CONFLICT(codigo, numero_ccu) DO UPDATE SET
      parcelas_informado = 1, parcelas_qtd = excluded.parcelas_qtd, parcelas_origem = 'importacao',
      habilitado = 0, cnpj = COALESCE(cpl_parcelamento_concessionarios.cnpj, excluded.cnpj), atualizado_em = datetime('now')
  `);
  db.exec('BEGIN');
  try {
    validas.forEach(v => upsert.run(v.codigo, v.numero_ccu, v.cnpj, v.parcelas_qtd));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  registrarLog(req, 'CPL', 'IMPORTOU_PARCELAMENTO_INFORMADO',
    `Importou ${validas.length} linha(s) de parcelamento já informado (${nome_arquivo || 'sem nome'})`);
  res.json({ dry_run: false, total_linhas: validas.length });
});

module.exports = { router, sincronizarNovosAceites };
