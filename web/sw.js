// オフラインでも起動できるようにアプリ本体をキャッシュ（更新はネットワーク優先）
const CACHE = "kensho-v2";
const FILES = ["./", "index.html", "app.js", "logic.js", "style.css", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "install.html"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
