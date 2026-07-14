const CACHE_NAME = 'secop-shell-v1';

const SHELL_FILES = [
  '/login.html',
  '/index.html',
  '/processos.html',
  '/novo-processo.html',
  '/cotacao.html',
  '/fornecedor.html',
  '/admin.html',
  '/css/style.css',
  '/js/auth.js',
  '/js/dashboard.js',
  '/js/processos.js',
  '/js/novo-processo.js',
  '/js/cotacao.js',
  '/js/fornecedor.js',
  '/js/pwa.js',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/img/icons/icon-192.png',
  '/img/icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Nunca cacheia /api/* — dados de cotação precisam sempre vir da rede.
// Para o resto do "shell" (HTML/CSS/JS/ícones), usa stale-while-revalidate:
// responde do cache na hora (se existir) e atualiza o cache em segundo plano.
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then(resp => {
          if (resp && resp.ok) cache.put(request, resp.clone());
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
