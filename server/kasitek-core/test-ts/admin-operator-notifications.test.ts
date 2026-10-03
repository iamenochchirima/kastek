import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { buildApp } from "../src-ts/app.js";
import { readConfig } from "../src-ts/config.js";
import type { CoreContext } from "../src-ts/context.js";
import { registerAdminOperationsRoutes } from "../src-ts/routes/admin-operations.js";

test("Admin operator operations proxy through Growth with scoped reads and privileged commands", async () => {
  const secret = "synthetic-operator-secret";
  const requests: {
    method: string;
    url: string;
    token: Record<string, unknown>;
    idempotencyKey: string | undefined;
    body: string;
  }[] = [];
  const upstream = createServer(async (request, response) => {
    const [payload, signature] = String(request.headers.authorization ?? "")
      .slice(7)
      .split(".");
    assert.equal(
      signature,
      createHmac("sha256", secret).update(payload!).digest("base64url"),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      token: JSON.parse(Buffer.from(payload!, "base64url").toString()),
      idempotencyKey: request.headers["idempotency-key"] as string | undefined,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/v1/operator/notifications")
      response.end(
        JSON.stringify({
          notifications: [{ id: "notification-1", status: "unread" }],
        }),
      );
    else if (request.url?.includes("/notifications/"))
      response.end(
        JSON.stringify({ id: "notification-1", status: "acknowledged" }),
      );
    else if (request.url?.startsWith("/v1/operator/commands"))
      response.end(JSON.stringify({ id: "command-1", status: "pending" }));
    else response.end(JSON.stringify({ path: request.url }));
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
  const request = (
    method: "GET" | "POST",
    path: string,
    actor: string,
    payload?: unknown,
    idempotencyKey?: string,
  ) =>
    app.inject({
      method,
      url: `/api/admin/operations${path}`,
      headers: {
        cookie: `kasitek_admin_session=${actor}`,
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      payload,
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

    const runs = await request("GET", "/runs?limit=20", "viewer");
    assert.equal(runs.statusCode, 200);
    assert.equal(requests[2]!.url, "/v1/operator/runs?limit=20");
    assert.deepEqual(requests[2]!.token.scopes, ["operator:read"]);

    const effects = await request(
      "GET",
      "/effects/reconciliation?limit=5",
      "viewer",
    );
    assert.equal(effects.statusCode, 200);
    assert.equal(
      requests[3]!.url,
      "/v1/operator/effects/reconciliation?limit=5",
    );
    assert.deepEqual(requests[3]!.token.scopes, ["operator:read"]);

    const deniedCommand = await request(
      "POST",
      "/commands",
      "viewer",
      { commandType: "retention_reconcile", payload: { scopeType: "org" } },
      "fixture-command-key",
    );
    assert.equal(deniedCommand.statusCode, 403);
    assert.equal(requests.length, 4);

    const createdCommand = await request(
      "POST",
      "/commands",
      "operator",
      {
        commandType: "retention_reconcile",
        payload: { scopeType: "organization", scopeId: "org-1" },
      },
      "fixture-command-key",
    );
    assert.equal(createdCommand.statusCode, 202);
    assert.equal(requests[4]!.method, "POST");
    assert.equal(requests[4]!.url, "/v1/operator/commands");
    assert.equal(requests[4]!.idempotencyKey, "fixture-command-key");
    assert.deepEqual(requests[4]!.token.scopes, ["operator:write"]);
    assert.deepEqual(JSON.parse(requests[4]!.body), {
      commandType: "retention_reconcile",
      payload: { scopeType: "organization", scopeId: "org-1" },
    });

    assert.equal(
      (await request("GET", "/commands/command-1", "viewer")).statusCode,
      200,
    );
    assert.equal(requests[5]!.url, "/v1/operator/commands/command-1");
    assert.deepEqual(requests[5]!.token.scopes, ["operator:read"]);

    const approvedCommand = await request(
      "POST",
      "/commands/command-1/approve",
      "operator",
    );
    assert.equal(approvedCommand.statusCode, 202);
    assert.equal(
      requests[6]!.url,
      "/v1/operator/commands/command-1/approve",
    );
    assert.deepEqual(requests[6]!.token.scopes, ["operator:write"]);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
