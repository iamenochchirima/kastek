import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPortalServer } from "../scripts/serve.mjs";
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    ),
  );
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
test("native portal preserves auth redirects/cookies and distinguishes SPA routes from API/assets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agency-portal-"));
  await writeFile(
    path.join(directory, "index.html"),
    "<html>Agency SPA</html>",
  );
  let observed;
  const api = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    observed = { url: req.url, method: req.method, headers: req.headers, body };
    res.writeHead(302, {
      location: "http://localhost:8080/realms/kasitek",
      "set-cookie": [
        "flow=one; HttpOnly; Path=/",
        "session=two; HttpOnly; Path=/",
      ],
    });
    res.end();
  });
  const upstream = await listen(api);
  const portal = createPortalServer({ directory, target: new URL(upstream) });
  const origin = await listen(portal);
  try {
    const result = await fetch(
      origin + "/api/tenant/api/partner/auth/start?intent=register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: origin,
          cookie: "existing=one",
          "x-kasitek-tenant-slug": "sample",
          "idempotency-key": "request-one",
        },
        body: '{"keep":"body"}',
        redirect: "manual",
      },
    );
    assert.equal(result.status, 302);
    assert.equal(
      result.headers.get("location"),
      "http://localhost:8080/realms/kasitek",
    );
    assert.equal(result.headers.getSetCookie().length, 2);
    assert.equal(observed.url, "/api/partner/auth/start?intent=register");
    assert.equal(observed.body, '{"keep":"body"}');
    assert.equal(observed.headers.cookie, "existing=one");
    assert.equal(observed.headers.origin, origin);
    assert.equal(
      observed.headers["x-kasitek-tenant-host"],
      new URL(origin).host,
    );
    assert.equal(observed.headers["x-kasitek-tenant-slug"], "sample");
    assert.equal(observed.headers["idempotency-key"], "request-one");
    assert.equal(
      await (
        await fetch(origin + "/app/businesses/one", {
          headers: { accept: "text/html" },
        })
      ).text(),
      "<html>Agency SPA</html>",
    );
    assert.equal(
      (
        await fetch(origin + "/assets/missing.js", {
          headers: { accept: "text/html" },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(origin + "/api/missing", {
          headers: { accept: "text/html" },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(origin + "/app/businesses/one", {
          method: "POST",
          headers: { accept: "text/html" },
        })
      ).status,
      405,
    );
  } finally {
    await close(portal);
    await close(api);
    await rm(directory, { recursive: true, force: true });
  }
});
