import { createHash, randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import type { Pool } from "pg";
import type { AppConfig } from "../config";
import type { PlatformAccount, PlatformSession } from "./platform-access";

const MAX_AGE_SECONDS = 30 * 86_400;
export const PROVIDER_RECHECK_MS = 5 * 60_000;
type LoginTransaction = { state: string; nonce: string; verifier: string; return_to: string };

export function approvedReturnTo(value: unknown): string {
  // No protocol-relative URLs, encoded separators, control characters or
  // destinations outside the app. Parse again rather than trusting a prefix.
  if (typeof value !== "string" || /[%\\\s]/.test(value)) return "/app";
  try {
    const url = new URL(value, "https://agents.invalid");
    if (url.origin !== "https://agents.invalid" || !(url.pathname === "/app" || url.pathname.startsWith("/app/"))) return "/app";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return "/app"; }
}

function hashToken(token: string): string | null {
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? createHash("sha256").update(token).digest("hex") : null;
}

/** Keycloak integration. Provider tokens never enter browser storage or product
 * session records. Session checks use the backend-only realm service account.
 */
export class AgentsOidc {
  private configuration?: Promise<oidc.Configuration>;
  private adminToken?: { token: string; expiresAt: number };
  readonly publicOrigin: string;
  readonly callbackUrl: string;
  readonly secureCookies: boolean;

  constructor(private readonly config: AppConfig, private readonly pool: Pool) {
    this.publicOrigin = new URL(config.AGENTS_PUBLIC_URL!).origin;
    this.callbackUrl = `${this.publicOrigin}/api/auth/callback`;
    this.secureCookies = this.publicOrigin.startsWith("https:");
  }

  private discovery(): Promise<oidc.Configuration> {
    if (!this.configuration) {
      const execute = [oidc.enableNonRepudiationChecks];
      if (!this.secureCookies) execute.push(oidc.allowInsecureRequests);
      this.configuration = oidc.discovery(new URL(this.config.AGENTS_OIDC_ISSUER_URL!),
        this.config.AGENTS_OIDC_CLIENT_ID!, this.config.AGENTS_OIDC_CLIENT_SECRET!, undefined, { execute, timeout: 10 })
        .catch(() => { this.configuration = undefined; throw Object.assign(new Error("Sign-in service unavailable"), { statusCode: 503 }); });
    }
    return this.configuration;
  }

  async begin(returnTo: unknown, signup: boolean): Promise<{ token: string; redirectTo: string }> {
    const configuration = await this.discovery();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const token = randomBytes(32).toString("base64url");
    // Bound accumulation by deleting expired attempts on each new login.
    await this.pool.query("DELETE FROM platform_login_transactions WHERE expires_at <= now()");
    await this.pool.query(
      "INSERT INTO platform_login_transactions(token_hash, state, nonce, verifier, return_to) VALUES ($1, $2, $3, $4, $5)",
      [hashToken(token), state, nonce, verifier, approvedReturnTo(returnTo)],
    );
    const redirectTo = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.callbackUrl, scope: "openid profile email", state, nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256",
      max_age: String(MAX_AGE_SECONDS), ...(signup ? { prompt: "create" } : {}),
    }).href;
    return { token, redirectTo };
  }

  async complete(transactionToken: string, callbackQuery: string): Promise<{
    identity: Omit<PlatformAccount, "id">; providerSessionId: string; authenticatedAt: Date; returnTo: string;
  }> {
    const hash = hashToken(transactionToken);
    if (!hash) throw Object.assign(new Error("Sign-in attempt expired. Please try again."), { statusCode: 400 });
    const result = await this.pool.query<LoginTransaction>(
      "DELETE FROM platform_login_transactions WHERE token_hash = $1 AND expires_at > now() RETURNING state, nonce, verifier, return_to",
      [hash],
    );
    const transaction = result.rows[0];
    if (!transaction) throw Object.assign(new Error("Sign-in attempt expired. Please try again."), { statusCode: 400 });
    const configuration = await this.discovery();
    let tokens;
    try {
      tokens = await oidc.authorizationCodeGrant(configuration, new URL(`${this.callbackUrl}${callbackQuery}`), {
        pkceCodeVerifier: transaction.verifier, expectedState: transaction.state,
        expectedNonce: transaction.nonce, idTokenExpected: true, maxAge: MAX_AGE_SECONDS,
      });
    } catch {
      throw Object.assign(new Error("Sign-in could not be completed. Please try again."), { statusCode: 401 });
    }
    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== "string" || typeof claims.sid !== "string" || typeof claims.auth_time !== "number"
      || typeof claims.email !== "string" || claims.email_verified !== true) {
      throw Object.assign(new Error("A verified account is required"), { statusCode: 403 });
    }
    return {
      identity: { issuer: this.config.AGENTS_OIDC_ISSUER_URL!, subject: claims.sub, email: claims.email,
        display_name: typeof claims.name === "string" && claims.name.trim() ? claims.name : claims.email,
        image: typeof claims.picture === "string" ? claims.picture : "", email_verified: true },
      providerSessionId: claims.sid, authenticatedAt: new Date(claims.auth_time * 1000), returnTo: transaction.return_to,
    };
  }

  async logoutUrl(): Promise<string> {
    return oidc.buildEndSessionUrl(await this.discovery(), {
      client_id: this.config.AGENTS_OIDC_CLIENT_ID!, post_logout_redirect_uri: `${this.publicOrigin}/login`,
    }).href;
  }

  private async realmToken(): Promise<string> {
    if (this.adminToken && this.adminToken.expiresAt > Date.now()) return this.adminToken.token;
    const endpoint = (await this.discovery()).serverMetadata().token_endpoint;
    if (!endpoint) throw Object.assign(new Error("Sign-in service unavailable"), { statusCode: 503 });
    try {
      const response = await fetch(endpoint, { method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.config.AGENTS_OIDC_ADMIN_CLIENT_ID!,
          client_secret: this.config.AGENTS_OIDC_ADMIN_CLIENT_SECRET! }) });
      if (!response.ok) throw new Error("Service token unavailable");
      const value = await response.json() as { access_token?: unknown; expires_in?: unknown };
      if (typeof value.access_token !== "string" || typeof value.expires_in !== "number" || value.expires_in <= 0) throw new Error("Invalid service token");
      this.adminToken = { token: value.access_token, expiresAt: Date.now() + Math.max(0, value.expires_in - 15) * 1000 };
      return value.access_token;
    } catch { throw Object.assign(new Error("Sign-in service unavailable"), { statusCode: 503 }); }
  }

  private async adminRequest(subject: string, suffix = "", method = "GET"): Promise<Response> {
    // This module deliberately supports our selected Keycloak provider only.
    const issuer = new URL(this.config.AGENTS_OIDC_ISSUER_URL!);
    const marker = issuer.pathname.lastIndexOf("/realms/");
    if (marker < 0) throw new Error("Keycloak realm issuer required");
    const endpoint = new URL(`${issuer.pathname.slice(0, marker)}/admin${issuer.pathname.slice(marker)}/users/${encodeURIComponent(subject)}${suffix}`, issuer.origin);
    try {
      const response = await fetch(endpoint, { method, signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${await this.realmToken()}` } });
      if (response.status === 401) this.adminToken = undefined;
      if (!response.ok && response.status !== 404) throw new Error("Provider check failed");
      return response;
    } catch { throw Object.assign(new Error("Sign-in service unavailable"), { statusCode: 503 }); }
  }

  async sessionIsActive(session: PlatformSession): Promise<boolean> {
    if (session.account.issuer !== this.config.AGENTS_OIDC_ISSUER_URL) return false;
    const response = await this.adminRequest(session.account.subject);
    if (response.status === 404) return false;
    const account = await response.json() as { enabled?: boolean; emailVerified?: boolean };
    if (account.enabled !== true || account.emailVerified !== true) return false;
    const sessionsResponse = await this.adminRequest(session.account.subject, "/sessions");
    if (sessionsResponse.status === 404) return false;
    const sessions = await sessionsResponse.json() as { id?: string }[];
    return Array.isArray(sessions) && sessions.some((providerSession) => providerSession.id === session.providerSessionId);
  }

  async logoutEverywhere(subject: string): Promise<void> {
    await this.adminRequest(subject, "/logout", "POST");
  }
}
