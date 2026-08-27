// ── SECAD (ex-Depop): validação de contratos + Comunicados ────────────────────
// Extraído de server.js na modularização por módulo — zero mudança de
// comportamento. Cada rota leva `requireModulo('secad')` explícito (const
// `secad` abaixo) em vez do antigo `app.use('/api/secad', requireModulo(...))`
// blanket — ver C:\Users\alex.nascimento\.claude\plans\linear-puzzling-rain.md.
//
// Usa as 3 conexões: `db` (secop.db — depop_perfil/validacao_contrato/
// validacao_lock/parametro_sistema/comunicado_gerado, todas fisicamente no
// secop.db apesar do nome), `depopDb` (mirror externo, só leitura) e
// `anexosDb` (BLOBs de comprovante_entrega).
//
// NÃO estão aqui (ficam em routes/admin.js de propósito — ver comentário no
// topo daquele arquivo): GET /api/admin/cpfhub (status da chave), GET/POST
// /api/admin/export|import-depop-db, e /api/admin/concessionarios-removidos*
// — todas essas dão suporte ao SECAD mas não são gateadas por módulo hoje
// (só por requireAdminAny), então ficam fisicamente com o resto do admin pra
// não correr o risco de aplicar o gate de módulo nelas por engano.
const express = require('express');
const { db, depopDb, anexosDb } = require('../database');
const crypto = require('crypto');
const { registrarLog, requireModulo, requireRotina, getCpfHubKey } = require('../middleware');

const router = express.Router();
const secad = requireModulo('secad');

// ── SECAD: perfil de assinatura (CPF + par de chaves) ─────────────────────────

// Validação de CPF pelo algoritmo dos dígitos verificadores (mesma regra da
// Receita) — offline, sem consulta externa. Rejeita tamanho errado e as
// sequências repetidas (000..., 111...) que passam na conta mas são inválidas.
function cpfValido(cpf) {
  cpf = String(cpf || '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const dv = (fatorInicial) => {
    let soma = 0;
    for (let i = 0; i < fatorInicial - 1; i++) soma += parseInt(cpf[i], 10) * (fatorInicial - i);
    const resto = 11 - (soma % 11);
    return resto >= 10 ? 0 : resto;
  };
  return dv(10) === parseInt(cpf[9], 10) && dv(11) === parseInt(cpf[10], 10);
}

// (Assinatura por par de chaves EC removida: a validação passou a ser confirmada
// pela senha de LOGIN do próprio usuário + timbre SHA-256 verificável — uma senha
// só. Ver POST /api/secad/contratos/:id/validar. As colunas chave_* de
// depop_perfil viram legado, gravadas vazias.)

// ── Consulta de CPF na API externa (cpfhub.io) ────────────────────────────────
// A chave fica no config (chave 'cpfhub_api_key', gerenciada nos Parâmetros do
// admin) e NUNCA vai pro frontend (ver CONFIG_SECRETA). Fallback: variável de
// ambiente CPFHUB_API_KEY.

// Cache curto das consultas — o plano grátis é só ~50 consultas, então evitamos
// bater 2x (uma ao digitar o CPF, outra ao salvar o perfil). Chave = CPF limpo.
const _cpfCache = new Map(); // cpf -> { fonte, existe, nome, ts }
const CPF_CACHE_TTL = 15 * 60 * 1000;

// Consulta o CPF na cpfhub.io. Retorna { fonte:'api'|'offline', existe, nome }.
// fonte 'offline' = não deu pra confirmar (sem chave / API fora / cota estourada)
// → o chamador aceita com base nos dígitos. fonte 'api' + existe:false = a API
// respondeu que o CPF não existe (aí bloqueia).
async function consultarCpfApi(cpfLimpo) {
  const cache = _cpfCache.get(cpfLimpo);
  if (cache && (Date.now() - cache.ts) < CPF_CACHE_TTL) return cache;

  const key = getCpfHubKey();
  let out;
  if (!key) {
    out = { fonte: 'offline', existe: null, nome: null };
  } else {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(`https://api.cpfhub.io/cpf/${cpfLimpo}`, {
        headers: { 'x-api-key': key, 'Accept': 'application/json' },
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (!r.ok) {
        out = { fonte: 'offline', existe: null, nome: null }; // 401/429/5xx → cai pra offline
      } else {
        const j = await r.json().catch(() => null);
        if (j && j.success && j.data) {
          out = { fonte: 'api', existe: true, nome: j.data.name || j.data.nome || null };
        } else {
          out = { fonte: 'api', existe: false, nome: null };
        }
      }
    } catch {
      out = { fonte: 'offline', existe: null, nome: null };
    }
  }
  out.ts = Date.now();
  _cpfCache.set(cpfLimpo, out);
  return out;
}

// Consulta um CPF: valida dígitos offline e, se passar, confirma na API e
// devolve o nome (pra tela mostrar antes de salvar). Não grava nada.
router.post('/api/secad/consultar-cpf', secad, async (req, res) => {
  const cpfLimpo = String((req.body && req.body.cpf) || '').replace(/\D/g, '');
  if (!cpfValido(cpfLimpo)) return res.json({ valido: false, motivo: 'digitos', error: 'CPF inválido.' });
  const r = await consultarCpfApi(cpfLimpo);
  if (r.fonte === 'api' && r.existe === false) {
    return res.json({ valido: false, motivo: 'nao_encontrado', error: 'CPF não encontrado na base da Receita.' });
  }
  res.json({ valido: true, nome: r.nome || null, fonte: r.fonte });
});

// Situação do perfil do usuário logado (o front decide se mostra o cadastro de
// 1º acesso ou o conteúdo). Nunca devolve chave privada; CPF vem mascarado.
router.get('/api/secad/perfil', secad, (req, res) => {
  const ferramenta = perfilFerramenta(req); // 'master' | 'validador'
  const caps = secadCaps(req);
  const perfil = db.prepare(`SELECT cpf, nome, criado_em FROM depop_perfil WHERE user_id = ?`).get(req.user.user_id);
  const cadastrado = !!perfil;
  // Só passa pelo cadastro de 1º acesso (CPF) quem vai VALIDAR: master (supervisor),
  // usuário só-comunicados e consulta (só leitura) não assinam, então não precisam.
  const precisa_setup = !caps.is_master && !caps.is_consulta && caps.pode_validar && !cadastrado;
  const cpfMasc = perfil ? perfil.cpf.replace(/^(\d{3})\d{6}(\d{2})$/, '$1.***.**-$2') : null;
  res.json({ cadastrado, precisa_setup, perfil: ferramenta, caps, nome: req.user.username,
             nome_titular: perfil ? perfil.nome : null,
             cpf_mascarado: cpfMasc, criado_em: perfil ? perfil.criado_em : null });
});

// Cadastro de 1º acesso: CPF (validado) + senha de assinatura → gera e guarda o
// par de chaves. Só uma vez por usuário; CPF é único no módulo.
router.post('/api/secad/perfil', secad, async (req, res) => {
  const { cpf } = req.body || {};
  const ja = db.prepare(`SELECT 1 FROM depop_perfil WHERE user_id = ?`).get(req.user.user_id);
  if (ja) return res.status(400).json({ error: 'Perfil já configurado' });
  const cpfLimpo = String(cpf || '').replace(/\D/g, '');
  if (!cpfValido(cpfLimpo)) return res.status(400).json({ error: 'CPF inválido' });
  const donoCpf = db.prepare(`SELECT user_id FROM depop_perfil WHERE cpf = ?`).get(cpfLimpo);
  if (donoCpf) return res.status(400).json({ error: 'Este CPF já está cadastrado por outro usuário' });

  // Confirma o CPF na API e captura o nome (cai pra offline se a API não responder).
  const info = await consultarCpfApi(cpfLimpo);
  if (info.fonte === 'api' && info.existe === false) {
    return res.status(400).json({ error: 'CPF não encontrado na base da Receita.' });
  }
  const nome = info.nome || null;

  // Sem par de chaves: a assinatura da validação usa a senha de login + timbre.
  // As colunas chave_* (NOT NULL, legado) ficam vazias.
  db.prepare(`INSERT INTO depop_perfil (user_id, cpf, chave_publica, chave_privada_pem, nome) VALUES (?, ?, '', '', ?)`)
    .run(req.user.user_id, cpfLimpo, nome);
  registrarLog(req, 'SECAD', 'PERFIL', `Cadastrou CPF no SECAD${info.fonte === 'offline' ? ' (validado offline)' : ''}`);
  res.status(201).json({ ok: true, nome });
});

// ── SECAD: ferramenta de validação de contratos ───────────────────────────────
// Confere, contrato a contrato, os dados vindos das planilhas (carregados no
// depop.db, só leitura). Cada validação fica assinada; o registro vive no
// secop.db (validacao_contrato). Concorrência: um contrato aberto por um
// validador trava os demais (validacao_lock, com heartbeat).

const LOCK_TTL_SEG = 120; // trava sem ping por mais que isso = abandonada (libera)

// Supervisor (o usuário 'master' da plataforma): só lê e exporta PDF, nunca
// assina nem marca erro. Todos os demais usuários do SECAD são validadores.
function perfilFerramenta(req) {
  return req.user.username === 'master' ? 'master' : 'validador';
}

// Capacidades do usuário DENTRO do módulo SECAD, pro FRONT decidir o que
// mostrar (a guarda de verdade nas rotas é requireRotina, mais abaixo). Deriva
// da flag "ver" do Perfil do usuário nas rotinas validacao/comunicados — quem
// não tem "ver" numa delas nem enxerga aquela seção na tela.
function secadCaps(req) {
  if (req.user.username === 'master') return { is_master: true, is_consulta: false, pode_validar: true, pode_comunicados: true };
  if (req.user.role === 'consulta') return { is_master: false, is_consulta: true, pode_validar: true, pode_comunicados: true };
  if (!req.user.perfil_id) return { is_master: false, is_consulta: false, pode_validar: false, pode_comunicados: false };
  const rows = db.prepare(`
    SELECT r.slug, pr.ver
    FROM perfil_rotinas pr JOIN rotinas r ON r.id = pr.rotina_id
    WHERE pr.perfil_id = ? AND r.slug IN ('validacao', 'comunicados')
  `).all(req.user.perfil_id);
  const mapa = Object.fromEntries(rows.map(r => [r.slug, !!r.ver]));
  return { is_master: false, is_consulta: false, pode_validar: !!mapa.validacao, pode_comunicados: !!mapa.comunicados };
}

// Trava ativa (com ping recente) de um contrato, ou null se livre/abandonada.
function travaAtiva(idAvaliacao) {
  const l = db.prepare(`
    SELECT id_avaliacao, user_id, nome,
           CAST((julianday('now') - julianday(ultimo_ping)) * 86400 AS INTEGER) AS idade
    FROM validacao_lock WHERE id_avaliacao = ?`).get(idAvaliacao);
  if (!l || l.idade > LOCK_TTL_SEG) return null;
  return l;
}

// Códigos de concessionário removidos da listagem (soft-remove, ver
// concessionario_removido no secop.db) — usado pra filtrar dashboard, listagem
// e geração de comunicados. O registro em si nunca sai do depop.db.
function codigosRemovidos() {
  return db.prepare(`SELECT codigo FROM concessionario_removido`).all().map(r => r.codigo);
}

// Detalhe completo de um contrato: resumo (do concessionário) + linhas de tarifa
// + estado de validação. Lê o depop.db (referência) e o secop.db (validação).
function montarDetalhe(idAvaliacao) {
  const a = depopDb.prepare(`
    SELECT a.id, a.id_contrato, a.codigo, a.concessionaria, a.numero_ccu,
           a.data_vencimento, a.valor_ponto, a.valor_30_ceasa, a.Status,
           cli.cliente, cli.endereco AS endereco, cli.cpf_cnpj, cli.insc_estadual,
           cli.bairro, cli.cep, c.descricao AS cidade
    FROM AvaliacaoAreaRenovacao a
    LEFT JOIN ClienteConcessionario cli ON cli.codigo = a.codigo
    LEFT JOIN Cidade c ON c.id = a.id_cidade
    WHERE a.id = ?`).get(idAvaliacao);
  if (!a) return null;
  // id_contrato identifica o CCU/box, não o inquilino — a mesma vaga pode ter
  // linhas de tarifa de concessionários diferentes ao longo dos anos (troca de
  // inquilino). Filtra também por codigo pra pegar só as linhas do inquilino
  // atual, não misturar com histórico de quem ocupou o box antes.
  const linhas = depopDb.prepare(`
    SELECT sequencial, concessionario, endereco, area_m2, atual_tarifa_uso, nova_tarifa_uso
    FROM TarifaContrato20Anos WHERE id_contrato = ? AND codigo = ? ORDER BY sequencial`).all(a.id_contrato, a.codigo);
  const v = db.prepare(`
    SELECT vc.status, vc.observacao, vc.solucao, vc.dt_validacao, vc.hash_assinatura,
           COALESCE(dp.nome, u.username) AS validador
    FROM validacao_contrato vc
    LEFT JOIN users u ON u.id = vc.id_usuario_validador
    LEFT JOIN depop_perfil dp ON dp.user_id = vc.id_usuario_validador
    WHERE vc.id_avaliacao = ?`).get(idAvaliacao);
  return {
    id: a.id, id_contrato: a.id_contrato, codigo: a.codigo,
    concessionario: a.cliente || a.concessionaria, endereco: a.endereco,
    cpf_cnpj: a.cpf_cnpj, insc_estadual: a.insc_estadual, bairro: a.bairro, cep: a.cep,
    cidade: a.cidade, numero_ccu: a.numero_ccu, data_vencimento: a.data_vencimento,
    valor_ponto: a.valor_ponto, valor_30_ceasa: a.valor_30_ceasa, reg_status: a.Status,
    linhas,
    validacao: v || { status: 'pendente' }
  };
}

// String canônica que é de fato assinada — decimais fixados em 2 casas pra ser
// estável entre execuções (base do não-repúdio: o que o validador conferiu).
function payloadContrato(det, cpf, iso) {
  return JSON.stringify({
    id_contrato: det.id_contrato,
    valor_ponto: Number(det.valor_ponto || 0).toFixed(2),
    valor_30_ceasa: Number(det.valor_30_ceasa || 0).toFixed(2),
    linhas: det.linhas.map(l => ({
      seq: l.sequencial,
      area: Number(l.area_m2 || 0).toFixed(2),
      atual: Number(l.atual_tarifa_uso || 0).toFixed(2),
      nova: Number(l.nova_tarifa_uso || 0).toFixed(2)
    })),
    cpf, dt: iso
  });
}

// Indicadores da tela inicial.
router.get('/api/secad/dashboard', secad, (req, res) => {
  const removidos = new Set(codigosRemovidos());
  const avals = depopDb.prepare(`SELECT id, id_contrato, codigo, id_cidade FROM AvaliacaoAreaRenovacao`)
    .all().filter(a => !removidos.has(a.codigo));

  const totalContratos = avals.length;
  const totalConcess = new Set(avals.map(a => a.codigo)).size;

  const linhas = depopDb.prepare(`SELECT codigo, id_contrato, area_m2, atual_tarifa_uso, nova_tarifa_uso FROM TarifaContrato20Anos`)
    .all().filter(l => !removidos.has(l.codigo));
  const linhasAgg = {
    total: linhas.length,
    area: linhas.reduce((s, l) => s + (l.area_m2 || 0), 0),
    ma: linhas.length ? linhas.reduce((s, l) => s + (l.atual_tarifa_uso || 0), 0) / linhas.length : 0,
    mn: linhas.length ? linhas.reduce((s, l) => s + (l.nova_tarifa_uso || 0), 0) / linhas.length : 0
  };
  const idContratosComLinha = new Set(depopDb.prepare(`SELECT DISTINCT id_contrato FROM TarifaContrato20Anos`).all().map(r => r.id_contrato));
  const semLinha = avals.filter(a => !idContratosComLinha.has(a.id_contrato)).length;

  const idsValidos = new Set(avals.map(a => a.id));
  const vRows = db.prepare(`SELECT id_avaliacao, status FROM validacao_contrato`).all();
  let validados = 0, errados = 0;
  for (const r of vRows) {
    if (!idsValidos.has(r.id_avaliacao)) continue;
    if (r.status === 'validado') validados++;
    else if (r.status === 'errado') errados++;
  }
  const emAberto = totalContratos - validados - errados;
  const pct = totalContratos ? Math.round((validados / totalContratos) * 1000) / 10 : 0;

  const cidadeNome = new Map(depopDb.prepare(`SELECT id, descricao FROM Cidade`).all().map(c => [c.id, c.descricao]));
  const porCidadeMap = new Map();
  for (const a of avals) {
    const o = porCidadeMap.get(a.id_cidade) || { contratos: 0, codigos: new Set() };
    o.contratos++;
    o.codigos.add(a.codigo);
    porCidadeMap.set(a.id_cidade, o);
  }
  const cidades = [...porCidadeMap.entries()]
    .map(([id, o]) => ({ id, cidade: cidadeNome.get(id) || '—', contratos: o.contratos, concessionarios: o.codigos.size }))
    .sort((x, y) => y.contratos - x.contratos);

  // % de validação por cidade (cruzando cidade do depop.db com status do secop.db)
  const vmap = new Map(vRows.map(r => [r.id_avaliacao, r.status]));
  const porCid = new Map();
  for (const a of avals) {
    const o = porCid.get(a.id_cidade) || { total: 0, val: 0 };
    o.total++;
    if (vmap.get(a.id) === 'validado') o.val++;
    porCid.set(a.id_cidade, o);
  }
  const ranking = cidades.map(c => {
    const o = porCid.get(c.id) || { total: 0, val: 0 };
    return { cidade: c.cidade, pct: o.total ? Math.round((o.val / o.total) * 1000) / 10 : 0 };
  }).sort((x, y) => x.pct - y.pct).slice(0, 3);

  res.json({
    total_contratos: totalContratos, total_concessionarios: totalConcess,
    validados, errados, em_aberto: emAberto, pct_validacao: pct,
    total_linhas: linhasAgg.total, metragem_total: linhasAgg.area,
    media_tarifa_atual: linhasAgg.ma, media_tarifa_nova: linhasAgg.mn,
    sem_linha: semLinha,
    media_linhas_por_contrato: totalContratos ? Math.round((linhasAgg.total / totalContratos) * 10) / 10 : 0,
    por_cidade: cidades, ranking_pior: ranking
  });
});

// Lista completa (o front filtra por aba/cidade/busca e agrupa por concessionário).
router.get('/api/secad/contratos', secad, (req, res) => {
  const removidos = new Set(codigosRemovidos());
  const avals = depopDb.prepare(`
    SELECT a.id, a.id_contrato, a.codigo, a.numero_ccu, a.valor_ponto, a.valor_30_ceasa,
           a.Status AS reg_status, a.concessionaria, cli.cliente, c.descricao AS cidade
    FROM AvaliacaoAreaRenovacao a
    LEFT JOIN ClienteConcessionario cli ON cli.codigo = a.codigo
    LEFT JOIN Cidade c ON c.id = a.id_cidade
    ORDER BY c.descricao, cli.cliente, a.id_contrato`).all().filter(a => !removidos.has(a.codigo));

  const vmap = new Map(db.prepare(`SELECT id_avaliacao, status FROM validacao_contrato`).all().map(r => [r.id_avaliacao, r.status]));
  const lockMap = new Map();
  for (const l of db.prepare(`
    SELECT id_avaliacao, user_id, nome,
           CAST((julianday('now') - julianday(ultimo_ping)) * 86400 AS INTEGER) AS idade
    FROM validacao_lock`).all()) {
    if (l.idade <= LOCK_TTL_SEG) lockMap.set(l.id_avaliacao, l);
  }

  const contratos = avals.map(a => {
    const lk = lockMap.get(a.id);
    return {
      id: a.id, id_contrato: a.id_contrato, codigo: a.codigo,
      concessionario: a.cliente || a.concessionaria || '—', cidade: a.cidade || '—',
      numero_ccu: a.numero_ccu, valor_ponto: a.valor_ponto, valor_30_ceasa: a.valor_30_ceasa,
      reg_status: a.reg_status,
      status: vmap.get(a.id) || 'pendente',
      lock: lk ? { nome: lk.nome, por_mim: lk.user_id === req.user.user_id } : null
    };
  });
  res.json({ perfil: perfilFerramenta(req), contratos });
});

// Abre o preview de um contrato. Validador toma a trava (ou 409 se estiver com
// outro); supervisor só visualiza, sem travar e sem ser travado.
router.post('/api/secad/contratos/:id/abrir', secad, requireRotina('validacao', 'ver'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const det = montarDetalhe(id);
  if (!det) return res.status(404).json({ error: 'Contrato não encontrado' });

  // Contrato já validado é final: abre só em leitura, sem travar (nem pra quem
  // for validador) — não dá mais pra assinar nem marcar erro.
  if (det.validacao && det.validacao.status === 'validado') {
    return res.json({ perfil: perfilFerramenta(req), detalhe: det, lock: null });
  }
  // Consulta (só leitura) e supervisor (master): abrem em leitura, sem travar.
  if (req.user.role === 'consulta') {
    return res.json({ perfil: 'consulta', detalhe: det, lock: null });
  }
  if (perfilFerramenta(req) === 'master') {
    return res.json({ perfil: 'master', detalhe: det, lock: null });
  }
  const trava = travaAtiva(id);
  if (trava && trava.user_id !== req.user.user_id) {
    return res.status(409).json({ error: `Contrato em uso por ${trava.nome || 'outro validador'}.`, em_uso_por: trava.nome });
  }
  db.prepare(`
    INSERT INTO validacao_lock (id_avaliacao, user_id, nome, aberto_em, ultimo_ping)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id_avaliacao) DO UPDATE SET
      user_id = excluded.user_id, nome = excluded.nome, ultimo_ping = datetime('now')`)
    .run(id, req.user.user_id, req.user.username);
  res.json({ perfil: 'validador', detalhe: det, lock: { por_mim: true } });
});

// Heartbeat da trava enquanto o preview está aberto.
router.post('/api/secad/contratos/:id/ping', secad, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const info = db.prepare(`UPDATE validacao_lock SET ultimo_ping = datetime('now') WHERE id_avaliacao = ? AND user_id = ?`)
    .run(id, req.user.user_id);
  res.json({ ok: info.changes > 0 });
});

// Libera a trava ao fechar o preview.
router.post('/api/secad/contratos/:id/fechar', secad, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare(`DELETE FROM validacao_lock WHERE id_avaliacao = ? AND user_id = ?`).run(id, req.user.user_id);
  res.json({ ok: true });
});

// Confirmar e assinar: assina o payload canônico com a chave do validador
// (destravada pela senha de assinatura) e grava status 'validado' + timbre.
router.post('/api/secad/contratos/:id/validar', secad, requireRotina('validacao', 'incluir'), (req, res) => {
  if (perfilFerramenta(req) === 'master') return res.status(403).json({ error: 'O supervisor não assina validações.' });
  const id = parseInt(req.params.id, 10);
  const { senha } = req.body || {};

  const trava = travaAtiva(id);
  if (trava && trava.user_id !== req.user.user_id) {
    return res.status(409).json({ error: `Contrato em uso por ${trava.nome || 'outro validador'}.` });
  }
  const det = montarDetalhe(id);
  if (!det) return res.status(404).json({ error: 'Contrato não encontrado' });
  if (det.validacao && det.validacao.status === 'validado') {
    return res.status(409).json({ error: 'Este contrato já foi validado e não pode ser assinado novamente.' });
  }

  const perfil = db.prepare(`SELECT cpf, nome FROM depop_perfil WHERE user_id = ?`).get(req.user.user_id);
  if (!perfil) return res.status(400).json({ error: 'Cadastre seu CPF antes de validar.' });
  if (!senha) return res.status(400).json({ error: 'Informe sua senha para assinar.' });

  // Confirma com a senha de LOGIN do próprio usuário (uma senha só no sistema).
  const u = db.prepare(`SELECT senha_hash, salt FROM users WHERE id = ?`).get(req.user.user_id);
  const h = crypto.pbkdf2Sync(String(senha), u.salt, 100000, 64, 'sha512').toString('hex');
  if (h !== u.senha_hash) return res.status(401).json({ error: 'Senha incorreta.' });

  const iso = new Date().toISOString();
  const nome = perfil.nome || req.user.username;
  // Timbre verificável: hash dos valores conferidos (payload canônico) + a
  // identidade de quem assinou + o instante. Recalculável para conferência.
  const timbre = crypto.createHash('sha256')
    .update(`${payloadContrato(det, perfil.cpf, iso)}|${nome}|${req.user.username}`)
    .digest('hex');

  db.prepare(`
    INSERT INTO validacao_contrato (id_avaliacao, status, observacao, id_usuario_validador, dt_validacao, hash_assinatura, assinatura_b64)
    VALUES (?, 'validado', NULL, ?, ?, ?, NULL)
    ON CONFLICT(id_avaliacao) DO UPDATE SET
      status = 'validado', observacao = NULL, id_usuario_validador = excluded.id_usuario_validador,
      dt_validacao = excluded.dt_validacao, hash_assinatura = excluded.hash_assinatura,
      assinatura_b64 = NULL`)
    .run(id, req.user.user_id, iso, timbre);
  db.prepare(`DELETE FROM validacao_lock WHERE id_avaliacao = ?`).run(id);
  registrarLog(req, 'SECAD', 'VALIDOU', `Validou contrato CCU ${det.numero_ccu || det.id_contrato}`);
  res.json({ ok: true, timbre: timbre.slice(0, 12), dt_validacao: iso, validador: nome });
});

// Marcar como errado: grava o problema (observação) E a solução — as duas são
// obrigatórias, pra quem for reabrir (ou só olhar) já saber o que corrigir.
router.post('/api/secad/contratos/:id/errado', secad, requireRotina('validacao', 'incluir'), (req, res) => {
  if (perfilFerramenta(req) === 'master') return res.status(403).json({ error: 'O supervisor não marca erros.' });
  const id = parseInt(req.params.id, 10);
  const obs = String((req.body && req.body.observacao) || '').trim();
  const solucao = String((req.body && req.body.solucao) || '').trim();
  if (!obs) return res.status(400).json({ error: 'Descreva o que está errado.' });
  if (!solucao) return res.status(400).json({ error: 'Descreva a solução.' });

  const trava = travaAtiva(id);
  if (trava && trava.user_id !== req.user.user_id) {
    return res.status(409).json({ error: `Contrato em uso por ${trava.nome || 'outro validador'}.` });
  }
  const det = montarDetalhe(id);
  if (!det) return res.status(404).json({ error: 'Contrato não encontrado' });
  if (det.validacao && det.validacao.status === 'validado') {
    return res.status(409).json({ error: 'Este contrato já foi validado — não pode ser marcado como errado.' });
  }

  const iso = new Date().toISOString();
  db.prepare(`
    INSERT INTO validacao_contrato (id_avaliacao, status, observacao, solucao, id_usuario_validador, dt_validacao, hash_assinatura, assinatura_b64)
    VALUES (?, 'errado', ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(id_avaliacao) DO UPDATE SET
      status = 'errado', observacao = excluded.observacao, solucao = excluded.solucao,
      id_usuario_validador = excluded.id_usuario_validador,
      dt_validacao = excluded.dt_validacao, hash_assinatura = NULL, assinatura_b64 = NULL`)
    .run(id, obs, solucao, req.user.user_id, iso);
  db.prepare(`DELETE FROM validacao_lock WHERE id_avaliacao = ?`).run(id);
  registrarLog(req, 'SECAD', 'ERRO', `Marcou erro no contrato CCU ${det.numero_ccu || det.id_contrato}: ${obs.slice(0, 120)} | Solução: ${solucao.slice(0, 120)}`);
  res.json({ ok: true });
});

// Voltar um contrato marcado como ERRADO para "A Validar" (só supervisor/master).
// Remove a marcação de erro → volta a 'pendente' pra um validador reconferir.
router.post('/api/secad/contratos/:id/reabrir', secad, requireRotina('validacao', 'alterar'), (req, res) => {
  if (perfilFerramenta(req) !== 'master') return res.status(403).json({ error: 'Apenas o supervisor pode reabrir um contrato.' });
  const id = parseInt(req.params.id, 10);
  const v = db.prepare(`SELECT status FROM validacao_contrato WHERE id_avaliacao = ?`).get(id);
  if (!v || v.status !== 'errado') return res.status(409).json({ error: 'Só contratos marcados como errado voltam para A Validar por aqui.' });
  const det = montarDetalhe(id);
  db.prepare(`DELETE FROM validacao_contrato WHERE id_avaliacao = ?`).run(id);
  db.prepare(`DELETE FROM validacao_lock WHERE id_avaliacao = ?`).run(id);
  registrarLog(req, 'SECAD', 'REABRIU', `Voltou p/ A Validar o contrato CCU ${det ? (det.numero_ccu || det.id_contrato) : id} (estava errado)`);
  res.json({ ok: true });
});

// Cancelar assinatura (só supervisor/master): desfaz uma validação já assinada e
// devolve o contrato para 'pendente', permitindo nova conferência/assinatura. É
// uma ação sensível sobre um registro assinado — exige a senha de login do master
// e um motivo, e fica registrada no log. Se já havia comunicado gerado, avisa.
router.post('/api/secad/contratos/:id/cancelar-validacao', secad, requireRotina('validacao', 'alterar'), (req, res) => {
  if (perfilFerramenta(req) !== 'master') return res.status(403).json({ error: 'Apenas o supervisor pode cancelar uma assinatura.' });
  const id = parseInt(req.params.id, 10);
  const { senha, motivo } = req.body || {};
  const just = String(motivo || '').trim();
  if (!senha) return res.status(400).json({ error: 'Informe sua senha para cancelar a assinatura.' });
  if (!just) return res.status(400).json({ error: 'Descreva o motivo do cancelamento.' });

  const v = db.prepare(`SELECT status FROM validacao_contrato WHERE id_avaliacao = ?`).get(id);
  if (!v || v.status !== 'validado') return res.status(409).json({ error: 'Este contrato não está assinado.' });

  // Confirma com a senha de LOGIN do próprio master (mesma regra da assinatura).
  const u = db.prepare(`SELECT senha_hash, salt FROM users WHERE id = ?`).get(req.user.user_id);
  const h = crypto.pbkdf2Sync(String(senha), u.salt, 100000, 64, 'sha512').toString('hex');
  if (h !== u.senha_hash) return res.status(401).json({ error: 'Senha incorreta.' });

  const det = montarDetalhe(id);
  const com = db.prepare(`SELECT geracoes FROM comunicado_gerado WHERE id_avaliacao = ?`).get(id);
  const alerta = !!(com && com.geracoes > 0);

  // Remove a validação → volta para 'pendente'; solta qualquer trava pendente.
  db.prepare(`DELETE FROM validacao_contrato WHERE id_avaliacao = ?`).run(id);
  db.prepare(`DELETE FROM validacao_lock WHERE id_avaliacao = ?`).run(id);

  const ref = det ? (det.numero_ccu || det.id_contrato) : id;
  registrarLog(req, 'SECAD', 'CANCELOU_VALIDACAO', `Cancelou assinatura do contrato CCU ${ref}: ${just.slice(0, 160)}${alerta ? ' [ATENÇÃO: comunicado já havia sido gerado]' : ''}`);
  res.json({ ok: true, comunicado_alerta: alerta });
});

// Exportação em massa (supervisor): devolve os detalhes de todos os contratos do
// filtro para o front montar um PDF único (impressão do navegador).
router.get('/api/secad/exportar', secad, (req, res) => {
  if (perfilFerramenta(req) !== 'master') return res.status(403).json({ error: 'Exportação em massa restrita ao supervisor.' });
  const { status, cidade } = req.query;
  const avals = depopDb.prepare(`
    SELECT a.id, c.descricao AS cidade FROM AvaliacaoAreaRenovacao a
    LEFT JOIN Cidade c ON c.id = a.id_cidade ORDER BY c.descricao, a.id_contrato`).all();
  const vmap = new Map(db.prepare(`SELECT id_avaliacao, status FROM validacao_contrato`).all().map(r => [r.id_avaliacao, r.status]));
  const ids = avals.filter(a => {
    if (cidade && String(a.cidade || '') !== cidade) return false;
    if (status && (vmap.get(a.id) || 'pendente') !== status) return false;
    return true;
  }).map(a => a.id);
  const detalhes = ids.map(id => montarDetalhe(id)).filter(Boolean);
  registrarLog(req, 'SECAD', 'EXPORTOU', `Exportou ${detalhes.length} contrato(s) em PDF`);
  res.json({ detalhes });
});

// ── Comunicados oficiais (Setor de Cadastro / Depto de Operações) ─────────────
// Notifica cada concessionário elegível da prorrogação antecipada, com as
// credenciais de acesso à plataforma de adesão. Um comunicado por CONTRATO
// (login/senha se repetem entre contratos do mesmo concessionário; CCU, área e
// vencimento são de cada contrato). Guarda por permissão: requireRotina('comunicados', flag).

// Prazo final de adesão pela regra do TCC/edital, pelo ano de vencimento. Fora do
// intervalo previsto (2027–2032) → não gera (retorna null; o chamador bloqueia).
function prazoFinalAdesao(ano) {
  if (ano === 2027) return '30/10/2026';
  if (ano >= 2028 && ano <= 2032) return '18/12/2026';
  return null;
}
const DATA_INICIO_ADESAO = '17/08/2026'; // fixa pra todos (consta no próprio modelo)

function paramSistema(chave, padrao) {
  const r = db.prepare(`SELECT valor FROM parametro_sistema WHERE chave = ?`).get(chave);
  return r && r.valor != null ? r.valor : padrao;
}

// Monta os dados de UM comunicado (um contrato). {ok:false, motivo} quando não
// pode gerar (ano fora do intervalo, ou sem credencial) — nunca gera carta sem
// login/senha. A URL vem SEMPRE do parametro_sistema (nunca fixa no código).
function montarComunicado(idAvaliacao) {
  const a = depopDb.prepare(`
    SELECT a.id, a.codigo, a.numero_ccu, a.data_vencimento, a.endereco AS area,
           cli.cliente, cli.endereco AS endereco,
           x.login, x.name AS acess_name, x.codeaccess
    FROM AvaliacaoAreaRenovacao a
    LEFT JOIN ClienteConcessionario cli ON cli.codigo = a.codigo
    LEFT JOIN concessionario_acess x ON x.codigo = a.codigo
    WHERE a.id = ?`).get(idAvaliacao);
  if (!a) return { ok: false, id: idAvaliacao, motivo: 'nao_encontrado', label: 'Contrato não encontrado' };
  const ano = parseInt(String(a.data_vencimento || '').slice(0, 4), 10);
  const prazo = prazoFinalAdesao(ano);
  const base = { id: a.id, ccu: a.numero_ccu, concessionario: a.cliente };
  if (!prazo) return { ...base, ok: false, motivo: 'ano_fora',
                       label: `Ano de vencimento ${ano || '?'} fora do intervalo previsto (2027–2032) — verificar dado antes de gerar` };
  if (!a.login || !a.codeaccess) return { ...base, ok: false, motivo: 'sem_credencial',
                       label: 'Concessionário sem credencial de acesso — não é possível gerar' };
  // Só gera comunicado de contrato JÁ VALIDADO (assinado na ferramenta de
  // validação). O comunicado carrega credenciais oficiais — não sai antes de a
  // conferência estar concluída.
  const v = db.prepare(`SELECT status FROM validacao_contrato WHERE id_avaliacao = ?`).get(idAvaliacao);
  if (!v || v.status !== 'validado') return { ...base, ok: false, motivo: 'nao_validado',
                       label: 'Contrato ainda não foi validado — valide antes de gerar o comunicado' };
  return { ok: true, comunicado: {
    id: a.id, codigo: a.codigo,
    numero_comunicado: paramSistema('numero_comunicado', '01/2026'),
    // Nº do protocolo = código do concessionário / CCU do contrato. Vem direto do
    // contrato (código+CCU é único, 443/443), então é sempre estável — sem contador.
    protocolo_numero: `${a.codigo}/${a.numero_ccu || '—'}`,
    empresa: a.cliente || a.acess_name || '—',
    cnpj: a.login,
    endereco: a.endereco || '—',
    numero_ccu: a.numero_ccu || '—',
    area: a.area || '—',
    ano_vencimento: ano,
    data_inicio: DATA_INICIO_ADESAO,
    prazo_final: prazo,
    url_acesso: paramSistema('url_plataforma_acesso', 'A DEFINIR'),
    login: a.login,
    senha: a.codeaccess
  } };
}

// Lista para a tela: todos os contratos com elegibilidade + contador de gerações
// e status de entrega. O front agrupa por cidade → concessionário.
//
// ATENÇÃO — ordem de registro importa: esta rota e POST /comunicados/gerar
// (literais) precisam continuar registradas ANTES de qualquer /comunicados/:id/...
// (parâmetro) mais abaixo neste arquivo. Mesmo formato do bug já visto em
// routes/admin.js (PATCH /modulos/:id engolindo PATCH /modulos/acessos) — se
// "lista"/"gerar" fossem reordenadas pra depois de um :id/..., o Express
// tentaria casar "lista"/"gerar" como se fossem o valor de :id.
router.get('/api/secad/comunicados/lista', secad, requireRotina('comunicados', 'ver'), (req, res) => {
  const removidos = new Set(codigosRemovidos());
  const avals = depopDb.prepare(`
    SELECT a.id, a.codigo, a.numero_ccu, a.data_vencimento, a.endereco AS area,
           cli.cliente, c.descricao AS cidade,
           CASE WHEN x.codigo IS NULL THEN 0 ELSE 1 END AS tem_credencial
    FROM AvaliacaoAreaRenovacao a
    LEFT JOIN ClienteConcessionario cli ON cli.codigo = a.codigo
    LEFT JOIN Cidade c ON c.id = a.id_cidade
    LEFT JOIN concessionario_acess x ON x.codigo = a.codigo
    ORDER BY c.descricao, cli.cliente, a.numero_ccu`).all().filter(a => !removidos.has(a.codigo));
  const gmap = new Map(db.prepare(`SELECT id_avaliacao, geracoes, ultima_geracao, enviado, dt_envio FROM comunicado_gerado`)
    .all().map(r => [r.id_avaliacao, r]));
  const vmap = new Map(db.prepare(`SELECT id_avaliacao, status FROM validacao_contrato`)
    .all().map(r => [r.id_avaliacao, r.status]));
  const cmap = new Map(anexosDb.prepare(`SELECT id_avaliacao, COUNT(*) n FROM comprovante_entrega GROUP BY id_avaliacao`)
    .all().map(r => [r.id_avaliacao, r.n]));
  const contratos = avals.map(a => {
    const ano = parseInt(String(a.data_vencimento || '').slice(0, 4), 10);
    const prazo = prazoFinalAdesao(ano);
    const g = gmap.get(a.id) || {};
    const validado = vmap.get(a.id) === 'validado';
    const entregue = !!g.enviado;
    // Gerável só quando: ano no intervalo E tem credencial E já validado E ainda
    // NÃO entregue. Motivo por prioridade: dado errado > falta credencial > falta
    // validar > já entregue (entrega finaliza; só o master reabre).
    // `viewable` = é um comunicado válido (dá pra ver na tela), mesmo se entregue.
    const viewable = !!prazo && !!a.tem_credencial && validado;
    let elegivel = true, motivo = null;
    if (!prazo) { elegivel = false; motivo = 'ano_fora'; }
    else if (!a.tem_credencial) { elegivel = false; motivo = 'sem_credencial'; }
    else if (!validado) { elegivel = false; motivo = 'nao_validado'; }
    else if (entregue) { elegivel = false; motivo = 'entregue'; }
    return {
      id: a.id, codigo: a.codigo, concessionario: a.cliente || '—', cidade: a.cidade || '—',
      numero_ccu: a.numero_ccu || '—', area: a.area || '—', ano_vencimento: ano || null,
      prazo_final: prazo, no_intervalo: !!prazo, tem_credencial: !!a.tem_credencial,
      validado, elegivel, viewable, motivo,
      geracoes: g.geracoes || 0, ultima_geracao: g.ultima_geracao || null,
      enviado: !!g.enviado, dt_envio: g.dt_envio || null,
      comprovantes: cmap.get(a.id) || 0
    };
  });
  const cidades = [...new Set(contratos.map(c => c.cidade))].sort();
  res.json({ caps: secadCaps(req), url_definida: paramSistema('url_plataforma_acesso', 'A DEFINIR') !== 'A DEFINIR',
             contratos, cidades });
});

// Geração: resolve o conjunto de contratos (por cidade, por concessionário, ou
// seleção múltipla), monta os comunicados elegíveis e registra a geração
// (incrementa o contador). Contratos fora do intervalo/sem credencial voltam em
// `pulados` (nunca falha em silêncio).
router.post('/api/secad/comunicados/gerar', secad, requireRotina('comunicados', 'incluir'), (req, res) => {
  const { cidade, codigo, codigos } = req.query;
  const removidos = new Set(codigosRemovidos());
  let rows;
  if (codigo) {
    rows = depopDb.prepare(`SELECT id, codigo FROM AvaliacaoAreaRenovacao WHERE codigo = ? ORDER BY numero_ccu`).all(parseInt(codigo, 10));
  } else if (codigos) {
    const lista = String(codigos).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
    if (!lista.length) return res.status(400).json({ error: 'Nenhum concessionário selecionado.' });
    const ph = lista.map(() => '?').join(',');
    rows = depopDb.prepare(`SELECT id, codigo FROM AvaliacaoAreaRenovacao WHERE codigo IN (${ph}) ORDER BY codigo, numero_ccu`).all(...lista);
  } else if (cidade) {
    rows = depopDb.prepare(`SELECT a.id, a.codigo FROM AvaliacaoAreaRenovacao a LEFT JOIN Cidade c ON c.id = a.id_cidade
                            WHERE c.descricao = ? ORDER BY a.numero_ccu`).all(String(cidade));
  } else {
    return res.status(400).json({ error: 'Informe cidade, concessionário ou seleção.' });
  }
  rows = rows.filter(r => !removidos.has(r.codigo));

  // Entrega finalizada trava a geração: comunicado entregue não sai de novo.
  // Só o master libera (cancelar-entrega). Fica em `pulados` com motivo 'entregue'.
  const entregues = new Set(
    db.prepare(`SELECT id_avaliacao FROM comunicado_gerado WHERE enviado = 1`).all().map(r => r.id_avaliacao)
  );
  const comunicados = [], pulados = [];
  for (const r of rows) {
    const m = montarComunicado(r.id);
    if (!m.ok) { pulados.push({ id: m.id, ccu: m.ccu, concessionario: m.concessionario, motivo: m.motivo, label: m.label }); continue; }
    if (entregues.has(m.comunicado.id)) {
      pulados.push({ id: m.comunicado.id, ccu: m.comunicado.numero_ccu, concessionario: m.comunicado.empresa,
        motivo: 'entregue', label: 'Entrega já finalizada — cancele a entrega (supervisor) para gerar novamente' });
      continue;
    }
    comunicados.push(m.comunicado);
  }

  // Separa 1ª geração de REGERAÇÃO (2ª via em diante): quem já tinha geracoes>0
  // antes deste POST é regeração. Serve pra mensagem no front e pro log distinto.
  const jaGerados = new Set(
    db.prepare(`SELECT id_avaliacao FROM comunicado_gerado WHERE geracoes > 0`).all().map(r => r.id_avaliacao)
  );
  const novos = comunicados.filter(c => !jaGerados.has(c.id));
  const regerados = comunicados.filter(c => jaGerados.has(c.id));

  // Contador de gerações + timestamps, por contrato efetivamente gerado.
  const iso = new Date().toISOString();
  const up = db.prepare(`
    INSERT INTO comunicado_gerado (id_avaliacao, geracoes, primeira_geracao, ultima_geracao, gerado_por)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(id_avaliacao) DO UPDATE SET
      geracoes = geracoes + 1, ultima_geracao = excluded.ultima_geracao, gerado_por = excluded.gerado_por`);
  for (const c of comunicados) up.run(c.id, iso, iso, req.user.user_id);

  if (novos.length) {
    registrarLog(req, 'SECAD', 'COMUNICADO_GEROU',
      `Gerou ${novos.length} comunicado(s) (1ª via)${pulados.length ? ` — ${pulados.length} pulado(s)` : ''}`);
  }
  if (regerados.length) {
    registrarLog(req, 'SECAD', 'COMUNICADO_REGEROU',
      `Regerou ${regerados.length} comunicado(s) (2ª via+): CCU ${regerados.map(c => c.numero_ccu).filter(Boolean).join(', ').slice(0, 200)}`);
  }
  res.json({ comunicados, pulados, novos: novos.length, regerados: regerados.length });
});

// Controle de entrega (manual, separado da geração). Só marca quem já foi gerado.
router.post('/api/secad/comunicados/:id/enviado', secad, requireRotina('comunicados', 'alterar'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const enviado = !!(req.body && req.body.enviado);
  const row = db.prepare(`SELECT geracoes FROM comunicado_gerado WHERE id_avaliacao = ?`).get(id);
  if (!row || !row.geracoes) return res.status(400).json({ error: 'Gere o comunicado antes de marcar a entrega.' });
  const iso = enviado ? new Date().toISOString() : null;
  db.prepare(`UPDATE comunicado_gerado SET enviado = ?, dt_envio = ? WHERE id_avaliacao = ?`).run(enviado ? 1 : 0, iso, id);
  registrarLog(req, 'SECAD', 'COMUNICADO_ENTREGA', `Comunicado ${id} marcado como ${enviado ? 'enviado' : 'não enviado'}`);
  res.json({ ok: true, enviado, dt_envio: iso });
});

// Cancelar a entrega (só supervisor/master): desfaz a entrega finalizada,
// removendo os comprovantes e liberando o comunicado para gerar/imprimir de novo.
// Igual ao cancelar assinatura — exige a senha de login do master e um motivo.
router.post('/api/secad/comunicados/:id/cancelar-entrega', secad, requireRotina('comunicados', 'alterar'), (req, res) => {
  if (perfilFerramenta(req) !== 'master') return res.status(403).json({ error: 'Apenas o supervisor pode cancelar a entrega.' });
  const id = parseInt(req.params.id, 10);
  const { senha, motivo } = req.body || {};
  const just = String(motivo || '').trim();
  if (!senha) return res.status(400).json({ error: 'Informe sua senha para cancelar a entrega.' });
  if (!just) return res.status(400).json({ error: 'Descreva o motivo do cancelamento.' });

  const row = db.prepare(`SELECT enviado FROM comunicado_gerado WHERE id_avaliacao = ?`).get(id);
  if (!row || !row.enviado) return res.status(409).json({ error: 'Este comunicado não está com a entrega finalizada.' });

  // Confirma com a senha de LOGIN do próprio master (mesma regra da assinatura).
  const u = db.prepare(`SELECT senha_hash, salt FROM users WHERE id = ?`).get(req.user.user_id);
  const h = crypto.pbkdf2Sync(String(senha), u.salt, 100000, 64, 'sha512').toString('hex');
  if (h !== u.senha_hash) return res.status(401).json({ error: 'Senha incorreta.' });

  const nCompr = anexosDb.prepare(`SELECT COUNT(*) c FROM comprovante_entrega WHERE id_avaliacao = ?`).get(id).c;
  anexosDb.prepare(`DELETE FROM comprovante_entrega WHERE id_avaliacao = ?`).run(id);
  db.prepare(`UPDATE comunicado_gerado SET enviado = 0, dt_envio = NULL WHERE id_avaliacao = ?`).run(id);
  registrarLog(req, 'SECAD', 'ENTREGA_CANCELOU', `Cancelou a entrega do comunicado do contrato ${id} (removeu ${nCompr} comprovante(s)): ${just.slice(0, 160)}`);
  res.json({ ok: true });
});

// Dados de UM comunicado (para reimprimir o comunicado ou o protocolo de entrega
// de um contrato específico, fora do fluxo de geração em massa). Devolve o mesmo
// objeto de montarComunicado (ok:false + motivo quando não é gerável).
router.get('/api/secad/comunicados/:id/dados', secad, requireRotina('comunicados', 'ver'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.json(montarComunicado(id));
});

// ── Comprovantes de entrega (anexos.db) ──────────────────────────────────────
// A cópia assinada do comunicado que volta como prova de entrega. Guardada como
// BLOB no anexos.db. Imagens já chegam comprimidas do navegador; PDFs entram com
// teto de tamanho. Anexar marca o comunicado como entregue (enviado=1).
const COMPROVANTE_MIMES = ['image/jpeg', 'image/png', 'application/pdf'];
const COMPROVANTE_MAX = 10 * 1024 * 1024; // 10 MB por anexo (pós-compressão no cliente)

router.post('/api/secad/comunicados/:id/comprovante', secad,
  requireRotina('comunicados', 'incluir'),
  express.raw({ type: '*/*', limit: '12mb' }),
  (req, res) => {
    const id = parseInt(req.params.id, 10);
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const nome = String(req.query.nome || req.headers['x-file-name'] || 'comprovante').slice(0, 180);

    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      return res.status(400).json({ error: 'Arquivo vazio.' });
    if (!COMPROVANTE_MIMES.includes(mime))
      return res.status(415).json({ error: 'Formato não aceito. Envie imagem (JPG/PNG) ou PDF.' });
    if (req.body.length > COMPROVANTE_MAX)
      return res.status(413).json({ error: 'Arquivo muito grande (máx. 10 MB).' });

    const row = db.prepare(`SELECT geracoes FROM comunicado_gerado WHERE id_avaliacao = ?`).get(id);
    if (!row || !row.geracoes)
      return res.status(400).json({ error: 'Gere o comunicado antes de anexar o comprovante.' });

    const perfil = db.prepare(`SELECT nome FROM depop_perfil WHERE user_id = ?`).get(req.user.user_id);
    const nomeUsuario = (perfil && perfil.nome) || req.user.username;
    anexosDb.prepare(`
      INSERT INTO comprovante_entrega (id_avaliacao, nome_arquivo, mime, tamanho, conteudo, enviado_por, enviado_por_nome)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, nome, mime, req.body.length, req.body, req.user.user_id, nomeUsuario);

    // Anexar prova = entregue.
    const iso = new Date().toISOString();
    db.prepare(`UPDATE comunicado_gerado SET enviado = 1, dt_envio = ? WHERE id_avaliacao = ?`).run(iso, id);
    registrarLog(req, 'SECAD', 'COMPROVANTE_ANEXOU', `Anexou comprovante de entrega ao comunicado do contrato ${id} (${nome})`);
    res.json({ ok: true });
  }
);

// Lista os comprovantes de um contrato (metadados, sem o BLOB).
router.get('/api/secad/comunicados/:id/comprovantes', secad, requireRotina('comunicados', 'ver'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = anexosDb.prepare(`
    SELECT id, nome_arquivo, mime, tamanho, enviado_por_nome, criado_em
    FROM comprovante_entrega WHERE id_avaliacao = ? ORDER BY criado_em DESC, id DESC`).all(id);
  res.json({ comprovantes: rows });
});

// Baixa/visualiza um comprovante (o BLOB). GET → consulta também pode ver.
router.get('/api/secad/comprovante/:cid', secad, requireRotina('comunicados', 'ver'), (req, res) => {
  const cid = parseInt(req.params.cid, 10);
  const row = anexosDb.prepare(`SELECT nome_arquivo, mime, conteudo FROM comprovante_entrega WHERE id = ?`).get(cid);
  if (!row) return res.status(404).json({ error: 'Comprovante não encontrado.' });
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.nome_arquivo || 'comprovante')}"`);
  res.send(Buffer.from(row.conteudo));
});

// Remove um comprovante. Se sobrar nenhum no contrato, desmarca a entrega.
// Entrega finalizada (enviado=1) só o master mexe — o comum usa o supervisor.
router.delete('/api/secad/comprovante/:cid', secad, requireRotina('comunicados', 'alterar'), (req, res) => {
  const cid = parseInt(req.params.cid, 10);
  const row = anexosDb.prepare(`SELECT id_avaliacao, nome_arquivo FROM comprovante_entrega WHERE id = ?`).get(cid);
  if (!row) return res.status(404).json({ error: 'Comprovante não encontrado.' });
  const g = db.prepare(`SELECT enviado FROM comunicado_gerado WHERE id_avaliacao = ?`).get(row.id_avaliacao);
  if (g && g.enviado && perfilFerramenta(req) !== 'master')
    return res.status(403).json({ error: 'Entrega finalizada — só o supervisor pode cancelar a entrega.' });
  anexosDb.prepare(`DELETE FROM comprovante_entrega WHERE id = ?`).run(cid);
  const restantes = anexosDb.prepare(`SELECT COUNT(*) c FROM comprovante_entrega WHERE id_avaliacao = ?`).get(row.id_avaliacao).c;
  if (restantes === 0) db.prepare(`UPDATE comunicado_gerado SET enviado = 0, dt_envio = NULL WHERE id_avaliacao = ?`).run(row.id_avaliacao);
  registrarLog(req, 'SECAD', 'COMPROVANTE_REMOVEU', `Removeu comprovante do contrato ${row.id_avaliacao} (${row.nome_arquivo || ''})`);
  res.json({ ok: true, entregue: restantes > 0 });
});

// Parâmetros do sistema (parametro_sistema) — leitura/edição só do master.
router.get('/api/secad/parametros', secad, (req, res) => {
  if (req.user.username !== 'master') return res.status(403).json({ error: 'Restrito ao master.' });
  const p = {};
  db.prepare(`SELECT chave, valor FROM parametro_sistema`).all().forEach(r => { p[r.chave] = r.valor; });
  res.json(p);
});
router.put('/api/secad/parametros', secad, (req, res) => {
  if (req.user.username !== 'master') return res.status(403).json({ error: 'Restrito ao master.' });
  const entries = Object.entries(req.body || {});
  if (!entries.length) return res.status(400).json({ error: 'Nada para salvar.' });
  const up = db.prepare(`INSERT INTO parametro_sistema (chave, valor) VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`);
  entries.forEach(([k, v]) => up.run(k, String(v)));
  registrarLog(req, 'CONFIG', 'PARAM_SISTEMA', `Parâmetros do sistema: ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  res.json({ ok: true });
});

module.exports = router;
