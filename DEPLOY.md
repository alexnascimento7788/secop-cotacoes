# Guia de Implantação — SECOP Cotações

**Requisito crítico:** Node.js **v22.5.0 ou superior** é obrigatório.  
O projeto usa o módulo `node:sqlite` que é nativo do Node.js a partir da versão 22.5.0. Versões anteriores não funcionam.

---

## Seção A — Deploy em Windows (Servidor ou PC)

### 1. Instalar Node.js

Acesse [https://nodejs.org](https://nodejs.org) e baixe a versão **LTS mais recente** (22.x ou superior).

Execute o instalador `.msi` com as opções padrão. Ao finalizar, abra o PowerShell e confirme:

```powershell
node -v   # deve exibir v22.x.x ou superior
npm -v
```

---

### 2. Transferir o projeto

**Opção A — Via Git (recomendado):**

```powershell
git clone <url-do-repositorio> "C:\Projetos\Secop Cotacoes"
cd "C:\Projetos\Secop Cotacoes"
npm install
```

**Opção B — Via cópia manual (pendrive ou rede):**

Copie a pasta do projeto para o servidor. Depois:

```powershell
cd "C:\Projetos\Secop Cotacoes"
npm install
```

> A pasta `node_modules` não precisa ser copiada. O `npm install` recria ela a partir do `package.json`.

---

### 3. Transferir o banco de dados

O arquivo `data\secop.db` contém todos os dados e **não está no Git**.

**Opção A — Pela interface do sistema (recomendado):**
1. No computador de origem: acesse o sistema → Admin → aba "Banco de Dados" → **Exportar**. Salve o arquivo `secop.db`.
2. No servidor novo: inicie o sistema (passo 4 abaixo), acesse Admin → "Banco de Dados" → **Importar** o arquivo baixado. O sistema reinicia automaticamente.

**Opção B — Cópia direta do arquivo:**

Copie o arquivo `data\secop.db` da máquina de origem para a pasta `data\` do projeto no servidor.

---

### 4. Testar a execução

```powershell
cd "C:\Projetos\Secop Cotacoes"
npm start
```

Acesse no navegador: `http://localhost:3000`

Se funcionar, pressione `Ctrl+C` para parar e siga para o passo 5.

---

### 5. Manter rodando como serviço Windows (PM2)

Sem um gerenciador de processo, o sistema para quando o terminal é fechado ou o Windows reinicia.

**Instalar PM2 e o módulo de serviço Windows:**

```powershell
npm install -g pm2
npm install -g pm2-windows-startup
```

**Iniciar o sistema:**

```powershell
cd "C:\Projetos\Secop Cotacoes"
pm2 start npm --name "secop" -- start
pm2 save
pm2-startup install
```

O sistema agora inicia automaticamente com o Windows, sem precisar de terminal aberto.

**Comandos úteis do PM2:**

```powershell
pm2 status              # ver se está rodando
pm2 logs secop          # ver logs em tempo real
pm2 restart secop       # reiniciar o sistema
pm2 stop secop          # parar o sistema
```

---

### 6. Liberar a porta no Firewall do Windows

Por padrão o sistema roda na porta 3000. Para que outros computadores da rede interna acessem:

```powershell
# Executar como Administrador
New-NetFirewallRule -DisplayName "SECOP Cotacoes" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

Após isso, outros PCs da rede podem acessar via: `http://IP-DO-SERVIDOR:3000`

Para descobrir o IP do servidor:

```powershell
ipconfig
# Procure pelo endereço IPv4 da interface de rede local (ex: 192.168.1.x)
```

---

### 7. Mudar a porta (opcional)

Para rodar em uma porta diferente, defina a variável de ambiente antes de iniciar:

```powershell
$env:PORT = "8080"
pm2 restart secop --update-env
```

Ou crie um arquivo `.env` na raiz do projeto (requer ajuste no `server.js` para carregar dotenv, se necessário).

---

## Seção B — Deploy em Linux (Ubuntu / Debian)

### 1. Instalar Node.js v22+

```bash
# Adicionar repositório NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -

# Instalar Node.js
sudo apt-get install -y nodejs

# Confirmar versão
node -v   # deve exibir v22.x.x ou superior
npm -v
```

---

### 2. Transferir o projeto

**Opção A — Via Git (recomendado):**

```bash
sudo mkdir -p /opt/secop-cotacoes
sudo chown $USER:$USER /opt/secop-cotacoes

git clone <url-do-repositorio> /opt/secop-cotacoes
cd /opt/secop-cotacoes
npm install
```

**Opção B — Via SCP (do Windows para o Linux):**

No PowerShell do Windows:

```powershell
# Copiar a pasta inteira (exceto node_modules e data)
scp -r "C:\Projetos\Secop Cotacoes\*" usuario@IP-DO-SERVIDOR:/opt/secop-cotacoes/
```

No Linux, após receber os arquivos:

```bash
cd /opt/secop-cotacoes
npm install
```

---

### 3. Permissões da pasta de dados

```bash
mkdir -p /opt/secop-cotacoes/data
chmod 755 /opt/secop-cotacoes/data
```

---

### 4. Transferir o banco de dados

Igual ao processo descrito na Seção A (item 3). Use a interface de exportação/importação do admin, ou copie o arquivo `secop.db` diretamente para `/opt/secop-cotacoes/data/`.

**Via SCP do Windows para o Linux:**

```powershell
scp "C:\Projetos\Secop Cotacoes\data\secop.db" usuario@IP-DO-SERVIDOR:/opt/secop-cotacoes/data/
```

---

### 5. Testar a execução

```bash
cd /opt/secop-cotacoes
npm start
```

Acesse no navegador: `http://IP-DO-SERVIDOR:3000`

Se funcionar, pressione `Ctrl+C` para parar e siga para o passo 6.

---

### 6. Manter rodando como serviço (PM2 + systemd)

```bash
# Instalar PM2 globalmente
sudo npm install -g pm2

# Iniciar o sistema
cd /opt/secop-cotacoes
pm2 start npm --name "secop" -- start
pm2 save

# Gerar e ativar serviço systemd (copie e execute o comando que aparecer)
pm2 startup
# O comando gerado será algo como:
# sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u usuario --hp /home/usuario
# Execute esse comando exatamente como mostrado
```

**Comandos úteis do PM2:**

```bash
pm2 status              # ver se está rodando
pm2 logs secop          # ver logs em tempo real
pm2 restart secop       # reiniciar
pm2 stop secop          # parar
```

---

### 7. Configurar Nginx como proxy reverso (porta 80)

Instalar o Nginx:

```bash
sudo apt-get install -y nginx
```

Criar configuração do site:

```bash
sudo nano /etc/nginx/sites-available/secop
```

Conteúdo do arquivo:

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Ativar o site e reiniciar o Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/secop /etc/nginx/sites-enabled/
sudo nginx -t                    # testar configuração
sudo systemctl restart nginx
sudo systemctl enable nginx      # iniciar com o sistema
```

Após isso, o sistema fica acessível em `http://IP-DO-SERVIDOR` (sem precisar digitar `:3000`).

---

### 8. Liberar porta no firewall Linux (UFW)

```bash
sudo ufw allow 80/tcp      # se estiver usando Nginx (recomendado)
# ou
sudo ufw allow 3000/tcp    # se acessar direto sem Nginx

sudo ufw enable
sudo ufw status
```

---

## Seção C — Migração Futura: SQLite → SQL Server

Esta seção documenta o que será necessário quando o sistema for migrado do banco SQLite (MVP) para o SQL Server (banco corporativo da CEASAMINAS).

### O que NÃO muda

- Todo o frontend (`public/`)
- Todas as rotas e lógica de negócio do `server.js`
- O sistema de autenticação
- A estrutura de dados (tabelas e relacionamentos permanecem os mesmos)

### O que muda

**1. Instalar o driver SQL Server:**

```bash
npm install mssql
```

**2. Substituir a inicialização do banco em `database.js`:**

```javascript
// ANTES (SQLite)
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/secop.db');

// DEPOIS (SQL Server)
const sql = require('mssql');
const pool = await sql.connect({
  user: 'secop_user',
  password: 'senha',
  server: 'IP-DO-SQL-SERVER',
  database: 'secop_cotacoes',
  options: { encrypt: false, trustServerCertificate: true }
});
```

**3. Ajustes de sintaxe SQL:**

| SQLite | SQL Server |
|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `INT PRIMARY KEY IDENTITY(1,1)` |
| `REAL` | `FLOAT` |
| `DATETIME DEFAULT CURRENT_TIMESTAMP` | `DATETIME DEFAULT GETDATE()` |
| `julianday('now') - julianday(col)` | `DATEDIFF(day, col, GETDATE())` |
| `strftime('%Y-%m', col)` | `FORMAT(col, 'yyyy-MM')` |
| Parâmetros `?` | Parâmetros `@nomeParam` |
| `ON CONFLICT(...) DO UPDATE SET` | `MERGE` ou `IF EXISTS UPDATE ELSE INSERT` |

**4. Estratégia de migração recomendada:**

1. Criar o banco `secop_cotacoes` no SQL Server com as tabelas equivalentes.
2. Exportar os dados do SQLite atual para CSV ou via script de migração.
3. Importar os dados no SQL Server.
4. Substituir apenas a camada `database.js` — o restante do sistema não precisa de alteração.
5. Testar em ambiente de homologação antes de colocar em produção.

---

## Resumo Rápido

| Etapa | Windows | Linux |
|---|---|---|
| Instalar Node.js v22+ | Instalador .msi em nodejs.org | `curl NodeSource \| bash` + `apt install nodejs` |
| Instalar projeto | `git clone` + `npm install` | `git clone` + `npm install` |
| Transferir banco | Export/Import pelo Admin ou cópia do .db | Export/Import pelo Admin ou SCP |
| Testar | `npm start` → localhost:3000 | `npm start` → IP:3000 |
| Serviço permanente | PM2 + pm2-windows-startup | PM2 + pm2 startup (systemd) |
| Porta 80 (opcional) | — | Nginx como proxy reverso |
| Firewall | New-NetFirewallRule porta 3000 | ufw allow 80 |
