const CACHE_VERSION = "kasitek-pwa-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGE_CACHE = `${CACHE_VERSION}-pages`;
const OFFLINE_URL = "/offline";

const PRECACHE_URLS = [
  "/",
  "/pricing",
  "/get-quote",
  "/waitlist",
  OFFLINE_URL,
  "/logo.png",
  "/icon-192.png",
  "/icon-512.png",
  "/maskable-icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => ![STATIC_CACHE, PAGE_CACHE].includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isBypassedRequest(requestUrl, request) {
  if (request.method !== "GET") return true;
  if (requestUrl.origin !== self.location.origin) return true;

  const pathname = requestUrl.pathname;

  const workspaceRoutes = [
    "/workspace",
    "/inbox",
    "/contacts",
    "/campaigns",
    "/templates",
    "/content",
    "/calendar",
    "/analytics",
    "/agents",
    "/connections",
    "/billing",
  ];

  if (
    pathname.startsWith("/api/") ||
    workspaceRoutes.some((route) => pathname === route || pathname.startsWith(`${route}/`)) ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/auth")
  ) {
    return true;
  }

  return false;
}

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);

  if (isBypassedRequest(requestUrl, event.request)) {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(PAGE_CACHE).then((cache) => cache.put(event.request, responseClone));
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          if (cached) return cached;
          return caches.match(OFFLINE_URL);
        }),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(event.request).then((response) => {
        const responseClone = response.clone();
        caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, responseClone));
        return response;
      });
    }),
  );
});

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
  const absoluteUrl = new URL(targetUrl, self.location.origin).href;

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
