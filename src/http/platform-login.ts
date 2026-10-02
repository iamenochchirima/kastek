import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import type { AppConfig } from "../config";
import { AgentsOidc, PROVIDER_RECHECK_MS } from "../identity/oidc";
import { PlatformAccessRepository, type PlatformSession } from "../identity/platform-access";

export function requireSameOrigin(request: Pick<FastifyRequest, "headers">, origin: string): void {
  if (request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site") {
    throw Object.assign(new Error("Request origin denied"), { statusCode: 403 });
  }
}

export class PlatformLogin {
  readonly access: PlatformAccessRepository;
  readonly provider: AgentsOidc;
  readonly sessionCookie: string;
  readonly transactionCookie: string;

  constructor(config: AppConfig, pool: Pool) {
    this.access = new PlatformAccessRepository(pool);
    this.provider = new AgentsOidc(config, pool);
    this.sessionCookie = this.provider.secureCookies ? "__Host-agents-session" : "agents-session";
    this.transactionCookie = this.provider.secureCookies ? "__Host-agents-login" : "agents-login";
  }

  private cookieOptions() {
    return { httpOnly: true, secure: this.provider.secureCookies, sameSite: "lax" as const, path: "/" };
  }

  clearSession(reply: FastifyReply): void { reply.clearCookie(this.sessionCookie, this.cookieOptions()); }

  async requireSession(request: FastifyRequest, touch = false): Promise<PlatformSession> {
    const token = request.cookies[this.sessionCookie] ?? "";
    let session = await this.access.readSession(token);
    if (!session) throw Object.assign(new Error("Sign-in required"), { statusCode: 401 });
    if (Date.now() - session.providerCheckedAt.getTime() >= PROVIDER_RECHECK_MS) {
      if (!await this.provider.sessionIsActive(session)) {
        await this.access.revokeSession(token);
        throw Object.assign(new Error("Sign-in required"), { statusCode: 401 });
      }
      await this.access.markProviderChecked(token);
    }
    // Re-read after provider I/O so concurrent local revocation takes effect.
    session = await this.access.readSession(token, { touch });
    if (!session) throw Object.assign(new Error("Sign-in required"), { statusCode: 401 });
    return session;
  }

  register(app: FastifyInstance): void {
    app.addHook("onRequest", async (request, reply) => {
      if (request.url.startsWith("/api/auth/")) reply.header("cache-control", "no-store");
    });
    for (const mode of ["login", "signup"] as const) {
      app.get(`/api/auth/${mode}`, async (request, reply) => {
        const query = request.query as { returnTo?: string };
        const flow = await this.provider.begin(query.returnTo, mode === "signup");
        reply.setCookie(this.transactionCookie, flow.token, { ...this.cookieOptions(), maxAge: 600 });
        return reply.redirect(flow.redirectTo);
      });
    }
    app.get("/api/auth/callback", async (request, reply) => {
      const transactionToken = request.cookies[this.transactionCookie] ?? "";
      reply.clearCookie(this.transactionCookie, this.cookieOptions());
      const queryOffset = request.url.indexOf("?");
      const completed = await this.provider.complete(transactionToken, queryOffset >= 0 ? request.url.slice(queryOffset) : "");
      const account = await this.access.recordIdentity(completed.identity);
      const session = await this.access.createSession({ accountId: account.id,
        providerSessionId: completed.providerSessionId, authenticatedAt: completed.authenticatedAt });
      // Rotate away any prior product browser session after successful login.
      await this.access.revokeSession(request.cookies[this.sessionCookie] ?? "");
      const current = await this.access.readSession(session.token);
      if (current?.organizations.length === 1) await this.access.selectOrganization(session.token, current.organizations[0]!.id);
      reply.setCookie(this.sessionCookie, session.token, { ...this.cookieOptions(),
        maxAge: Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)) });
      return reply.redirect(completed.returnTo);
    });
    app.get("/api/auth/me", async (request) => {
      const session = await this.requireSession(request);
      return { user: { id: session.account.id, name: session.account.display_name,
        email: session.account.email, image: session.account.image, emailVerified: "verified" },
      organizations: session.organizations, activeOrganizationId: session.activeOrganizationId };
    });
    app.post("/api/auth/activity", async (request) => {
      requireSameOrigin(request, this.provider.publicOrigin);
      await this.requireSession(request, true);
      return { ok: true };
    });
    app.post("/api/auth/organizations", async (request, reply) => {
      requireSameOrigin(request, this.provider.publicOrigin);
      const session = await this.requireSession(request, true);
      const input = z.object({ name: z.string().trim().min(1).max(120) }).parse(request.body);
      const organization = await this.access.createOrganization(session.account.id, input.name);
      if (!await this.access.selectOrganization(request.cookies[this.sessionCookie]!, organization.id)) {
        throw Object.assign(new Error("Session expired"), { statusCode: 401 });
      }
      return reply.code(201).send(organization);
    });
    app.post("/api/auth/organization", async (request) => {
      requireSameOrigin(request, this.provider.publicOrigin);
      await this.requireSession(request, true);
      const input = z.object({ organizationId: z.string().uuid() }).parse(request.body);
      if (!await this.access.selectOrganization(request.cookies[this.sessionCookie]!, input.organizationId)) {
        throw Object.assign(new Error("Workspace access denied"), { statusCode: 403 });
      }
      return { ok: true };
    });
    app.post("/api/auth/logout", async (request, reply) => {
      requireSameOrigin(request, this.provider.publicOrigin);
      await this.access.revokeSession(request.cookies[this.sessionCookie] ?? "");
      this.clearSession(reply);
      try { return { redirectTo: await this.provider.logoutUrl(), providerLogoutPending: false }; }
      catch { return { redirectTo: "/login", providerLogoutPending: true }; }
    });
    app.post("/api/auth/logout-all", async (request, reply) => {
      requireSameOrigin(request, this.provider.publicOrigin);
      const session = await this.requireSession(request);
      // Always revoke local cookies, even if provider revocation must be retried.
      await this.access.revokeAccountSessions(session.account.id);
      this.clearSession(reply);
      try {
        await this.provider.logoutEverywhere(session.account.subject);
        return { redirectTo: "/login", providerLogoutPending: false };
      } catch {
        return { redirectTo: "/login", providerLogoutPending: true };
      }
    });
  }
}

export function registerPlatformLogin(app: FastifyInstance, config: AppConfig, pool: Pool): PlatformLogin | undefined {
  const login = config.AGENTS_OIDC_ISSUER_URL ? new PlatformLogin(config, pool) : undefined;
  app.register(async (authApp) => {
    await authApp.register(cookie);
    if (login) login.register(authApp);
    else authApp.all("/api/auth/*", async (_request, reply) => reply.code(503)
      .header("cache-control", "no-store").send({ message: "Sign-in is not configured yet" }));
  });
  return login;
}
