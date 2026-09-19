/* Офлайн-кэш. Версию менять при каждом изменении файлов ниже,
   иначе браузер продолжит отдавать старое содержимое. */
const VERSION = "wortschatz-v3";

/* Оболочка ставится сразу. Словари — нет: три языка это ~14 МБ,
   и тянуть их все при первом запуске незачем. Кладём только язык
   по умолчанию, остальные кэшируются при первом переключении. */
const SHELL = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/app.js",
  "./js/db-worker.js",
  "./js/progress.js",
  "./js/mascot.js",
  "./vendor/sql-wasm.js",
  "./vendor/sql-wasm.wasm",
  "./db/wortschatz-de.db",
  "./icon-192.png",
  "./icon-512.png",
  "./manifest.webmanifest",
  "./mascot/base.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // Один недостающий файл не должен ронять всю установку.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      // Промах — скачиваем и кладём в кэш: так словарь второго языка
      // становится доступен офлайн сразу после первого переключения.
      return fetch(e.request).then((res) => {
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      });
    })
  );
});
