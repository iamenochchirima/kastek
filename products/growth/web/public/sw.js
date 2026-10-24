const CACHE_VERSION = "kasitek-pwa-v2";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const OFFLINE_URL = "/offline.html";

// Only session-independent files belong in Cache Storage. App HTML and APIs always use the network.
const PUBLIC_ASSETS = new Set([
  OFFLINE_URL,
  "/logo.png",
  "/icon-192.png",
  "/icon-512.png",
  "/maskable-icon-512.png",
  "/apple-touch-icon.png",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      cache.addAll([...PUBLIC_ASSETS].map((url) => new Request(url, { cache: "reload", credentials: "omit" }))),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => /^kasitek-pwa-v\d+-(?:static|pages)$/.test(key) && key !== STATIC_CACHE)
          .map((key) => caches.delete(key)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    // Never replay an authenticated page, invitation, OAuth return or token URL offline.
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(STATIC_CACHE);
      return await cache.match(OFFLINE_URL) || Response.error();
    }));
    return;
  }

  if (url.search || !PUBLIC_ASSETS.has(url.pathname)) return;
  event.respondWith(caches.open(STATIC_CACHE).then(async (cache) => {
    const cached = await cache.match(url.pathname);
    if (cached) return cached;
    const response = await fetch(new Request(request, { credentials: "omit" }));
    const policy = response.headers.get("Cache-Control") || "";
    if (response.ok && !response.redirected && response.type !== "opaque" && !/no-store|private/i.test(policy)) {
      await cache.put(url.pathname, response.clone());
    }
    return response;
  }));
});

function notificationTarget(value) {
  try {
    const target = new URL(value, self.location.origin);
    if (target.origin === self.location.origin && !target.username && !target.password) return target.href;
  } catch {
    // Malformed or external notification links return to the notification inbox.
  }
  return new URL("/workspace/notifications", self.location.origin).href;
}

self.addEventListener("push", (event) => {
  const fallback = {
    title: "KasiTek",
    body: "You have a new notification.",
    url: "/workspace/notifications",
    tag: "kasitek-notification",
  };

  let payload = fallback;
  try {
    const data = event.data ? event.data.json() : null;
    if (data && typeof data === "object") {
      payload = {
        title: typeof data.title === "string" && data.title ? data.title : fallback.title,
        body: typeof data.body === "string" && data.body ? data.body : fallback.body,
        url: typeof data.url === "string" && data.url ? data.url : fallback.url,
        tag: typeof data.tag === "string" && data.tag ? data.tag : fallback.tag,
      };
    }
  } catch {
    payload = fallback;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      data: {
        url: payload.url,
      },
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl =
    event.notification?.data?.url && typeof event.notification.data.url === "string"
      ? event.notification.data.url
      : "/workspace/notifications";
  const absoluteUrl = notificationTarget(targetUrl);

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client && client.url === absoluteUrl) {
          return client.focus();
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(absoluteUrl);
      }

      return undefined;
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
