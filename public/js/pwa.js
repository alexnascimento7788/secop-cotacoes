// Registra o service worker em todas as páginas (inclusive login.html) para
// permitir instalar o SECOP Cotações como PWA.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
