import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const publicDirectory = new URL("../public/", import.meta.url);
const source = await readFile(new URL("sw.js", publicDirectory), "utf8");
const origin = "https://growth.kasitek.co.za";

function worker({ offline = false } = {}) {
  const listeners = new Map();
  const stores = new Map();
  const network = [];
  const deleted = [];
  const opened = [];
  const notifications = [];
  let skipped = 0;
  let claimed = 0;
  const caches = {
    async keys() { return [...stores.keys()]; },
    async delete(key) { deleted.push(key); return stores.delete(key); },
    async open(key) {
      if (!stores.has(key)) stores.set(key, new Map());
      const store = stores.get(key);
      return {
        async addAll(requests) {
          for (const request of requests) store.set(new URL(request.url).pathname, new Response("public offline asset"));
        },
        async match(key) { return store.get(typeof key === "string" ? key : key.url)?.clone(); },
        async put(key, response) { store.set(key, response); },
      };
    },
  };
  class WorkerRequest extends Request {
    constructor(input, init) { super(typeof input === "string" ? new URL(input, origin) : input, init); }
  }
  const context = {
    URL, Request: WorkerRequest, Response, caches,
    fetch: async (request) => {
      network.push(request);
      if (offline) throw new TypeError("Offline");
      return new Response("network response");
    },
    self: {
      location: { origin },
      addEventListener: (name, listener) => listeners.set(name, listener),
      skipWaiting: async () => { skipped++; },
      clients: {
        claim: async () => { claimed++; },
        matchAll: async () => [],
        openWindow: async (url) => { opened.push(url); },
      },
      registration: { showNotification: async (...args) => { notifications.push(args); } },
    },
  };
  vm.runInNewContext(source, context, { filename: "sw.js" });
  return {
    stores, network, deleted, opened, notifications,
    get skipped() { return skipped; },
    get claimed() { return claimed; },
    async emit(name, data = {}) {
      let response;
      let pending;
      listeners.get(name)({
        ...data,
        waitUntil: (promise) => { pending = promise; },
        respondWith: (promise) => { response = promise; },
      });
      await pending;
      return response;
    },
    request(path, mode = "navigate", method = "GET") { return { url: new URL(path, origin).href, mode, method }; },
  };
}

test("install caches only existing public assets and waits for explicit update acceptance", async () => {
  const service = worker();
  await service.emit("install");
  assert.equal(service.skipped, 0);
  const store = service.stores.get("kasitek-pwa-v2-static");
  assert.ok(store.has("/offline.html"));
  for (const path of store.keys()) {
    assert.notEqual(path, "/");
    assert.notEqual(path, "/offline");
    await readFile(new URL(`.${path}`, publicDirectory));
  }
  await service.emit("message", { data: { type: "SKIP_WAITING" } });
  assert.equal(service.skipped, 1);
});

test("activation removes prior Growth cache versions without touching unrelated caches", async () => {
  const service = worker();
  for (const name of ["kasitek-pwa-v1-pages", "kasitek-pwa-v1-static", "kasitek-pwa-v2-static", "other-product-cache", "kasitek-user-assets"]) service.stores.set(name, new Map());
  await service.emit("activate");
  assert.deepEqual(service.deleted.sort(), ["kasitek-pwa-v1-pages", "kasitek-pwa-v1-static"]);
  assert.equal(service.claimed, 1);
  assert.ok(service.stores.has("other-product-cache"));
});

test("private, public and token navigations always use network without caching their HTML", async () => {
  const service = worker();
  await service.emit("install");
  const initialAssets = [...service.stores.get("kasitek-pwa-v2-static").keys()];
  for (const path of ["/", "/agents", "/calls", "/developers/api-keys", "/upgrade/pro", "/invite/secret", "/onboarding", "/login?returnTo=/inbox"]) {
    const response = await service.emit("fetch", { request: service.request(path) });
    assert.equal(await response.text(), "network response");
  }
  assert.equal(service.network.length, 8);
  assert.equal(service.stores.size, 1);
  assert.deepEqual([...service.stores.get("kasitek-pwa-v2-static").keys()], initialAssets);
});

test("offline navigation shows a session-independent document instead of an old authenticated page", async () => {
  const service = worker({ offline: true });
  await service.emit("install");
  service.stores.set("kasitek-pwa-v1-pages", new Map([[`${origin}/agents`, new Response("private previous user")]]));
  const response = await service.emit("fetch", { request: service.request("/agents") });
  assert.equal(await response.text(), "public offline asset");
});

test("API, external origins, writes, unknown assets and token-bearing assets bypass worker caching", async () => {
  const service = worker();
  for (const request of [
    service.request("/api/me"), service.request("/api"), service.request("https://other.example/logo.png", "cors"),
    service.request("/contacts", "cors", "POST"), service.request("/assets/app-hash.js", "cors"),
    service.request("/logo.png?token=private", "cors"),
  ]) assert.equal(await service.emit("fetch", { request }), undefined);
  assert.equal(service.stores.size, 0);
});

test("push notifications retain metadata and restrict click destinations to Growth", async () => {
  const service = worker();
  await service.emit("push", { data: { json: () => ({ title: "Reply", body: "New message", url: "/inbox?conversation=1", tag: "message-1" }) } });
  assert.equal(service.notifications[0][0], "Reply");
  assert.equal(service.notifications[0][1].tag, "message-1");
  for (const url of ["/inbox?conversation=1", "https://evil.example/", "//evil.example/", "javascript:alert(1)", "http://["]) {
    await service.emit("notificationclick", { notification: { close() {}, data: { url } } });
  }
  assert.equal(service.opened[0], `${origin}/inbox?conversation=1`);
  assert.ok(service.opened.slice(1).every((url) => url === `${origin}/workspace/notifications`));
});

test("static manifest retains installed application identity and points at icons with truthful dimensions", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.webmanifest", publicDirectory), "utf8"));
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.name, "KasiTek app");
  for (const icon of manifest.icons) {
    const png = await readFile(new URL(`.${icon.src}`, publicDirectory));
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
  }
  const offline = await readFile(new URL("offline.html", publicDirectory), "utf8");
  assert.match(offline, /noindex, nofollow/);
  assert.doesNotMatch(offline, /<script|_next\/|\/assets\//);
});
