#!/bin/bash
# Sobe o ambiente de QA (ver "Seção C" em DEPLOY.md): puxa o que já foi
# mergeado em main, e roda via nodemon numa porta separada da de dev/produção
# (3000) pra nunca colidir. Uso: da pasta C:\Projetos\Secop-QA, no Git Bash:
#   bash start-qa.sh
set -e
cd "$(dirname "$0")"

echo "== git pull origin main =="
git pull origin main

if git diff --name-only HEAD@{1} HEAD 2>/dev/null | grep -q "package.json\|package-lock.json"; then
  echo "!! package.json mudou nesse pull — rodando npm install antes de subir =="
  npm install
fi

export PORT=3001
echo "== iniciando na porta $PORT (Ctrl+C pra parar) =="
npm run dev
