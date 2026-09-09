# Prompt para nova sessão — Módulo de Notificação por E-mail (CEASA CONECTA)

> Cole este prompt inteiro como primeira mensagem numa conversa nova no
> **Claude Desktop** (sem acesso ao repositório de código). O objetivo desta
> conversa é só **fechar o escopo** do módulo (última seção) — perguntas e
> decisões, não implementação. Como não há leitura de arquivo aqui, todo o
> contexto de código necessário já está resumido/colado inline abaixo; não
> peça pra "abrir o database.js" ou similar — se faltar algum detalhe, peça
> pro Alex colar o trecho específico. Depois que o escopo estiver fechado, a
> implementação em si acontece numa sessão do **Claude Code** apontando pro
> repositório de verdade (aí sim com leitura de código completa).

## O que é este sistema

**CEASA CONECTA** é uma plataforma multi-módulo interna da CEASAMINAS,
evoluída a partir de um sistema único ("Secop Cotações", cotação de compras).
Hoje ela hospeda vários módulos sob o mesmo login:

- **SECOP** — o módulo original: cotação de compras, fornecedores, processos.
- **SECAD** (antigo "Depop", nome de módulo mudou mas o banco interno
  `depop.db` manteve o nome antigo de propósito) — comunicados oficiais,
  validação de contratos, concessionários.
- **PAC** (Departamento de Planejamento/DEPLA) — planejamento anual de
  contratações: setores lançam demandas num "DFD" (Documento de Formalização
  de Demanda), o DEPLA consolida, acompanha execução. É o módulo mais
  recente e mais trabalhado — bom exemplo de como um módulo novo é
  estruturado do zero neste projeto, e **já tem dentro dele uma mensageria
  viva sem e-mail** que é o ponto de partida natural deste módulo (ver seção
  própria abaixo).
- **Admin** — gestão de usuários, departamentos, módulos, perfis/rotinas.

O dono do produto é o **Alex** — desenvolvedor solo, também administrador
funcional do sistema, no Windows com PowerShell/Git Bash. Ele testa,
aprova e decide tudo sozinho; não existe um "time" por trás disso.

## Stack técnica (sem exceções — não introduzir framework/bundler novo)

- **Backend**: Node.js (`>= 22.5.0`, exigência dura — o projeto usa
  `node:sqlite`, nativo só a partir dessa versão) + Express puro.
- **Banco**: `node:sqlite` (`DatabaseSync`), **sem ORM**. 3 arquivos: `secop.db`
  (principal — praticamente tudo, incluindo PAC), `depop.db` (SECAD),
  `anexos.db` (blobs de arquivo). Schema inteiro vive em `database.js`: tabelas
  via `CREATE TABLE IF NOT EXISTS`, migrações via `ALTER TABLE ... ADD COLUMN`
  dentro de `try {} catch {}` (idempotente, aditivo — **nunca** uma migração
  destrutiva sem conversa explícita com o Alex primeiro).
- **Frontend**: HTML/CSS/JS puro, **sem framework, sem bundler, sem build
  step**. Uma página = um `public/<nome>.html` + um `public/js/<nome>.js`,
  carregado via `<script src="...">` direto. CSS quase todo compartilhado em
  `public/css/style.css` (algumas páginas têm um `<style>` inline pequeno,
  só pra CSS que é genuinamente exclusivo daquela tela). Nenhuma lib de
  gráfico/UI — indicadores tipo pizza/velocímetro no PAC são SVG inline
  escrito à mão, mesma convenção esperada de qualquer peça visual nova.
- **PWA**: manifest + service worker (`public/sw.js`) — cache network-first
  pro "shell" (HTML/CSS/JS), `/api/*` nunca é cacheado. Toda página/script
  novo entra na lista `SHELL_FILES` do `sw.js`. Desde v4.19.10, uma aba
  aberta durante um deploy se recarrega sozinha quando o Service Worker novo
  assume (`controllerchange` em `public/js/pwa.js`) — não é mais preciso
  hard-refresh manual pra ver uma mudança nova.
- **Zero dependências externas além do essencial** — hoje só `express` +
  `an-array-of-portuguese-words` (autocomplete) em produção, `nodemon` em
  dev. Uma lib de envio de e-mail (`nodemailer` é o candidato óbvio) é uma
  decisão consciente a tomar com o Alex, não um "já vem instalado".

## Arquitetura de arquivos

```
server.js          — bootstrap, monta os routers (routes/*.js), CATCH-ALL da
                      SPA por último — rota nova de API SEMPRE antes dele,
                      já foi bug real registrado 2x no histórico do projeto.
database.js        — schema inteiro + seeds + migrações. Único lugar que
                      mexe em CREATE/ALTER TABLE do projeto inteiro.
middleware.js       — auth de sessão, gates de módulo/rotina, helpers
                      compartilhados entre módulos (log de auditoria, etc.).
routes/
  secop.js, secad.js, pac.js, pac-importacao.js, admin.js
public/
  *.html            — uma página por tela
  js/*.js           — um script por tela (mesmo nome do html)
  css/style.css     — CSS compartilhado
  sw.js             — service worker
```

## Modelo de autenticação e permissão (importante pro módulo novo se
encaixar certo, não reinventar)

- Sessão por cookie (`secop_sid`), tabela `sessions`, expiração rolante
  (renova a cada request autenticado; parâmetro `inatividade_minutos`).
- `users.role`: `master` (acesso total, todo módulo, ignora toda checagem de
  rotina) / `admin_sistema` / `admin_operacional` / `usuario` / `consulta`
  (somente leitura em TUDO, gate global no servidor).
- **Multi-módulo**: usuário escolhe um módulo após login
  (`sessions.modulo_ativo`); `requireModulo(slug)` barra rota de módulo
  errado. Acesso a módulo é via `user_modulos` (user_id, modulo_id,
  **perfil_id**).
- **Permissão fina dentro de um módulo** — modelo
  "Departamento → Módulo → Rotina → Perfil":
  - `rotinas` = uma tela/funcionalidade dentro de um módulo (ex.:
    `pac-lancamento`, `pac-gestao`).
  - `perfis` = papel nomeado, escopado a um departamento (ex.: "Gestor de
    Área", "Analista DEPLA").
  - `perfil_rotinas` = por perfil, por rotina: flags `ver/incluir/alterar/
    excluir`.
  - `requireRotina(rotinaSlug, flag)` (middleware) gateia toda rota de
    ESCRITA; leitura (GET) fica mais aberta a quem já tem o módulo.
    `master`/`consulta` sempre passam.
- Escopo mais fino ainda (ex.: gestor só vê o(s) setor(es) dele) é feito por
  tabela de vínculo própria do módulo (`setor_usuarios` no PAC) — não existe
  mecanismo genérico de "escopo" pronto, cada módulo resolve o seu.
- Acesso "por role pura" (não por Perfil/Rotina) existe pra ferramentas
  cross-módulo tipo o Console SQL/Importação do PAC — só `master`/
  `admin_sistema`, checado direto no `req.user.role`/`username`.
- `users.email` **já existe como coluna** (`TEXT`, nullable, sem constraint
  de obrigatoriedade nem de formato) — mas não há garantia hoje de que todo
  usuário tem um valor preenchido. Primeira coisa a checar antes de desenhar
  qualquer envio: quantos usuários reais estão sem e-mail cadastrado.

## A mensageria viva que já existe (v4.19.8, só dentro do app — SEM e-mail)

### Este é o ponto de partida real do módulo, não um exemplo genérico

O fluxo de **pedidos de edição** do PAC (`dfd_pedidos_edicao`, setor pede pra
DEPLA liberar edição de um item já travado) já é uma mensageria completa de
ponta a ponta, só que 100% dentro do navegador (badge com contador + flyout,
sem tocar e-mail). Isso já foi construído seguindo uma especificação
detalhada do Alex que **pediu explicitamente pra deixar pronta pra
extensão por e-mail no futuro** — ou seja, é literalmente este módulo, na
metade do caminho.

Schema de hoje (`database.js`, tabela `dfd_pedidos_edicao`):

```sql
CREATE TABLE dfd_pedidos_edicao (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dfd_id         INTEGER NOT NULL,
  item_id        INTEGER,
  setor_id       INTEGER NOT NULL,
  solicitante_id INTEGER REFERENCES users(id),
  tipo           TEXT    NOT NULL,
  justificativa  TEXT,
  status         TEXT    NOT NULL DEFAULT 'pendente',   -- pendente|aprovado|rejeitado
  respondido_por INTEGER REFERENCES users(id),
  resposta       TEXT,
  criado_em      DATETIME DEFAULT CURRENT_TIMESTAMP,
  respondido_em  DATETIME,
  consumido_em   DATETIME,
  -- colunas da mensageria viva (v4.19.8):
  visualizado_pelo_solicitante_em DATETIME,   -- NULL = setor ainda não leu a resposta
  tentativa      INTEGER NOT NULL DEFAULT 1,  -- sobe a cada contestação
  bloqueado      INTEGER NOT NULL DEFAULT 0   -- 1 = 2ª rejeição, DEPLA travou, acabou
);
```

Máquina de estado implementada (`routes/pac.js`):

1. Setor cria pedido (`POST /api/pac/pedidos`) → nasce `status='pendente'`,
   `visualizado_pelo_solicitante_em` já setado (é o PRÓPRIO pedido dele, não
   precisa de badge pra si mesmo) — **DEPLA** é quem recebe o indicador de
   novo pedido pendente (badge no link "Pedidos" da árvore lateral de
   Gestão, `pac-cnt-pedidos`, cor de alerta quando > 0).
2. DEPLA responde (`PATCH /api/pac/pedidos/:id/resposta`) — aprovar não
   exige texto; **rejeitar exige `resposta` não-vazia** (400 se vazio, valida
   no cliente também antes de nem mandar). Toda resposta reseta
   `visualizado_pelo_solicitante_em = NULL` — é isso que acende o badge de
   volta pro setor solicitante (flyout de "Meus pedidos" em Lançamento).
   Rejeitar com `tentativa >= 2` seta `bloqueado = 1` (trava definitiva).
3. Setor abre o flyout → `POST /api/pac/pedidos/marcar-lidos` marca como
   visualizado (some o número do badge, mas a linha continua na lista).
   Se aprovado, o campo libera edição com um botão "💾 Salvar" explícito
   ao lado (não é o modo de edição normal de DFD aberto).
   Se rejeitado e `!bloqueado`, aparece "Contestar"
   (`PATCH /api/pac/pedidos/:id/contestar`) — reabre como `pendente`,
   `tentativa + 1`, e o ciclo volta ao passo 2 (2ª rejeição já vem com
   `bloqueado=1`, sem mais contestação possível).

O que isso significa pro módulo de e-mail: **o gatilho mais óbvio e já
"pronto" pra virar e-mail é exatamente este fluxo** — um e-mail pro DEPLA
quando nasce um pedido `pendente`, e um e-mail pro solicitante quando
`visualizado_pelo_solicitante_em` é resetado (aprovado/rejeitado/travado).
Não é a única fonte possível (ver lista de candidatos abaixo), mas é a que
já tem toda a lógica de estado testada e em produção — vale usar como
"prova de conceito" antes de generalizar pra outros eventos do sistema.

**Não existe hoje** nenhuma tabela `notificacoes`/fila de e-mail/log de
envio — um plano anterior (`M6` de uma rodada de planejamento passada)
cogitou uma tabela `pac_notificacoes` central, mas **não foi implementada**;
o que foi pra produção usa as colunas acima direto em
`dfd_pedidos_edicao`. Qualquer fila/histórico de e-mail é desenho novo,
não uma peça que já existe esperando ser ligada.

## Convenções e armadilhas já conhecidas (não redescobrir)

- **Ordem de rotas**: qualquer `/api/...` novo tem que ser registrado ANTES
  do catch-all da SPA em `server.js`.
- **`node:sqlite` não aceita `undefined` como parâmetro de bind** — sempre
  virar `null` explícito.
- **Convenção de versão**: `package.json.version` + `CACHE_NAME` em
  `public/sw.js` sobem juntos a cada entrega (hoje em v4.19.10). Todo commit
  que muda comportamento visível carrega os dois bumps.
- **Fluxo de git**: todo o desenvolvimento roda em
  `feature/ceasa-conecta-modulos`; mergeado pra `main` **assim que testado**,
  antes de avisar o Alex que algo está pronto (nunca deixar ele descobrir
  que a branch errada estava esperando). Produção é uma **máquina física
  separada** (`C:\secopcotacoes`, roda `nodemon`, pull manual do Alex,
  `npm install` extra se `package.json` mudou). Existe também um ambiente de
  **QA** (`C:\Projetos\Secop-QA`, na mesma máquina do dev, também rastreia
  `main`, porta 3001, sobe com `bash start-qa.sh`) — 3 estágios: dev → QA →
  produção, documentado em `DEPLOY.md` (Seção C).
- **Testes**: não existe navegador automatizado disponível neste ambiente de
  desenvolvimento. Validação de mudança que toca banco é feita em cópia
  isolada (pasta descartável + porta própria + usuário/sessão `_qa_*`
  inserida direto no banco via script) exercitada por `curl`/Node
  `http.request` — nunca em cima do banco real de produção nem do processo
  de QA que o Alex esteja usando ao vivo, e teste que GRAVA dado nunca
  reaproveita conta real (sempre um `_qa_*` dedicado, mesmo em cópia
  isolada). **Cuidado extra pra e-mail**: nunca disparar envio de verdade
  contra um provedor real durante teste automatizado — usar um provedor de
  teste/sandbox (ex.: Ethereal, Mailtrap) ou stub a chamada de envio, e
  deixar isso explícito antes de rodar qualquer teste que toque a rota de
  envio de verdade.
- **Gotcha de encoding em teste via shell**: passar texto acentuado
  (português) por interpolação de string em `curl -d "...$var..."` neste
  ambiente Windows/Git Bash corrompe caracteres multi-byte em U+FFFD,
  quebrando comparação exata sem erro nenhum aparecer. Sempre usar um
  script Node puro (`http.request` + `JSON.stringify`) pra testar qualquer
  payload com acento — é assim que um `fetch()` de navegador de verdade
  serializa, então não é bug da aplicação, é só ferramenta de teste errada.
- **PWA/cache**: toda página/script novo precisa entrar em `SHELL_FILES`
  (`public/sw.js`), senão nunca é pré-cacheado.
- Comentários de código, textos de UI e toda comunicação com o Alex são em
  **português do Brasil**.

## Estilo de trabalho do Alex — regra permanente, a mais importante desta lista

**Não decidir sozinho em decisão de produto ambígua.** Quando existir mais
de um jeito razoável de resolver algo (onde um botão fica, qual regra de
negócio se aplica, que dado é obrigatório, etc.), a ordem certa é: (1)
explicar o estado atual em texto simples, (2) só depois perguntar — nunca
implementar um palpite e revelar a decisão depois de pronto. Isso já gerou
atrito real num módulo anterior (PAC) quando pulado. Perguntas de produto
devem ser diretas e objetivas (2-4 opções concretas quando possível), não
uma lista longa de hipóteses — uma pergunta abstrata demais ("onde isso se
encaixa conceitualmente") já gerou "não entendi por que essa pergunta aqui
agora" numa sessão anterior.

Ele também é sensível a **ritmo/custo de token** — prefere diagnóstico
direto (ler o código, checar o banco real) a teorizar em cadeia sem
evidência, e já reclamou explicitamente quando uma sessão anterior gastou
esforço construindo uma funcionalidade pra corrigir um bug que, checado
depois direto no banco, nem existia (o problema real era visual/CSS, não
de dado).

Em rodadas de ajuste fino ele costuma mandar uma lista fechada de itens de
uma vez ("vamos aos poucos" / "siga sem perguntar" quando já confia na
direção) — seguir a lista literalmente minimiza retrabalho; quando ele
autoriza avançar sem perguntar, documentar as decisões tomadas no commit em
vez de silenciar.

## O pedido de verdade: módulo de notificação por e-mail

Alex quer um módulo de **notificação por e-mail**, acoplado ao CEASA
CONECTA (mesmo repositório, mesmos padrões acima — não é um projeto/serviço
separado), e já deixou uma mensageria viva dentro do PAC (seção acima)
pronta pra ser o primeiro caso de uso real.

**O escopo do módulo em si ainda não está definido.** Não existe hoje no
projeto: nenhuma lib de envio de e-mail instalada, nenhuma tabela de
preferência de notificação, nenhuma fila/histórico de envio. Antes de
desenhar ou codar qualquer coisa, a sessão que receber este prompt deve
**conversar com o Alex** (seguindo a regra de "não decidir sozinho" acima)
pra fechar pelo menos:

1. **Quais eventos disparam e-mail** — o fluxo de pedidos de edição do PAC
   (seção acima) é o candidato mais pronto (já tem toda a máquina de estado
   testada), mas não é o único: vencimento de DFD se aproximando
   (`dfds.data_entrega`), setor finalizado, contrato perto do vencimento,
   comunicado novo no SECAD, etc. — lista aberta, o Alex quem define por
   onde começar (pode ser só o de pedidos, pra validar o mecanismo, e
   expandir depois).
2. **Pra quem** — confirmar de fato quantos usuários reais têm
   `users.email` preenchido antes de desenhar em cima disso (a coluna
   existe mas nunca foi obrigatória). Notificação é sempre obrigatória ou
   cada usuário pode desligar (opt-in/opt-out por tipo de evento)?
3. **Como o e-mail é enviado de verdade** — provedor de SMTP (existe algum
   já contratado pela CEASAMINAS? Gmail/Workspace corporativo? Um serviço
   tipo SendGrid/SES?) e onde essa credencial fica guardada (o projeto já
   tem um padrão pra segredo de config — ver `config` no banco + fallback
   de variável de ambiente, usado hoje pra chave de API do CPF Hub).
4. **Frequência/agrupamento** — e-mail imediato por evento, ou um resumo
   periódico (diário?) agrupando várias notificações? (Sem nenhum job
   agendado/cron no projeto hoje — se precisar de periodicidade, isso
   também é peça nova.)
5. **Templates** — texto simples ou HTML com a identidade visual do CEASA
   CONECTA?
6. **Falha de envio** — se o SMTP cair ou o e-mail bouncar, isso bloqueia
   algum fluxo do app (ex.: aprovar pedido) ou é sempre best-effort,
   registrado num log e seguindo em frente?

Esta conversa (Claude Desktop, sem repositório) é só pra **fechar as 6
perguntas acima com o Alex** — não proponha schema, rota ou código ainda.
Tudo que você precisa saber sobre o fluxo de `dfd_pedidos_edicao` já está
inline neste prompt; não peça pra ler `database.js`/`routes/pac.js` (não tem
como, aqui não há acesso a arquivo — se precisar de mais algum detalhe, peça
pro Alex colar o trecho). Quando o escopo estiver fechado, o resultado desta
conversa (as decisões tomadas) vira o ponto de partida de uma sessão do
Claude Code de verdade, com o repositório aberto, pra implementar.
