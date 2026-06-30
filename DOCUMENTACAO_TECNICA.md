# Documentação Técnica — SECOP Cotações
**Versão:** 1.0 MVP  
**Organização:** CEASAMINAS — Centrais de Abastecimento de Minas Gerais  
**Setor responsável:** SECOP (Setor de Compras)

---

## 1. Visão Geral

O **SECOP Cotações** é um sistema web interno desenvolvido para o setor de compras da CEASAMINAS. Seu objetivo é gerenciar processos de cotação de compras públicas, permitindo o cadastro de processos, itens, fornecedores e preços, além de gerar um quadro comparativo de propostas.

O sistema é um MVP (Produto Mínimo Viável) construído para validação interna antes de uma eventual migração para ambiente de produção com banco de dados corporativo (SQL Server).

---

## 2. Stack Tecnológica

| Camada | Tecnologia | Versão | Justificativa |
|---|---|---|---|
| Runtime | Node.js | v22+ obrigatório | Uso do módulo nativo `node:sqlite`, disponível a partir do v22.5.0 |
| Backend | Express | 4.18.x | Framework web minimalista, sem overhead desnecessário para um MVP |
| Banco de dados | SQLite (nativo) | Embutido no Node | Zero configuração, arquivo único, ideal para MVP e uso local |
| Frontend | HTML + CSS + JS puro | — | Sem framework frontend; reduz complexidade e dependências |
| Autenticação | Crypto (nativo Node) | — | PBKDF2-SHA512 via módulo built-in, sem bibliotecas externas |
| Leitura de Excel | SheetJS (CDN) | 0.18.5 | Carregado sob demanda no navegador, sem instalação no servidor |

**Dependências npm instaladas:**

```json
{
  "dependencies": {
    "express": "^4.18.2"
  },
  "devDependencies": {
    "nodemon": "^3.1.0"
  }
}
```

O projeto deliberadamente evita pacotes npm além do Express. Funcionalidades como parse de cookies, sessões, upload de arquivo e acesso ao banco são feitas com módulos nativos do Node.js.

---

## 3. Estrutura de Arquivos

```
secop-cotacoes/
│
├── server.js               # Servidor Express: rotas, autenticação, API
├── database.js             # Inicialização do banco e definição das tabelas
├── package.json            # Dependências e scripts npm
│
├── data/
│   └── secop.db            # Banco de dados SQLite (gerado automaticamente)
│
└── public/                 # Arquivos servidos diretamente ao navegador
    ├── index.html          # Dashboard
    ├── processos.html      # Lista de processos
    ├── novo-processo.html  # Cadastro/edição de processo
    ├── cotacao.html        # Quadro comparativo de preços
    ├── fornecedor.html     # Cadastro de fornecedor e preços
    ├── admin.html          # Administração (usuários e banco)
    ├── login.html          # Tela de autenticação
    │
    ├── css/
    │   └── style.css       # Estilo global do sistema
    │
    ├── js/
    │   ├── auth.js         # Verificação de sessão e logout (compartilhado)
    │   ├── dashboard.js    # Lógica do dashboard
    │   ├── processos.js    # Lógica da lista de processos
    │   ├── novo-processo.js# Lógica de cadastro/edição de processo
    │   ├── cotacao.js      # Lógica do quadro comparativo
    │   └── fornecedor.js   # Lógica de cadastro de fornecedor
    │
    └── img/                # Logotipos e ícones
        ├── Ceasa_Signea.png         # Logo horizontal (usado na sidebar)
        ├── Logo_1_transp.png        # Logo quadrado transparente (usado no login)
        └── favicon.svg              # Favicon do sistema (losango CEASAMINAS em SVG)
```

---

## 4. Descrição Detalhada dos Arquivos

### `database.js`

Responsável por toda a inicialização do banco de dados. É carregado uma vez ao iniciar o servidor.

- Abre o banco SQLite em `data/secop.db`, criando o arquivo e a pasta `data/` se não existirem.
- Ativa o modo WAL (Write-Ahead Logging) para melhor desempenho em leituras concorrentes.
- Ativa integridade referencial com `PRAGMA foreign_keys = ON`.
- Cria todas as tabelas com `CREATE TABLE IF NOT EXISTS` (idempotente — seguro rodar múltiplas vezes).
- Executa migrações adicionais via `ALTER TABLE` envoltos em `try/catch` para não quebrar em bancos já atualizados.
- Semeia dados iniciais: status padrão ("Em cotação", "Ag. aprovação", "Concluído", "Parado") e o usuário `master`.
- Exporta `{ db, gerarNumeroProcesso }` para uso no `server.js`.

**Função `gerarNumeroProcesso()`:** Gera o número do processo no formato `ANO/SEQ` (ex: `2026/001`). Consulta o último processo do ano corrente e incrementa o sequencial com padding de 3 dígitos.

---

### `server.js`

Ponto de entrada da aplicação. Configura o Express e define todas as rotas da API REST.

**Helpers de autenticação:**
- `getCookie(req, name)` — lê um cookie da requisição via regex (sem biblioteca cookie-parser).
- `requireAuth(req, res, next)` — middleware que verifica o cookie `secop_sid` contra a tabela `sessions`. Rejeita com 401 se ausente, expirado ou usuário inativo.

**Middleware global:** Todas as rotas `/api/*` passam pelo `requireAuth`, exceto as rotas `/api/auth/*`.

**Grupos de rotas:**

| Grupo | Método | Rota | Descrição |
|---|---|---|---|
| Auth | POST | `/api/auth/login` | Login com hash PBKDF2, cria sessão e seta cookie |
| Auth | POST | `/api/auth/logout` | Remove sessão do banco e limpa cookie |
| Auth | GET | `/api/auth/me` | Retorna dados do usuário logado |
| Processos | GET | `/api/processos` | Lista com filtros (status, setor, busca) |
| Processos | POST | `/api/processos` | Cria novo processo com número automático |
| Processos | GET | `/api/processos/:id` | Busca processo com fornecedores, itens e preços |
| Processos | PUT | `/api/processos/:id` | Atualiza dados do processo |
| Processos | DELETE | `/api/processos/:id` | Remove processo (cascade) |
| Processos | PATCH | `/api/processos/:id/status` | Troca de status com registro no histórico |
| Processos | PUT | `/api/processos/:id/vencedor/:fid` | Define fornecedor vencedor |
| Processos | PATCH | `/api/processos/:id/mostrar-menor-preco` | Toggle de destaque de menor preço |
| Fornecedores | GET/POST | `/api/processos/:id/fornecedores` | Lista ou cria fornecedor no processo |
| Fornecedores | GET/PUT/DELETE | `/api/fornecedores/:id` | Detalha, edita ou remove fornecedor |
| Itens | GET/POST | `/api/processos/:id/itens` | Lista ou cria item no processo |
| Itens | PUT/DELETE | `/api/itens/:id` | Edita ou remove item |
| Preços | POST | `/api/precos` | Upsert de preço (cria ou atualiza) |
| Dashboard | GET | `/api/dashboard/resumo` | Métricas e alertas do dashboard |
| Status | GET/POST/PUT/DELETE | `/api/status` | CRUD da tabela de status |
| Setores | GET | `/api/setores` | Lista setores únicos para filtros |
| Admin | GET | `/api/admin/users` | Lista usuários (exclui master) |
| Admin | POST | `/api/admin/users` | Cria usuário com senha hash |
| Admin | PATCH | `/api/admin/users/:id` | Altera senha, ativa/desativa, muda role |
| Admin | DELETE | `/api/admin/users/:id` | Remove usuário |
| Admin | GET | `/api/admin/export-db` | Faz checkpoint WAL e envia o .db como download |
| Admin | POST | `/api/admin/import-db` | Recebe .db binário, substitui o banco e reinicia o processo |

**Porta:** `process.env.PORT` ou `3000` por padrão. Escuta em `0.0.0.0` (todas as interfaces de rede).

---

### `public/login.html`

Tela de autenticação. Fundo cinza esverdeado suave (`#f0f4f1`) para compatibilidade com logos de fundo transparente.

- Exibe o logo da CEASAMINAS centralizado com fallback para SVG caso a imagem não seja encontrada.
- Formulário com campos de usuário e senha.
- Ao submeter, chama `POST /api/auth/login`. Em caso de sucesso, redireciona para `index.html`.
- Exibe mensagem de erro inline sem recarregar a página.

---

### `public/js/auth.js`

Script compartilhado incluído em todas as páginas protegidas (exceto `login.html`).

- Ao carregar a página, chama `GET /api/auth/me`. Se não autenticado, redireciona para `login.html`.
- Se autenticado, exibe o nome do usuário no elemento `#sidebar-username` e injeta o botão de alternância de tema (lua/sol) no rodapé da sidebar.
- Expõe a função `logout()` usada pelo botão de saída na sidebar.
- **Dark mode:** Funções `toggleDark()` e `_temaAtual()` gerenciam o tema. A preferência é salva em `localStorage` com a chave `secop_tema` (`'light'` ou `'dark'`). O atributo `data-theme` é aplicado no `<html>` e o CSS reage via `[data-theme="dark"]`.

---

### `public/index.html` + `public/js/dashboard.js`

Dashboard com visão geral das cotações.

- **Cards de métricas:** Em cotação, Ag. aprovação, Concluídos no mês, Parados >15 dias.
- **Tabela de alertas:** Processos parados ou sem atualização há mais de 15 dias.
- **Últimos 5 processos:** Com status em badge colorido.
- **Distribuição por setor:** Contagem de processos por setor solicitante.
- Processos sem status definido (NULL) são tratados como "Em cotação".

---

### `public/processos.html` + `public/js/processos.js`

Lista paginada de todos os processos com filtros por status, setor e busca textual. Permite troca de status diretamente na linha da tabela via select inline.

---

### `public/novo-processo.html` + `public/js/novo-processo.js`

Formulário multi-etapa (wizard) para criação e edição de processos:

- **Etapa 1 — Identificação:** Objeto, setor, tipo, responsável, datas.
- **Etapa 2 — Itens:** Adição manual de itens ou importação via planilha Excel (.xlsx/.xls/.csv). A importação usa SheetJS carregado dinamicamente via CDN. A planilha deve ter colunas: ID | Produto/Descrição | Quantidade, com linha de cabeçalho e IDs sequenciais a partir de 1.
- **Etapa 3 — Revisão:** Resumo antes de salvar.

---

### `public/fornecedor.html` + `public/js/fornecedor.js`

Cadastro de fornecedores vinculados a um processo. Para cada fornecedor:

- Dados cadastrais: nome, contato, telefone, celular, e-mail.
- Dados comerciais: data da proposta, prazo de entrega, condição de pagamento, prazo de garantia, incluso frete.
- Tabela de preços por item (preço unitário/mês e total/ano).
- Histórico de negociação: proposta inicial e proposta final (preenchimento manual, não calculado automaticamente).

---

### `public/cotacao.html` + `public/js/cotacao.js`

Quadro comparativo de preços entre fornecedores para um processo. Funcionalidades:

- Tabela com itens nas linhas e fornecedores nas colunas.
- Destaque opcional do menor preço por item (toggle "Destacar menor preço").
- Destaque do fornecedor vencedor geral (proposta final mais baixa), marcado com barra dourada.
- Troca de status do processo diretamente na tela.
- Impressão via `window.print()`, com layout específico para impressão (oculta sidebar e controles).
- Campo de observações gerais e observações para portal de compras governamentais.

---

### `public/admin.html`

Painel de administração com três abas:

**Aba Usuários:**
- Lista todos os usuários cadastrados (exceto o usuário `master`).
- Ações: ativar, desativar, trocar senha, excluir.
- Formulário de criação de novo usuário.

**Aba Banco de Dados:**
- Exportar o banco (`secop.db`) via download.
- Importar um banco via drag-and-drop ou seleção de arquivo. Após importação, o servidor reinicia automaticamente.

**Aba Logs:**
- Exibe os últimos 500 eventos registrados no sistema.
- Filtros por data início, data fim, usuário e tipo de log.
- Botão "Limpar logs" para remover todo o histórico (com confirmação).
- Tipos de log com badge colorido: AUTH (azul), PROCESSO (verde), FORNECEDOR (laranja), USUARIO (rosa), BANCO (roxo), SISTEMA (cinza).

---

### `public/css/style.css`

Folha de estilos global do sistema. Principais definições:

- **Variáveis CSS de tema claro (`:root`):** `--verde: #1A6B35`, `--amarelo: #F9A800`, `--surface` (branco), `--surface-2` (cinza claro), `--text` (texto escuro), `--cinza-b` (bordas), entre outras.
- **Dark mode (`[data-theme="dark"]`):** Sobrescreve as variáveis de superfície e texto com tons escuros do estilo GitHub Dark (`#0d1117`, `#161b22`, `#21262d`). Os estilos de impressão nunca são afetados pelo tema.
- Layout de duas colunas: sidebar fixa de 200px + área principal fluida.
- Componentes reutilizáveis: cards, badges de status, tabelas, botões, formulários.
- Estilos de impressão: oculta sidebar e controles, ajusta margens para papel A4 landscape.
- Responsividade básica para telas menores.

---

## 5. Banco de Dados

### Diagrama de relacionamentos

```
processos ──< fornecedores
processos ──< itens ──< precos >── fornecedores
processos ──< status_historico
users ──< sessions
```

### Tabelas

#### `processos`
| Campo | Tipo | Descrição |
|---|---|---|
| id | INTEGER PK | Identificador único |
| numero_processo | TEXT UNIQUE | Número gerado automaticamente (ex: 2026/001) |
| objeto | TEXT NOT NULL | Descrição do objeto da contratação |
| setor_solicitante | TEXT | Setor que solicitou a compra |
| tipo_contratacao | TEXT | Direta, Licitação ou Dispensa |
| responsavel | TEXT | Nome do responsável pelo processo |
| descricao | TEXT | Descrição detalhada |
| previsao_inicio | DATE | Data prevista de início |
| previsao_termino | DATE | Data prevista de término |
| data_abertura | DATE | Data de abertura do processo |
| status | TEXT | Status atual (default: 'Em cotação') |
| proposta_vencedora_id | INTEGER | FK para fornecedor vencedor |
| mostrar_menor_preco | INTEGER | Toggle de destaque (0 ou 1) |
| observacoes | TEXT | Observações gerais |
| observacoes2 | TEXT | Observações para portal governamental |
| criado_em | DATETIME | Data de criação (automático) |
| atualizado_em | DATETIME | Data da última atualização (automático) |

#### `fornecedores`
| Campo | Tipo | Descrição |
|---|---|---|
| id | INTEGER PK | Identificador único |
| processo_id | INTEGER FK | Processo ao qual pertence |
| ordem | INTEGER | Ordem de exibição na tela |
| nome | TEXT | Razão social ou nome fantasia |
| contato | TEXT | Nome do contato |
| telefone | TEXT | Telefone fixo |
| celular | TEXT | Celular |
| email | TEXT | E-mail de contato |
| data_proposta | TEXT | Data da proposta recebida |
| prazo_pagamento | TEXT | Condição de pagamento |
| prazo_entrega | TEXT | Prazo de entrega |
| prazo_garantia | TEXT | Prazo de garantia |
| frete | TEXT | "Sim" ou "Não" — incluso frete |
| proposta_inicial | REAL | Valor da proposta inicial (manual) |
| proposta_final | REAL | Valor da proposta final negociada (manual) |
| observacoes | TEXT | Observações do fornecedor |

#### `itens`
| Campo | Tipo | Descrição |
|---|---|---|
| id | INTEGER PK | Identificador único |
| processo_id | INTEGER FK | Processo ao qual pertence |
| item_num | INTEGER | Número do item (sequencial) |
| quantidade | REAL | Quantidade a ser adquirida |
| unidade | TEXT | Unidade de medida |
| descricao | TEXT | Descrição do item |

#### `precos`
| Campo | Tipo | Descrição |
|---|---|---|
| id | INTEGER PK | Identificador único |
| item_id | INTEGER FK | Item de referência |
| fornecedor_id | INTEGER FK | Fornecedor que ofertou o preço |
| preco_unitario_mes | REAL | Preço unitário por mês |
| preco_total_ano | REAL | Preço total anual |
| — | UNIQUE | Combinação (item_id, fornecedor_id) é única |

#### `status`
| Campo | Tipo | Descrição |
|---|---|---|
| id | INTEGER PK | Identificador único |
| nome | TEXT UNIQUE | Nome do status |
| ordem | INTEGER | Ordem de exibição |

Status padrão: Em cotação (1), Ag. aprovação (2), Concluído (3), Parado (4).

#### `status_historico`
| Campo | Tipo | Descrição |
|---|---|---|
| id | INTEGER PK | Identificador único |
| processo_id | INTEGER FK | Processo afetado |
| status_de | TEXT | Status anterior |
| status_para | TEXT | Novo status |
| alterado_em | DATETIME | Data da alteração (automático) |

#### `users`
| Campo | Tipo | Descrição |
|---|---|---|
| id | INTEGER PK | Identificador único |
| username | TEXT UNIQUE | Nome de usuário |
| senha_hash | TEXT | Hash PBKDF2-SHA512 da senha |
| salt | TEXT | Salt aleatório de 16 bytes (hex) |
| role | TEXT | Papel do usuário (admin) |
| ativo | INTEGER | 1 = ativo, 0 = desativado |
| criado_em | DATETIME | Data de criação |

#### `logs`
| Campo | Tipo | Descrição |
|---|---|---|
| id | INTEGER PK | Identificador único |
| user_id | INTEGER | ID do usuário que realizou a ação (nullable) |
| username | TEXT | Nome do usuário (armazenado diretamente para preservar histórico) |
| tipo | TEXT | Categoria: AUTH, PROCESSO, FORNECEDOR, USUARIO, BANCO, SISTEMA |
| acao | TEXT | Ação executada: LOGIN, LOGOUT, CRIOU, EDITOU, EXCLUIU, STATUS, EXPORTOU, IMPORTOU, ATIVOU, DESATIVOU, SENHA, LIMPOU |
| descricao | TEXT | Detalhes da ação |
| ip | TEXT | Endereço IP da requisição |
| criado_em | DATETIME | Data/hora do evento (automático) |

#### `sessions`
| Campo | Tipo | Descrição |
|---|---|---|
| token | TEXT PK | Token de sessão (32 bytes aleatórios em hex) |
| user_id | INTEGER FK | Usuário dono da sessão |
| expires | DATETIME | Data/hora de expiração (8 horas após login) |

---

## 6. Autenticação e Segurança

- **Hash de senha:** PBKDF2-SHA512 com 100.000 iterações e salt aleatório de 16 bytes por usuário. Implementado com o módulo `crypto` nativo do Node.js.
- **Sessões:** Armazenadas na tabela `sessions` com token de 32 bytes aleatórios. Expiram em 8 horas.
- **Cookie:** `secop_sid` com flags `HttpOnly` e `SameSite=Strict`. Não acessível via JavaScript.
- **Proteção de rotas:** Middleware `requireAuth` protege todas as rotas `/api/*` exceto `/api/auth/*`.
- **Usuário master:** Não pode ser excluído, desativado ou ter seu username alterado. Não aparece na listagem de usuários.
- **Parse de cookie:** Feito via regex sem biblioteca externa (sem cookie-parser).

---

## 7. Funcionalidades Implementadas

- Cadastro, edição e exclusão de processos de cotação
- Geração automática de número de processo por ano (2026/001, 2026/002...)
- Cadastro de múltiplos fornecedores por processo
- Registro de preços por item por fornecedor
- Importação de itens via planilha Excel (.xlsx, .xls, .csv)
- Quadro comparativo de preços entre fornecedores
- Destaque do menor preço por item
- Destaque do fornecedor vencedor geral
- Troca de status com histórico de alterações
- Dashboard com métricas e alertas de processos parados
- Filtros de processos por status, setor e busca textual
- Sistema de login com autenticação segura
- Gestão de usuários (criar, ativar/desativar, trocar senha)
- Registro de logs de auditoria de todas as ações do sistema
- Visualização de logs com filtros por data, usuário e tipo (aba Logs no admin)
- Exportação e importação do banco de dados via painel administrativo
- Impressão do quadro comparativo em formato A4
- Identidade visual CEASAMINAS
- Modo escuro (dark mode) com alternância via botão lua/sol na sidebar, persistido em localStorage
- Favicon SVG em forma de losango com cores CEASAMINAS

---

## 8. Limitações do MVP e Roadmap para Produção

| Limitação atual | Solução prevista para produção |
|---|---|
| Banco SQLite (arquivo local) | Migração para SQL Server (banco oficial CEASAMINAS) |
| Sem controle de permissões por tela | Sistema de roles granular (admin, operador, visualizador) |
| Sem envio de e-mail | Notificações automáticas para fornecedores e aprovadores |
| Sem assinatura digital | Integração com assinatura eletrônica para documentos |
| Sem versionamento de propostas | Histórico completo de preços por rodada de negociação |
| Sem relatórios exportáveis | Geração de PDF e Excel dos quadros comparativos |
| Processo de import de BD reinicia servidor | Migração hot sem downtime em produção |

---

## 9. Migração Planejada: SQLite → SQL Server

O banco de dados atual (SQLite) é adequado para MVP e uso local. Para produção na CEASAMINAS, a migração para SQL Server será necessária pois é o banco corporativo padrão da organização.

**O que muda:**
- `database.js`: substituir `node:sqlite` pelo pacote `mssql` (ou `tedious`). As queries SQL são quase idênticas — SQLite e SQL Server compartilham sintaxe ANSI SQL. Os principais ajustes são em tipos de dados (`INTEGER` → `INT`, `REAL` → `FLOAT`, `DATETIME DEFAULT CURRENT_TIMESTAMP` → `DATETIME DEFAULT GETDATE()`), parâmetros posicionais (`?` → `@param`) e a função de data `julianday` → `DATEDIFF`.
- `server.js`: nenhuma mudança na lógica de negócio ou nas rotas.
- `public/`: nenhuma mudança no frontend.

**O que não muda:**
- Toda a lógica de negócio
- Todas as rotas da API
- Todo o frontend
- O sistema de autenticação (apenas a camada de acesso ao banco é trocada)
