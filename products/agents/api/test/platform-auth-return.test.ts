import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { describe, expect, it } from "vitest";
import { LoginReturnCookie, safeApplicationDestination } from "../src/product/identity/auth-return";
import { registerPublicIdentityRoutes } from "../src/product/identity/auth-routes";
import { PlatformError } from "../src/contracts/contracts";

const secret = "independent-return-cookie-test-secret-32-characters";
const token = randomBytes(32).toString("base64url");
const target = "/app/agents/00000000-0000-4000-8000-000000000001?section=memory";

describe("safe application return destinations", () => {
  it("keeps an internal application deep link", () => {
    expect(safeApplicationDestination(target)).toBe(target);
    expect(safeApplicationDestination("/app/tasks?state=running")).toBe("/app/tasks?state=running");
  });
  it.each(["https://evil.test/app", "//evil.test/app", "/\\evil.test", "/app/%2f%2fevil.test", "/app/%252f%252fevil.test", "/app/\\evil", "/app/../login", "/app/auth/callback", "/api/auth/login", "/login", "/application", "/app/\nLocation:evil", "/app//evil", " /app"])("rejects redirect or authentication loop destination %s", value => {
    expect(safeApplicationDestination(value)).toBe("/app");
  });
  it("binds the cookie to its one-use login token, secret and expiry", () => {
    const signing = new LoginReturnCookie(secret), signed = signing.sign(token, target, 1_000);
    expect(signing.read(signed, token, 2_000)).toBe(target);
    expect(signing.read(signed, randomBytes(32).toString("base64url"), 2_000)).toBe("/app");
    expect(signing.read(signed, token, 601_000)).toBe("/app");
    expect(signing.read(signed, token, 0)).toBe("/app");
    expect(signing.read(`${signed.slice(0, 20)}x${signed.slice(21)}`, token, 2_000)).toBe("/app");
    expect(new LoginReturnCookie("a-different-independent-signing-secret").read(signed, token, 2_000)).toBe("/app");
  });
});

// This fixture tests HTTP cookies and recovery only. The real OIDC fixture verifies provider behavior separately.
describe("public identity route cookies and recovery", () => {
  async function fixture({ failBegin = false, secure = false } = {}) {
    const app = Fastify(); await app.register(cookie);
    let consumed = false, signup = false, sessions = 0;
    registerPublicIdentityRoutes(app, {
      secure, sessionCookie: "agents_session", loginCookie: "agents_login", signingSecret: secret,
      identity: {
        async begin(options) { signup = Boolean(options?.signup); if (failBegin) throw new PlatformError("IDENTITY_UNAVAILABLE", 503, "Unavailable"); return { token, redirectTo: "https://identity.example.test/authorize" }; },
        async complete(supplied) {
          if (supplied !== token || consumed) throw new PlatformError("LOGIN_EXPIRED", 400, "Expired");
          consumed = true;
          return { issuer: "https://identity.example.test", subject: "test", email: "fixture@example.test", displayName: "Fixture", providerSessionId: "provider-session", expiresAt: new Date(Date.now() + 60_000) };
        },
      },
      store: {
        async ensureAccount() { return { id: "account", issuer: "https://identity.example.test", subject: "test", email: "fixture@example.test", display_name: "Fixture" }; },
        async createSession() { sessions++; return { token: "new-session", expiresAt: new Date(Date.now() + 60_000) }; },
      },
    });
    await app.ready();
    return { app, isSignup: () => signup, sessions: () => sessions };
  }
  function browserCookies(response: { cookies: { name: string; value: string }[] }) { return response.cookies.map(item => `${item.name}=${item.value}`).join("; "); }
  it("carries a safe return destination and clears transient cookies on callback and replay", async () => {
    const f = await fixture();
    try {
      const start = await f.app.inject(`/api/auth/login?returnTo=${encodeURIComponent(target)}`);
      expect(start.statusCode).toBe(302);
      expect(start.cookies).toHaveLength(2);
      expect(start.cookies.every(item => item.httpOnly && item.sameSite === "Lax" && item.path === "/")).toBe(true);
      const headers = { cookie: browserCookies(start) };
      const completed = await f.app.inject({ url: "/api/auth/callback?code=fixture&state=fixture", headers });
      expect(completed.headers.location).toBe(target); expect(f.sessions()).toBe(1);
      expect(completed.cookies.filter(item => item.maxAge === 0)).toHaveLength(2);
      const replayed = await f.app.inject({ url: "/api/auth/callback?code=fixture&state=fixture", headers });
      expect(replayed.headers.location).toBe("/login?error=expired"); expect(f.sessions()).toBe(1);
      expect(replayed.cookies.filter(item => item.maxAge === 0)).toHaveLength(2);
    } finally { await f.app.close(); }
  });
  it("uses signup intent and secure host cookies", async () => {
    const f = await fixture({ secure: true });
    try {
      const started = await f.app.inject("/api/auth/signup?returnTo=%2F%2Fevil.test");
      expect(f.isSignup()).toBe(true);
      expect(started.cookies.find(item => item.name === "__Host-agents_return")?.secure).toBe(true);
    } finally { await f.app.close(); }
  });
  it("falls back to /app for missing or modified destination cookies without widening login authority", async () => {
    const f = await fixture();
    try {
      const completed = await f.app.inject({ url: "/api/auth/callback?code=fixture&state=fixture", headers: { cookie: `agents_login=${token}; agents_return=tampered.signature` } });
      expect(completed.headers.location).toBe("/app"); expect(f.sessions()).toBe(1);
    } finally { await f.app.close(); }
  });
  it("recovers from provider unavailability without stale transient cookies", async () => {
    const f = await fixture({ failBegin: true });
    try {
      const response = await f.app.inject("/api/auth/signup");
      expect(response.headers.location).toBe("/login?error=unavailable");
      expect(response.cookies.filter(item => item.maxAge === 0)).toHaveLength(2);
      expect(f.sessions()).toBe(0);
    } finally { await f.app.close(); }
  });
});
