import { randomUUID } from "node:crypto";
import { generateKeyPair, exportSPKI, exportPKCS8, SignJWT } from "jose";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { requestDigest } from "../src/contracts/contracts";
import { registerProductAgentGateway } from "../src/product/integrations/product-agent-gateway";
import type { GrowthExecutionService } from "../src/product/integrations/growth-execution";
import type { GrowthServiceTrust } from "../src/adapters/products/growth-service-auth";

const issuer = "https://growth.fixture.test";
const actor = { issuer: `${issuer}/identity`, subject: "member" };
const tenantId = "business";

async function fixture() {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const trust: GrowthServiceTrust = { issuer, actorIssuer: actor.issuer, keys: { fixture: await exportSPKI(keys.publicKey) } };
  const execute = vi.fn(async (command: unknown) => ({ executed: command }));
  let currentDigest = "";
  const pool = { query: async (sql: string) => sql.includes("SELECT request_digest")
    ? { rows: [{ request_digest: currentDigest }] } : { rows: [], rowCount: 1 } };
  const app = Fastify({ logger: false });
  registerProductAgentGateway(app, {
    pool: pool as never,
    trust,
    execution: { execute } as unknown as GrowthExecutionService,
  });
  const signed = async (body: unknown, options: { product?: string; key?: CryptoKey; kid?: string; jti?: string; mutate?: boolean } = {}) => {
    const claims = { product: options.product ?? "growth", requestDigest: requestDigest(body) };
    return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: options.kid ?? "fixture" })
      .setIssuer(issuer).setSubject("growth-api").setAudience("agents-product-api")
      .setJti(options.jti ?? randomUUID()).setIssuedAt().setExpirationTime("60s")
      .sign(options.key ?? keys.privateKey);
  };
  const post = async (body: unknown) => {
    currentDigest = requestDigest(body);
    const response = await app.inject({ method: "POST", url: "/internal/v1/products/growth/agent-gateway",
      headers: { authorization: `Bearer ${await signed(body)}`, "content-type": "application/json" }, payload: body as never });
    return { status: response.statusCode, body: response.json() };
  };
  return { app, keys, trust, execute, signed, post };
}

describe("product agent gateway", () => {
  it("accepts a signed shared command and maps it to the Growth run service", async () => {
    const f = await fixture();
    try {
      const command = { version: "1", requestId: randomUUID(), product: "growth", tenantId, actor,
        operation: "runs.start", input: { conversationId: randomUUID(), message: "Hello" } };
      const result = await f.post(command);
      expect(result.status).toBe(200);
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.execute.mock.calls[0]![0]).toMatchObject({ operation: "runs.start", input: { message: "Hello" } });
    } finally { await f.app.close(); }
  });

  it("rejects a wrong product, bad signature, unknown operation and cross-tenant actor", async () => {
    const f = await fixture();
    try {
      const base = { version: "1", requestId: randomUUID(), product: "growth", tenantId, actor,
        operation: "runs.get", input: { taskId: randomUUID() } };
      const wrongProduct = await f.app.inject({ method: "POST", url: "/internal/v1/products/growth/agent-gateway",
        headers: { authorization: `Bearer ${await f.signed({ ...base, product: "agencies" })}`, "content-type": "application/json" }, payload: base as never });
      expect(wrongProduct.statusCode).toBe(401);

      const otherKeys = await generateKeyPair("RS256", { extractable: true });
      const badSignature = await f.app.inject({ method: "POST", url: "/internal/v1/products/growth/agent-gateway",
        headers: { authorization: `Bearer ${await f.signed(base, { key: otherKeys.privateKey })}`, "content-type": "application/json" }, payload: base as never });
      expect(badSignature.statusCode).toBe(401);

      const unknown = await f.post({ ...base, operation: "tasks.legacy" });
      expect(unknown.status).toBe(400);

      const wrongVersion = await f.post({ ...base, version: "2" });
      expect(wrongVersion.status).toBe(400);

      const oversized = await f.post({ ...base, operation: "runs.start",
        input: { conversationId: randomUUID(), message: "x".repeat(131073) } });
      expect(oversized.status).toBe(400);

      const badActor = await f.post({ ...base, actor: { ...actor, issuer: "https://other.test" } });
      expect(badActor.status).toBe(401);
      expect(f.execute).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it("rejects a reused assertion identity for different input", async () => {
    const pool = { query: async (sql: string) => sql.includes("SELECT request_digest")
      ? { rows: [{ request_digest: "different" }] } : { rows: [], rowCount: 1 } };
    const f = await fixture();
    try {
      const command = { version: "1", requestId: randomUUID(), product: "growth", tenantId, actor,
        operation: "runs.get", input: { taskId: randomUUID() } };
      const app = Fastify({ logger: false });
      registerProductAgentGateway(app, { pool: pool as never, trust: f.trust, execution: { execute: f.execute } as unknown as GrowthExecutionService });
      const response = await app.inject({ method: "POST", url: "/internal/v1/products/growth/agent-gateway",
        headers: { authorization: `Bearer ${await f.signed(command)}`, "content-type": "application/json" }, payload: command as never });
      expect(response.statusCode).toBe(409);
      await app.close();
    } finally { await f.app.close(); }
  });
});
