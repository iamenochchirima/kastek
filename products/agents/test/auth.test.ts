import { describe, expect, it } from "vitest";
import { authenticateRequest, signInternalToken, verifyInternalToken } from "../src/http/auth";
import type { AppConfig } from "../src/config";

const baseConfig: AppConfig = {
  NODE_ENV: "test",
  PORT: 4100,
  HOST: "127.0.0.1",
  AGENTS_DATABASE_URL: "postgres://unused",
  AGENTS_DATABASE_POOL_MAX: 1,
  TEMPORAL_ENABLED: false,
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "test",
  INTERNAL_AUTH_AUDIENCE: "kasitek-agents",
  AUTH_MODE: "hmac",
  INTERNAL_AUTH_SECRET: "test-secret",
  LOG_LEVEL: "silent",
};

describe("internal auth boundary", () => {
  it("signs and verifies an audience-bound scoped token", () => {
    const token = signInternalToken({ organizationId: "org", actorId: "actor", audience: "kasitek-agents", expiresAt: Math.floor(Date.now() / 1000) + 60, scopes: ["agent:run"] }, "test-secret");
    expect(verifyInternalToken(token, "test-secret", "kasitek-agents")).toMatchObject({ organizationId: "org", actorId: "actor", scopes: ["agent:run"] });
    expect(() => verifyInternalToken(`${token}tampered`, "test-secret", "kasitek-agents")).toThrow();
  });

  it("rejects expired tokens and accepts local development headers", () => {
    const expired = signInternalToken({ organizationId: "org", actorId: "actor", audience: "kasitek-agents", expiresAt: Math.floor(Date.now() / 1000) - 1, scopes: [] }, "test-secret");
    expect(() => verifyInternalToken(expired, "test-secret", "kasitek-agents")).toThrow("expired");
    expect(authenticateRequest({ organizationId: "org", actorId: "actor" }, { ...baseConfig, AUTH_MODE: "headers" })).toMatchObject({ organizationId: "org", actorId: "actor" });
  });

  it("keeps platform-operator authentication distinct from workspace tokens", () => {
    const token = signInternalToken({ organizationId: "platform", actorId: "admin-1", audience: "kasitek-agents", expiresAt: Math.floor(Date.now() / 1000) + 60, scopes: ["operator:read"], operator: true }, "test-secret");
    expect(verifyInternalToken(token, "test-secret", "kasitek-agents")).toMatchObject({ organizationId: "platform", actorId: "admin-1", scopes: ["operator:read"], operator: true });
    expect(authenticateRequest({ organizationId: "platform", actorId: "admin-1", operator: "true" }, { ...baseConfig, AUTH_MODE: "headers" })).toMatchObject({ organizationId: "platform", actorId: "admin-1", operator: true });
  });
});
