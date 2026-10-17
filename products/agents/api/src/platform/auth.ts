import { createHash, randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Pool } from "pg";
import type { PlatformConfig } from "./config";
import { PlatformError } from "./contracts";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const validToken = (token: unknown): token is string => typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);

export class PlatformIdentity {
  private configuration?: Promise<oidc.Configuration>;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  readonly origin: string;
  readonly callbackUrl: string;

  constructor(private readonly config: PlatformConfig, private readonly pool: Pool) {
    this.origin = new URL(config.AGENTS_PUBLIC_URL).origin;
    this.callbackUrl = `${this.origin}/api/auth/callback`;
  }

  private discovery(): Promise<oidc.Configuration> {
    if (!this.configuration) {
      this.configuration = oidc.discovery(
        new URL(this.config.AGENTS_OIDC_ISSUER_URL), this.config.AGENTS_OIDC_CLIENT_ID,
        this.config.AGENTS_OIDC_CLIENT_SECRET, undefined,
        this.config.NODE_ENV !== "production" ? { execute: [oidc.allowInsecureRequests] } : undefined,
      ).then((configuration) => {
        oidc.enableNonRepudiationChecks(configuration);
        return configuration;
      }).catch(() => { this.configuration = undefined; throw new PlatformError("IDENTITY_UNAVAILABLE", 503, "Sign-in is unavailable"); });
    }
    return this.configuration;
  }

  async begin(): Promise<{ token: string; redirectTo: string }> {
    const configuration = await this.discovery();
    const token = randomBytes(32).toString("base64url");
    const state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
    await this.pool.query("DELETE FROM agents_platform.login_transactions WHERE expires_at <= now()");
    await this.pool.query(
      "INSERT INTO agents_platform.login_transactions(token_hash,state,nonce,verifier) VALUES ($1,$2,$3,$4)",
      [hash(token), state, nonce, verifier],
    );
    return {
      token,
      redirectTo: oidc.buildAuthorizationUrl(configuration, {
        redirect_uri: this.callbackUrl, scope: "openid profile email", state, nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", max_age: "2592000",
      }).href,
    };
  }

  async complete(token: unknown, callbackQuery: string) {
    if (!validToken(token)) throw new PlatformError("LOGIN_EXPIRED", 400, "Sign-in attempt expired");
    const result = await this.pool.query<{ state: string; nonce: string; verifier: string }>(
      "DELETE FROM agents_platform.login_transactions WHERE token_hash=$1 AND expires_at>now() RETURNING state,nonce,verifier",
      [hash(token)],
    );
    const transaction = result.rows[0];
    if (!transaction) throw new PlatformError("LOGIN_EXPIRED", 400, "Sign-in attempt expired");
    const configuration = await this.discovery();
    let tokens;
    try {
      tokens = await oidc.authorizationCodeGrant(configuration, new URL(`${this.callbackUrl}${callbackQuery}`), {
        pkceCodeVerifier: transaction.verifier, expectedState: transaction.state,
        expectedNonce: transaction.nonce, idTokenExpected: true, maxAge: 2_592_000,
      });
    } catch { throw new PlatformError("LOGIN_FAILED", 401, "Sign-in could not be completed"); }
    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== "string" || typeof claims.sid !== "string" ||
        typeof claims.auth_time !== "number" || typeof claims.email !== "string" || claims.email_verified !== true) {
      throw new PlatformError("VERIFIED_IDENTITY_REQUIRED", 403, "A verified account is required");
    }
    return {
      issuer: this.config.AGENTS_OIDC_ISSUER_URL, subject: claims.sub, email: claims.email,
      displayName: typeof claims.name === "string" && claims.name.trim() ? claims.name : claims.email,
      providerSessionId: claims.sid,
      expiresAt: new Date(Math.min(Date.now() + 30 * 86_400_000, claims.auth_time * 1000 + 30 * 86_400_000)),
    };
  }

  async logoutUrl(): Promise<string> {
    return oidc.buildEndSessionUrl(await this.discovery(), {
      client_id: this.config.AGENTS_OIDC_CLIENT_ID, post_logout_redirect_uri: `${this.origin}/login`,
    }).href;
  }

  async backchannelLogout(token: string): Promise<void> {
    const configuration = await this.discovery();
    const jwksUri = configuration.serverMetadata().jwks_uri;
    if (!jwksUri) throw new PlatformError("IDENTITY_UNAVAILABLE", 503, "Sign-in is unavailable");
    this.jwks ??= createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: 5_000 });
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.AGENTS_OIDC_ISSUER_URL, audience: this.config.AGENTS_OIDC_CLIENT_ID,
        algorithms: ["RS256"], maxTokenAge: "2 minutes", clockTolerance: 5,
      }));
    } catch { throw new PlatformError("INVALID_LOGOUT", 400, "Invalid logout notification"); }
    const event = (payload.events as Record<string, unknown> | undefined)?.["http://schemas.openid.net/event/backchannel-logout"];
    if (!event || typeof event !== "object" || Array.isArray(event) || payload.nonce !== undefined ||
        typeof payload.jti !== "string" || payload.jti.length > 256 ||
        (typeof payload.sid !== "string" && typeof payload.sub !== "string")) {
      throw new PlatformError("INVALID_LOGOUT", 400, "Invalid logout notification");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM agents_platform.logout_tokens WHERE expires_at<=now()");
      const inserted = await client.query(
        "INSERT INTO agents_platform.logout_tokens(jti,expires_at) VALUES ($1,now()+interval '5 minutes') ON CONFLICT DO NOTHING RETURNING jti", [payload.jti],
      );
      if (inserted.rowCount) {
        await client.query(`UPDATE agents_platform.sessions s SET revoked_at=now() FROM agents_platform.accounts a
          WHERE s.account_id=a.id AND a.issuer=$1 AND s.revoked_at IS NULL
          AND ($2::text IS NULL OR s.provider_session_id=$2) AND ($3::text IS NULL OR a.subject=$3)`,
        [this.config.AGENTS_OIDC_ISSUER_URL, typeof payload.sid === "string" ? payload.sid : null, typeof payload.sub === "string" ? payload.sub : null]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
