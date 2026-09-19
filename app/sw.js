/* Офлайн-кэш. Версиюменять при каждом изменении файлов ниже,
   иначе браузер продолжит отдавать старое содержимое. */
const VERSION = "wortschatz-v1";

const SHELL = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/app.js",
  "./js/db-worker.js",
  "./vendor/sql-wasm.js",
  "./vendor/sql-wasm.wasm",
  "./wortschatz.db",
  "./icon.svg",
  "./manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  // Словарь весит ~4,5 МБ и кладётся в кэш сразу: без него приложение бесполезно.
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // Сначала кэш: содержимое статично, а работа без сети — главное требование.
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
