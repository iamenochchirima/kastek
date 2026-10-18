import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PlatformIdentity } from "./auth";
import { LoginReturnCookie } from "./auth-return";
import { PlatformError } from "./contracts";
import type { PlatformStore } from "./store";

export function registerPublicIdentityRoutes(app: FastifyInstance, options: {
  identity: Pick<PlatformIdentity, "begin" | "complete">;
  store: Pick<PlatformStore, "ensureAccount" | "createSession">;
  secure: boolean;
  sessionCookie: string;
  loginCookie: string;
  signingSecret?: string;
}) {
  const { identity, store, secure, sessionCookie, loginCookie } = options;
  const cookieOptions = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
  const returnCookie = secure ? "__Host-agents_return" : "agents_return";
  const destinations = new LoginReturnCookie(options.signingSecret ?? randomBytes(32).toString("base64url"));
  for (const signup of [false, true]) app.get(`/api/auth/${signup ? "signup" : "login"}`, async (request, reply) => {
    try {
      const login = await identity.begin({ signup });
      const destination = (request.query as Record<string, unknown>).returnTo;
      return reply.setCookie(loginCookie, login.token, { ...cookieOptions, maxAge: 600 })
        .setCookie(returnCookie, destinations.sign(login.token, destination), { ...cookieOptions, maxAge: 600 })
        .redirect(login.redirectTo);
    } catch {
      request.log.warn({ event: "identity.login.unavailable", code: "IDENTITY_UNAVAILABLE" }, "Sign-in unavailable");
      return reply.clearCookie(loginCookie, cookieOptions).clearCookie(returnCookie, cookieOptions).redirect("/login?error=unavailable");
    }
  });
  app.get("/api/auth/callback", async (request, reply) => {
    const token = request.cookies[loginCookie];
    const destination = destinations.read(request.cookies[returnCookie], token);
    reply.clearCookie(loginCookie, cookieOptions).clearCookie(returnCookie, cookieOptions);
    try {
      const claims = await identity.complete(token, request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "");
      const user = await store.ensureAccount(claims);
      const session = await store.createSession({ accountId: user.id, providerSessionId: claims.providerSessionId, expiresAt: claims.expiresAt });
      return reply.setCookie(sessionCookie, session.token, { ...cookieOptions, expires: session.expiresAt }).redirect(destination);
    } catch (error) {
      const reason = error instanceof PlatformError && error.code === "LOGIN_EXPIRED" ? "expired" :
        error instanceof PlatformError && error.code === "VERIFIED_IDENTITY_REQUIRED" ? "verification" :
        error instanceof PlatformError && error.code === "IDENTITY_UNAVAILABLE" ? "unavailable" : "failed";
      request.log.warn({ event: "identity.login.failed", code: reason }, "Sign-in failed");
      return reply.redirect(`/login?error=${reason}`);
    }
  });
}
