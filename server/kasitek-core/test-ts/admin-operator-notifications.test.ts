import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { buildApp } from "../src-ts/app.js";
import { readConfig } from "../src-ts/config.js";
import type { CoreContext } from "../src-ts/context.js";
import { registerAdminOperationsRoutes } from "../src-ts/routes/admin-operations.js";

test("Admin operator notifications proxy through Growth with scoped read and acknowledge access", async () => {
  const secret = "synthetic-operator-secret";
  const requests: { method: string; url: string; token: Record<string, unknown> }[] = [];
  const upstream = createServer((request, response) => {
    const [payload, signature] = String(request.headers.authorization ?? "")
      .slice(7)
      .split(".");
    assert.equal(
      signature,
      createHmac("sha256", secret).update(payload!).digest("base64url"),
    );
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      token: JSON.parse(Buffer.from(payload!, "base64url").toString()),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        request.method === "GET"
          ? { notifications: [{ id: "notification-1", status: "unread" }] }
          : { id: "notification-1", status: "acknowledged" },
      ),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const admins = new Map([
    ["viewer", { id: "viewer", name: "Viewer", email: "viewer@example.test", password: "unused", role: "viewer", createdAt: new Date(), updatedAt: new Date() }],
    ["operator", { id: "operator", name: "Operator", email: "operator@example.test", password: "unused", role: "operator", createdAt: new Date(), updatedAt: new Date() }],
  ]);
  const pool = {
    query: async (_sql: string, values: unknown[]) => ({
      rows: admins.has(String(values[0])) ? [admins.get(String(values[0]))] : [],
    }),
  };
  const context = {
    pool,
    config: readConfig({
      DATABASE_URL: "postgres://unused",
      AGENTS_API_URL: `http://127.0.0.1:${address.port}`,
      AGENTS_INTERNAL_AUTH_SECRET: secret,
      AGENTS_INTERNAL_AUTH_AUDIENCE: "kasitek-agents",
      LOG_LEVEL: "silent",
    }),
  } as unknown as CoreContext;
  const app = await buildApp(context, [registerAdminOperationsRoutes]);
  const request = (method: "GET" | "POST", path: string, actor: string) =>
    app.inject({
      method,
      url: `/api/admin/operations${path}`,
      headers: { cookie: `kasitek_admin_session=${actor}` },
    });
  try {
    const listed = await request("GET", "/notifications", "viewer");
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json(), {
      notifications: [{ id: "notification-1", status: "unread" }],
    });
    assert.equal(requests[0]!.method, "GET");
    assert.equal(requests[0]!.url, "/v1/operator/notifications");
    assert.equal(requests[0]!.token.organizationId, "platform");
    assert.equal(requests[0]!.token.actorId, "viewer");
    assert.deepEqual(requests[0]!.token.scopes, ["operator:read"]);
    assert.equal(requests[0]!.token.operator, true);

    const denied = await request(
      "POST",
      "/notifications/notification-1/acknowledge",
      "viewer",
    );
    assert.equal(denied.statusCode, 403);
    assert.equal(requests.length, 1);

    const acknowledged = await request(
      "POST",
      "/notifications/notification-1/acknowledge",
      "operator",
    );
    assert.equal(acknowledged.statusCode, 200);
    assert.deepEqual(acknowledged.json(), {
      id: "notification-1",
      status: "acknowledged",
    });
    assert.equal(requests[1]!.method, "POST");
    assert.equal(
      requests[1]!.url,
      "/v1/operator/notifications/notification-1/acknowledge",
    );
    assert.deepEqual(requests[1]!.token.scopes, ["operator:write"]);
    assert.equal(requests[1]!.token.actorId, "operator");
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
