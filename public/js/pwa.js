// Registra o service worker em todas as páginas (inclusive login.html) para
// permitir instalar o SECOP Cotações como PWA.
//
// Sem isto, uma aba deixada aberta durante um deploy continua sendo
// controlada pelo Service Worker ANTIGO: mesmo ele buscando a versão nova em
// segundo plano (skipWaiting + clients.claim já fazem essa troca sozinhos,
// ver sw.js), o JS que já está rodando na aba (funções, handlers) continua
// sendo o antigo até uma navegação/F5 acontecer — só um F5 comum não força
// nada, então na prática só um hard-refresh (Ctrl+Shift+R) resolvia, e às
// vezes nem isso na primeira tentativa (achado numa demonstração ao vivo,
// 2026-09-08: precisou de vários Ctrl+Shift+R pra "mensageria" nova aparecer).
// `controllerchange` dispara assim que o SW novo assume o controle da
// página — recarregando automaticamente nesse momento, a aba se atualiza
// sozinha, sem depender do usuário saber fazer hard-refresh.
// `refreshing` evita um loop: o próprio reload dispara um novo `register()`,
// que só troca de controller de novo se houver OUTRO deploy no meio (raro,
// mas sem a trava recarregaria em cadeia).
if ('serviceWorker' in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
