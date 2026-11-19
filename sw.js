// Bump VERSION on every release. The cache is named after it, and every other cache is deleted on activate.
const VERSION = "triad-v3";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).catch(() =>
          // Offline: only a page navigation falls back to the app shell. Anything else is a real failure.
          req.mode === "navigate" ? caches.match("./index.html") : Response.error(),
        ),
    ),
  );
});
