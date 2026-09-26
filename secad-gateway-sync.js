// Sincroniza o cadastro de concessionários (nome/CNPJ/endereço/contrato) a
// partir do CeasaConecta-Gateway (serviço isolado que consulta o SQL Server
// legado/CORPORE) — nunca chamado do navegador, só daqui, servidor a
// servidor. Pedido do Alex, 2026-09-26: "consumir no back... rotina de
// atualização" em vez de expor a API do Gateway pro frontend do CEASA
// CONECTA. Mesmo padrão de motor em background que mailer.js já usa
// (setInterval + roda 1x no boot), zero dependência nova (fetch nativo do
// Node). 1ª etapa de 3 combinadas com o Alex: Gateway (pronto) → esta
// sincronização (aqui) → módulo novo no Depop que consome
// concessionario_cadastro (depois).
const { db, depopDb } = require('./database');

const INTERVALO_MS = 6 * 60 * 60 * 1000; // 6h — cadastro muda pouco, não precisa de mais frequência

function getConfigGateway() {
  const url = db.prepare(`SELECT valor FROM config WHERE chave = 'secad_gateway_url'`).get()?.valor || '';
  const apiKey = db.prepare(`SELECT valor FROM config WHERE chave = 'secad_gateway_api_key'`).get()?.valor || '';
  return { url: url.trim(), apiKey: apiKey.trim() };
}

async function sincronizarConcessionarios() {
  const { url, apiKey } = getConfigGateway();
  if (!url || !apiKey) {
    return { ok: false, erro: 'Gateway não configurado (URL e/ou chave em branco).' };
  }

  const endpoint = url.replace(/\/+$/, '') + '/secad/concessionario';
  let resposta;
  try {
    resposta = await fetch(endpoint, { headers: { 'X-API-Key': apiKey } });
  } catch (e) {
    return { ok: false, erro: `Falha de rede ao chamar o Gateway: ${e.message}` };
  }
  if (!resposta.ok) {
    return { ok: false, erro: `Gateway respondeu ${resposta.status}` };
  }

  let corpo;
  try { corpo = await resposta.json(); } catch { return { ok: false, erro: 'Resposta do Gateway não é JSON válido.' }; }
  const linhas = Array.isArray(corpo.dados) ? corpo.dados : [];

  // Substituição completa (DELETE + INSERT), não upsert incremental — 2
  // motivos achados testando com dado real: (1) numero_contrato vem NULL em
  // parte das linhas, e NULL nunca "bate" com NULL num UNIQUE/ON CONFLICT
  // (regra do SQL), então um upsert incremental duplicava essas linhas a
  // cada rodada; (2) um contrato removido/encerrado no CORPORE nunca
  // sumiria daqui com upsert puro (só insere/atualiza, nunca apaga). Troca
  // completa numa transação garante que a tabela sempre espelha exatamente
  // o que o Gateway retornou agora, sem lixo acumulado.
  const insert = depopDb.prepare(`
    INSERT INTO concessionario_cadastro
      (codigo, numero_contrato, nome, fantasia, cnpj, ie, cod_ramo, descricao_ramo, endereco, numero, bairro, cidade, telefone, cep, ativo, contrato_juridico, atualizado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  let gravados = 0;
  try {
    depopDb.exec('BEGIN');
    depopDb.exec('DELETE FROM concessionario_cadastro');
    for (const c of linhas) {
      const codigo = parseInt(c.CODCFO, 10);
      if (!codigo) continue;
      insert.run(
        codigo, c.NUMEROCONTRATO || null, c.CLIENTE || null, c.FANTASIA || null, c.CNPJ || null, c.IE || null,
        c.CODRAMO ?? null, c.DESCRICAORAMO || null, c.ENDERECO || null, c.NUMERO || null,
        c.BAIRRO || null, c.CIDADE || null, c.TELEFONE || null, c.CEP || null,
        c.ATIVO ?? null, c.CONTRATO_JURIDICO || null
      );
      gravados++;
    }
    depopDb.exec('COMMIT');
  } catch (e) {
    try { depopDb.exec('ROLLBACK'); } catch {}
    return { ok: false, erro: `Falha gravando no depop.db: ${e.message}` };
  }

  db.prepare(`INSERT INTO config (chave, valor) VALUES ('secad_gateway_ultima_sync', datetime('now')) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run();
  return { ok: true, total: linhas.length, gravados };
}

let _motorIniciado = false;
function iniciarSincronizacao() {
  if (_motorIniciado) return;
  _motorIniciado = true;

  sincronizarConcessionarios().then(r => {
    if (!r.ok) console.warn('[secad-gateway-sync] 1ª sincronização não rodou:', r.erro);
    else console.log(`[secad-gateway-sync] sincronizado: ${r.gravados}/${r.total} concessionários.`);
  });
  setInterval(() => {
    sincronizarConcessionarios()
      .then(r => { if (!r.ok) console.warn('[secad-gateway-sync] sincronização falhou:', r.erro); })
      .catch(e => console.error('[secad-gateway-sync] erro inesperado:', e.message));
  }, INTERVALO_MS);
}

module.exports = { iniciarSincronizacao, sincronizarConcessionarios };
