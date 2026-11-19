// ── CPL: Comunicação Concessionários (parcelamento da outorga) ─────────────
// Pedido do Alex, 2026-11-18: concessionário que já deu aceite à renovação
// (ver renovacao_aceites, routes/secad-relatorios.js) mas cuja planilha de
// aceite não trazia o informe de quantas parcelas da outorga — esta tela
// deixa a CPL solicitar isso por e-mail (individual/seleção/em massa) e
// acompanhar quem já respondeu. Ver cpl_parcelamento_concessionarios em
// database.js pro modelo de dados — sem FK pro depop.db, mesma convenção já
// usada em validacao_contrato/renovacao_aceites (ligação só por valor).
//
// Carga inicial (renovacao_aceites já existente) e a 1ª aplicação da planilha
// "parcelamento já informado" foram feitas uma única vez, direto no banco
// (script descartável, nunca comitado) — ver [[project_secop_cpl_comunicacao]].
// Não existe mais rota de importação aqui: dali em diante o fluxo é 100% pela
// plataforma (sincronizarNovosAceites continua cobrindo só concessionário
// NOVO vindo de uma importação futura em SECAD/Relatórios). Teste de envio é
// em Admin → Comunicação → Templates ("Testar envio"), não neste módulo —
// pedido explícito do Alex pra não duplicar esse mecanismo.
const express = require('express');
const { db, depopDb } = require('../database');
const { registrarLog, requireModulo, requireRotina, n } = require('../middleware');
const mailer = require('../mailer');

const router = express.Router();
const cpl = requireModulo('cpl-comunicacao');
const verGate = requireRotina('comunicacao-parcelamento', 'ver');
const incluirGate = requireRotina('comunicacao-parcelamento', 'incluir');
const alterarGate = requireRotina('comunicacao-parcelamento', 'alterar');
const excluirGate = requireRotina('comunicacao-parcelamento', 'excluir');

function normalizarCcu(s) {
  return String(s || '').trim();
}

// Nome/cidade do concessionário não vêm da planilha de aceite (ela nunca
// teve essas colunas) — busca no depop.db por `codigo` (achado em
// 2026-11-18, depois do Alex ver a tela cheia de linha "sem nome"). Mesma
// fonte usada no backfill manual único: ClienteConcessionario.cliente (nome)
// e concessionario_cadastro.cidade (sync automático do Gateway a cada 6h).
// Nunca lança exceção — falha aqui não pode travar o cadastro/sincronização.
function enriquecerDoDepop(codigo) {
  try {
    const cliente = depopDb.prepare(`SELECT cliente FROM ClienteConcessionario WHERE codigo = ?`).get(codigo);
    const cadastro = depopDb.prepare(`SELECT cidade FROM concessionario_cadastro WHERE codigo = ? ORDER BY atualizado_em DESC LIMIT 1`).get(codigo);
    return { razao_social: cliente?.cliente || null, cidade: cadastro?.cidade || null };
  } catch (e) {
    console.error('[cpl] erro buscando nome/cidade no depop:', e.message);
    return { razao_social: null, cidade: null };
  }
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
      const existente = db.prepare(`SELECT id, razao_social, cidade FROM cpl_parcelamento_concessionarios WHERE codigo = ? AND numero_ccu = ?`).get(codigo, numero_ccu);
      if (existente) {
        // Já conhecido — só atualiza dados de contato/aceite, nunca o
        // progresso (habilitado/autorizado/parcelas) já decidido pela CPL.
        // Nome/cidade só preenche se ainda estiver em branco (nunca sobrescreve).
        const enriq = (!existente.razao_social || !existente.cidade) ? enriquecerDoDepop(codigo) : { razao_social: null, cidade: null };
        db.prepare(`
          UPDATE cpl_parcelamento_concessionarios
          SET cnpj = COALESCE(?, cnpj), email1 = ?, email2 = ?, telefone = ?, telefone_whatsapp = ?,
              data_aceite = ?, razao_social = COALESCE(razao_social, ?), cidade = COALESCE(cidade, ?),
              atualizado_em = datetime('now')
          WHERE id = ?
        `).run(n(l.cnpj), n(l.email1), n(l.email2), n(l.telefone), n(l.telefone_whatsapp), n(l.data_aceite),
          enriq.razao_social, enriq.cidade, existente.id);
        return;
      }
      // Novo concessionário com aceite — nasce pronto pra envio (habilitado +
      // autorizado), CPL que decide desautorizar se necessário (pedido
      // explícito do Alex: "ja inserir deixando o envio pronto, informar a
      // cpl e eles acessam e somente autorizam ou desautorizam"). Nome/cidade
      // vêm do depop (a planilha de aceite nunca trouxe essas colunas).
      const enriqNovo = enriquecerDoDepop(codigo);
      const info = db.prepare(`
        INSERT INTO cpl_parcelamento_concessionarios
          (codigo, numero_ccu, cnpj, razao_social, cidade, email1, email2, telefone, telefone_whatsapp, data_aceite, habilitado, autorizado_cpl)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
      `).run(codigo, numero_ccu, n(l.cnpj), enriqNovo.razao_social, enriqNovo.cidade, n(l.email1), n(l.email2), n(l.telefone), n(l.telefone_whatsapp), n(l.data_aceite));

      mailer.enfileirar('cpl.parcelamento.novo_concessionario', {
        concessionario_nome: enriqNovo.razao_social || `Concessionário ${codigo}`, codigo: String(codigo), numero_ccu,
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

// Desfaz um "parcelamento informado" registrado por engano (pedido do Alex,
// 2026-11-18: "preciso de uma forma de desinformar o aceite de parcelamento
// caso tenha erro"). Mesmo gate de alterar — a tela já esconde esta ação
// atrás de uma confirmação em 2 passos, não é 1 clique só. Volta a ficar
// disponível pra envio se ainda estiver autorizado pela CPL.
router.patch('/api/cpl-comunicacao/concessionarios/:id/desfazer-informado', cpl, alterarGate, (req, res) => {
  const c = db.prepare(`SELECT id, autorizado_cpl, parcelas_informado, parcelas_qtd FROM cpl_parcelamento_concessionarios WHERE id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Concessionário não encontrado' });
  if (!c.parcelas_informado) return res.status(400).json({ error: 'Este concessionário não está marcado como parcelamento informado.' });
  db.prepare(`
    UPDATE cpl_parcelamento_concessionarios
    SET parcelas_informado = 0, parcelas_qtd = NULL, parcelas_origem = NULL, email_retornado = 0,
        habilitado = ?, atualizado_em = datetime('now')
    WHERE id = ?
  `).run(c.autorizado_cpl ? 1 : 0, c.id);
  registrarLog(req, 'CPL', 'DESFEZ_PARCELAMENTO_INFORMADO', `Desfez o parcelamento informado do concessionário #${c.id} (era: ${c.parcelas_qtd || '—'})`);
  res.json({ ok: true });
});

router.delete('/api/cpl-comunicacao/concessionarios/:id', cpl, excluirGate, (req, res) => {
  const c = db.prepare(`SELECT id FROM cpl_parcelamento_concessionarios WHERE id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Concessionário não encontrado' });
  db.prepare(`UPDATE cpl_parcelamento_concessionarios SET ocultado = 1, atualizado_em = datetime('now') WHERE id = ?`).run(c.id);
  registrarLog(req, 'CPL', 'OCULTOU', `Ocultou o concessionário #${c.id} da lista`);
  res.json({ ok: true });
});

// ── Envio de e-mail (individual / seleção / em massa) ──────────────────────
// "Pacotes menores" contra blacklist (pedido explícito do Alex) já é
// estrutural: mailer.processarFila() só processa até 10 itens por tick de
// 60s (ver mailer.js) — enfileirar aqui N itens de uma vez já sai pro SMTP em
// lotes de 10/min automaticamente, sem precisar de lógica de agendamento
// própria nesta rota. Teste de template/conteúdo é feito em Admin →
// Comunicação → Templates ("Testar envio") — não existe modo teste aqui
// (pedido do Alex, 2026-11-18: o teste de e-mail é assunto da Comunicação
// transversal, não deste módulo).
router.post('/api/cpl-comunicacao/enviar', cpl, incluirGate, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Nenhum concessionário selecionado.' });

  const enviados = [];
  const pulados = [];
  ids.forEach(id => {
    const c = db.prepare(`SELECT * FROM cpl_parcelamento_concessionarios WHERE id = ?`).get(id);
    if (!c || c.ocultado) { pulados.push({ id, motivo: 'não encontrado' }); return; }
    if (!c.habilitado || !c.autorizado_cpl) { pulados.push({ id, motivo: 'desabilitado' }); return; }

    const destinatarios = [c.email1, c.email2].filter(e => e && String(e).trim())
      .map(e => ({ email: String(e).trim() }));
    if (!destinatarios.length) { pulados.push({ id, motivo: 'sem e-mail cadastrado' }); return; }

    const filaId = mailer.enfileirar('cpl.parcelamento.solicitacao', {
      concessionario_nome: c.razao_social || `Concessionário ${c.codigo}`,
      numero_ccu: c.numero_ccu,
    }, destinatarios, {});
    if (!filaId) { pulados.push({ id, motivo: 'falha ao enfileirar (template inativo ou sem conta de e-mail configurada)' }); return; }

    db.prepare(`INSERT INTO cpl_parcelamento_envios (concessionario_id, email_fila_id, teste, enviado_por) VALUES (?, ?, 0, ?)`)
      .run(c.id, filaId, req.user.user_id);
    db.prepare(`UPDATE cpl_parcelamento_concessionarios SET envios_qtd = envios_qtd + 1, ultimo_envio_em = datetime('now') WHERE id = ?`).run(c.id);
    enviados.push(id);
  });

  registrarLog(req, 'CPL', 'ENVIOU_SOLICITACAO',
    `Enfileirou solicitação de parcelamento pra ${enviados.length} concessionário(s), ${pulados.length} pulado(s)`);
  res.json({ enviados: enviados.length, pulados });
});

module.exports = { router, sincronizarNovosAceites };
