# Prompt para nova sessão — Módulo de Notificação por E-mail (CEASA CONECTA)

> Cole este prompt inteiro como primeira mensagem numa sessão nova (Claude Code
> apontando pra pasta do projeto, de preferência — ele precisa poder ler o
> código real, não só este resumo). O que está aqui é contexto e regras de
> trabalho; os detalhes do módulo de e-mail em si (quais eventos disparam,
> modelo de template, provedor de SMTP, preferências do usuário) **ainda não
> foram definidos** — isso é proposital, ver a última seção.

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
  estruturado do zero neste projeto.
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
  só pra CSS que é genuinamente exclusivo daquela tela).
- **PWA**: manifest + service worker (`public/sw.js`) — cache network-first
  pro "shell" (HTML/CSS/JS), `/api/*` nunca é cacheado. Toda página/script
  novo entra na lista `SHELL_FILES` do `sw.js`.
- **Zero dependências externas além do essencial** — hoje só `express` +
  `an-array-of-portuguese-words` (autocomplete) em produção, `nodemon` em
  dev. Qualquer lib nova (e um módulo de e-mail vai precisar de uma, tipo
  `nodemailer`) é uma decisão consciente, não um "já vem instalado".

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

## Convenções e armadilhas já conhecidas (não redescobrir)

- **Ordem de rotas**: qualquer `/api/...` novo tem que ser registrado ANTES
  do catch-all da SPA em `server.js`.
- **`node:sqlite` não aceita `undefined` como parâmetro de bind** — sempre
  virar `null` explícito.
- **Convenção de versão**: `package.json.version` + `CACHE_NAME` em
  `public/sw.js` sobem juntos a cada entrega (hoje em v4.18.6). Todo commit
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
  inserida direto no banco via script) exercitada por `curl` — nunca em
  cima do banco real de produção, e teste que GRAVA dado nunca reaproveita
  conta real (sempre um `_qa_*` dedicado, mesmo em cópia isolada).
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
uma lista longa de hipóteses.

Ele também é sensível a **ritmo/custo de token** — prefere diagnóstico
direto (ler o código, checar o banco real) a teorizar em cadeia sem
evidência, e já reclamou explicitamente quando uma sessão anterior gastou
esforço construindo uma funcionalidade pra corrigir um bug que, checado
depois direto no banco, nem existia (o problema real era visual/CSS, não
de dado).

## O pedido de verdade: módulo de notificação por e-mail

Alex quer um módulo de **notificação por e-mail**, acoplado ao CEASA
CONECTA (mesmo repositório, mesmos padrões acima — não é um projeto/serviço
separado).

**Isto ainda não tem escopo definido.** Não existe hoje no projeto:
nenhuma lib de envio de e-mail instalada, nenhuma tabela de preferência de
notificação, nenhum gatilho de evento definido. Antes de desenhar ou
codar qualquer coisa, a sessão que receber este prompt deve **conversar com
o Alex** (seguindo a regra de "não decidir sozinho" acima) pra fechar pelo
menos:

1. **Quais eventos disparam e-mail** — candidatos que já existem no sistema
   e podem servir de gatilho (não é uma lista fechada, só contexto do que
   já existe pra não reinventar o dado): vencimento de DFD se aproximando
   (`dfds.data_entrega`, módulo PAC), pedido de edição aguardando resposta
   do DEPLA (`dfd_pedidos_edicao`), setor finalizado, contrato perto do
   vencimento, comunicado novo no SECAD, etc. — mas também pode ser algo
   fora do PAC, isso o Alex quem define.
2. **Pra quem** — todo usuário tem e-mail cadastrado hoje? (`users.email`
   existe na tabela, confirmar se está sempre preenchido). Preferência de
   opt-in/opt-out por usuário ou é sempre obrigatório?
3. **Como o e-mail é enviado de verdade** — provedor de SMTP (existe algum
   já contratado pela CEASAMINAS? Gmail/Workspace corporativo? Um serviço
   tipo SendGrid/SES?) e onde essa credencial fica guardada (o projeto já
   tem um padrão pra segredo de config — ver `config` no banco + fallback
   de variável de ambiente, usado hoje pra chave de API do CPF Hub).
4. **Frequência/agrupamento** — e-mail imediato por evento, ou um resumo
   periódico (diário?) agrupando várias notificações?
5. **Templates** — texto simples ou HTML com a identidade visual do CEASA
   CONECTA?

Comece lendo o código real (`database.js`, `middleware.js`, um módulo
existente completo tipo `routes/pac.js` + `public/pac-lancamento.html`/`.js`
pra ver o padrão de ponta a ponta) antes de propor qualquer desenho — e
pergunte o que estiver em aberto acima antes de escrever a primeira linha
de schema ou rota.
