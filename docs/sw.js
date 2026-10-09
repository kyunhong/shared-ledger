// 서비스 워커 — 앱 화면을 캐시해 오프라인에서도 열리게 함 (API 요청은 건드리지 않음)
const CACHE = 'ledger-v1';
const CHART_JS = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/style.css',
  './js/app.js', './js/api.js', './js/config.js', './js/stats.js', './js/charts.js', './js/store.js',
  './icons/icon-192.png', './icons/apple-touch-icon.png', CHART_JS,
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Chart.js: 버전 고정이라 캐시 우선
  if (req.url === CHART_JS) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
    return;
  }
  if (url.origin !== location.origin) return;

  // 앱 파일: 캐시를 바로 보여주고 뒤에서 새 버전으로 갱신 (다음 실행 때 반영)
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then(res => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
