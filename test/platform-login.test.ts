import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { approvedReturnTo } from "../src/identity/oidc";
import { registerPlatformLogin } from "../src/http/platform-login";

const base = { NODE_ENV: "test", AGENTS_DATABASE_URL: "postgresql://localhost/unused" };
const enabled = { ...base, AGENTS_OIDC_ISSUER_URL: "http://localhost:8080/realms/kasitek",
  AGENTS_PUBLIC_URL: "http://localhost:3100", AGENTS_OIDC_CLIENT_ID: "agents", AGENTS_OIDC_CLIENT_SECRET: "test-secret",
  AGENTS_OIDC_ADMIN_CLIENT_ID: "agents-session-admin", AGENTS_OIDC_ADMIN_CLIENT_SECRET: "test-admin-secret" };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(apps.splice(0).map((app) => app.close())); });

function setup(env = enabled) {
  const app = Fastify();
  apps.push(app);
  const login = registerPlatformLogin(app, loadConfig(env), { query: vi.fn() } as never);
  return { app, login };
}

describe("Agents browser login boundary", () => {
  it("limits return destinations to app paths", () => {
    expect(approvedReturnTo("/app/agents/123?tab=activity")).toBe("/app/agents/123?tab=activity");
    for (const value of ["//evil.example/app", "https://evil.example/app", "/api/auth/logout", "/app/../../outside", "/app%2f..", "http://[", "/app\\evil", undefined]) {
      expect(approvedReturnTo(value)).toBe("/app");
    }
  });
  it("requires independent complete configuration and HTTPS outside local development", () => {
    expect(() => loadConfig({ ...base, AGENTS_OIDC_ISSUER_URL: enabled.AGENTS_OIDC_ISSUER_URL })).toThrow("Agents OIDC requires");
    expect(() => loadConfig({ ...enabled, AGENTS_PUBLIC_URL: "http://remote.example" })).toThrow("HTTPS");
    expect(() => loadConfig({ ...enabled, AGENTS_PUBLIC_URL: "http://localhost:3100/app" })).toThrow("must be an origin");
  });
  it("reports unavailable login without fake authentication when not configured", async () => {
    const app = Fastify(); apps.push(app);
    registerPlatformLogin(app, loadConfig(base), {} as never);
    const response = await app.inject({ url: "/api/auth/me" });
    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("sets an opaque HttpOnly login cookie and rejects missing callback attempts", async () => {
    const { app, login } = setup();
    vi.spyOn(login!.provider, "begin").mockResolvedValue({ token: "opaque-transaction", redirectTo: "http://localhost:8080/login" });
    const response = await app.inject({ url: "/api/auth/signup?returnTo=/app" });
    expect(response.statusCode).toBe(302);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(response.headers["set-cookie"]).not.toContain("Domain=");
    const callback = await app.inject({ url: "/api/auth/callback?code=ignored" });
    expect(callback.statusCode).toBe(400);
  });
  it("rejects cross-site workspace changes before accessing a session", async () => {
    const { app, login } = setup();
    const check = vi.spyOn(login!, "requireSession");
    for (const origin of [undefined, "https://other.example"]) {
      const response = await app.inject({ method: "POST", url: "/api/auth/organization",
        headers: origin ? { origin } : {}, payload: { organizationId: "ignored" } });
      expect(response.statusCode).toBe(403);
    }
    expect(check).not.toHaveBeenCalled();
  });
  it("clears the local session even when provider logout is unavailable", async () => {
    const { app, login } = setup();
    const revoke = vi.spyOn(login!.access, "revokeSession").mockResolvedValue();
    vi.spyOn(login!.provider, "logoutUrl").mockRejectedValue(new Error("Offline"));
    const response = await app.inject({ method: "POST", url: "/api/auth/logout",
      headers: { origin: "http://localhost:3100", cookie: "agents-session=opaque-session" } });
    expect(revoke).toHaveBeenCalledWith("opaque-session");
    expect(response.json()).toEqual({ redirectTo: "/login", providerLogoutPending: true });
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
  });
});
