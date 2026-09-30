// The Labs origin previously shared a host with the client PWA. This one-shot
// worker removes stale registrations without introducing a service worker for Labs.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await self.registration.unregister();

      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      await Promise.all(clients.map((client) => client.navigate(client.url)));
    })(),
  );
});
