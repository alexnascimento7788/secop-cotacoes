# SECOP Cotações — CEASAMINAS

Sistema de gerenciamento de processos de cotação do Setor de Compras (SECOP).

## Requisitos

- Node.js 18 ou superior → https://nodejs.org

## Instalação e execução

1. Instale o Node.js em https://nodejs.org (versão LTS recomendada)

2. Abra o terminal (PowerShell ou CMD) na pasta do projeto:
   ```
   cd "C:\Projetos\Secop Cotacoes"
   ```

3. Instale as dependências:
   ```
   npm install
   ```

4. Inicie o servidor:
   ```
   npm start
   ```

5. Acesse no navegador:
   ```
   http://localhost:3000
   ```

6. Para acesso em rede local (outros computadores):
   ```
   http://IP_DA_MAQUINA:3000
   ```
   Exemplo: `http://192.168.1.100:3000`

7. **Liberar porta 3000 no Firewall do Windows** (necessário para acesso em rede):
   - Painel de Controle → Windows Defender Firewall → Configurações avançadas
   - Regras de Entrada → Nova Regra → Porta → TCP → 3000
   - Permitir a conexão → Marcar todos os perfis → Nome: "SECOP Cotações"

## Desenvolvimento

Para reinício automático ao editar arquivos:
```
npm run dev
```
(requer `nodemon`, já incluído nas devDependencies)

## Estrutura

```
secop-cotacoes/
├── server.js          Servidor Express + rotas da API
├── database.js        Configuração do SQLite e criação das tabelas
├── package.json
├── data/
│   └── secop.db       Banco de dados (criado automaticamente)
└── public/
    ├── index.html     Dashboard
    ├── processos.html Lista de processos
    ├── novo-processo.html  Formulário de novo processo
    ├── cotacao.html   Quadro comparativo de preços
    ├── css/style.css
    └── js/
        ├── dashboard.js
        ├── processos.js
        ├── novo-processo.js
        └── cotacao.js
```

## Backup

O banco de dados fica em `data/secop.db`. Faça cópias regulares desse arquivo.
