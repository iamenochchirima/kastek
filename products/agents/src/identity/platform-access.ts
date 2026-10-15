import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { withTransaction } from "../db/pool";

const IDLE_DAYS = 7;
const ABSOLUTE_DAYS = 30;
const DAY_MS = 86_400_000;

export type PlatformRole = "owner" | "admin" | "member" | "viewer";
export interface PlatformAccount {
  id: string;
  issuer: string;
  subject: string;
  email: string;
  display_name: string;
  image: string;
  email_verified: boolean;
}
export interface PlatformOrganization { id: string; name: string; role: PlatformRole }
export interface PlatformSession {
  account: PlatformAccount;
  organizations: PlatformOrganization[];
  activeOrganizationId: string | null;
  providerSessionId: string;
  providerCheckedAt: Date;
  absoluteExpiresAt: Date;
}

function tokenHash(token: string): string | null {
  // Do not query for arbitrary malformed browser input or retain raw tokens.
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return createHash("sha256").update(token).digest("hex");
}

function requiredText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

/** Only call recordIdentity/createSession after server-side OIDC validation.
 * No email-based linking, browser-supplied account IDs or automatic membership.
 */
export class PlatformAccessRepository {
  constructor(private readonly pool: Pool) {}

  async recordIdentity(identity: Omit<PlatformAccount, "id">): Promise<PlatformAccount> {
    const result = await this.pool.query<PlatformAccount>(
      `INSERT INTO platform_accounts (issuer, subject, email, display_name, image, email_verified)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (issuer, subject) DO UPDATE SET
         email = EXCLUDED.email, display_name = EXCLUDED.display_name,
         image = EXCLUDED.image, email_verified = EXCLUDED.email_verified, updated_at = now()
       WHERE platform_accounts.disabled_at IS NULL
       RETURNING id, issuer, subject, email, display_name, image, email_verified`,
      [requiredText(identity.issuer, "Issuer"), requiredText(identity.subject, "Subject"),
        requiredText(identity.email, "Email"), requiredText(identity.display_name, "Name"),
        identity.image, identity.email_verified],
    );
    if (!result.rows[0]) throw Object.assign(new Error("Account unavailable"), { statusCode: 403 });
    return result.rows[0];
  }

  async createOrganization(accountId: string, name: string): Promise<PlatformOrganization> {
    const normalizedName = requiredText(name, "Organization name");
    if (normalizedName.length > 120) throw Object.assign(new Error("Organization name is too long"), { statusCode: 400 });
    return withTransaction(this.pool, async (client) => {
      const account = await client.query(
        "SELECT id FROM platform_accounts WHERE id = $1 AND disabled_at IS NULL AND email_verified = true FOR UPDATE",
        [accountId],
      );
      if (!account.rows[0]) throw Object.assign(new Error("Verified account required"), { statusCode: 403 });
      const organization = await client.query<{ id: string; name: string }>(
        "INSERT INTO platform_organizations(name, created_by) VALUES ($1, $2) RETURNING id, name",
        [normalizedName, accountId],
      );
      const row = organization.rows[0]!;
      await client.query(
        "INSERT INTO platform_memberships(organization_id, account_id, role) VALUES ($1, $2, 'owner')",
        [row.id, accountId],
      );
      return { ...row, role: "owner" };
    });
  }

  async createSession(input: { accountId: string; providerSessionId: string; authenticatedAt: Date }): Promise<{ token: string; expiresAt: Date }> {
    const now = new Date();
    const authTime = input.authenticatedAt.getTime();
    // Absolute deadline follows provider authentication, not cookie issuance.
    if (!Number.isFinite(authTime) || authTime > now.getTime() + 60_000 || authTime + ABSOLUTE_DAYS * DAY_MS <= now.getTime()) {
      throw Object.assign(new Error("Fresh authentication required"), { statusCode: 401 });
    }
    const expiresAt = new Date(authTime + ABSOLUTE_DAYS * DAY_MS);
    const token = randomBytes(32).toString("base64url");
    const result = await this.pool.query(
      `INSERT INTO platform_browser_sessions
         (token_hash, account_id, provider_session_id, authenticated_at, absolute_expires_at)
       SELECT $1, id, $3, $4, $5 FROM platform_accounts
       WHERE id = $2 AND disabled_at IS NULL AND email_verified = true RETURNING token_hash`,
      [tokenHash(token), input.accountId, requiredText(input.providerSessionId, "Provider session"), input.authenticatedAt, expiresAt],
    );
    if (!result.rows[0]) throw Object.assign(new Error("Verified account required"), { statusCode: 403 });
    return { token, expiresAt };
  }

  async readSession(token: string, options: { touch?: boolean } = {}): Promise<PlatformSession | null> {
    const hash = tokenHash(token);
    if (!hash) return null;
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<PlatformAccount & {
        active_organization_id: string | null; provider_session_id: string;
        provider_checked_at: Date; absolute_expires_at: Date;
      }>(
        `SELECT a.id, a.issuer, a.subject, a.email, a.display_name, a.image, a.email_verified,
                s.active_organization_id, s.provider_session_id, s.provider_checked_at, s.absolute_expires_at
         FROM platform_browser_sessions s JOIN platform_accounts a ON a.id = s.account_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND a.disabled_at IS NULL
           AND a.email_verified = true AND s.absolute_expires_at > now()
           AND s.last_seen_at > now() - make_interval(days => $2)
         FOR UPDATE OF s`,
        [hash, IDLE_DAYS],
      );
      const row = result.rows[0];
      if (!row) return null;
      const memberships = await client.query<PlatformOrganization>(
        `SELECT o.id, o.name, m.role FROM platform_memberships m
         JOIN platform_organizations o ON o.id = m.organization_id
         WHERE m.account_id = $1 AND m.revoked_at IS NULL ORDER BY o.created_at, o.id`,
        [row.id],
      );
      // Membership removal takes effect on the next request without a new login.
      const activeOrganizationId = memberships.rows.some((org) => org.id === row.active_organization_id)
        ? row.active_organization_id : null;
      if (options.touch) await client.query("UPDATE platform_browser_sessions SET last_seen_at = now() WHERE token_hash = $1", [hash]);
      const { active_organization_id, provider_session_id, provider_checked_at, absolute_expires_at, ...account } = row;
      return { account, organizations: memberships.rows, activeOrganizationId,
        providerSessionId: provider_session_id, providerCheckedAt: provider_checked_at, absoluteExpiresAt: absolute_expires_at };
    });
  }

  async selectOrganization(token: string, organizationId: string): Promise<boolean> {
    const hash = tokenHash(token);
    if (!hash) return false;
    const result = await this.pool.query(
      `UPDATE platform_browser_sessions s SET active_organization_id = m.organization_id
       FROM platform_memberships m, platform_accounts a
       WHERE s.token_hash = $1 AND m.organization_id = $2 AND m.account_id = s.account_id
         AND a.id = s.account_id AND a.disabled_at IS NULL AND a.email_verified = true
         AND m.revoked_at IS NULL AND s.revoked_at IS NULL AND s.absolute_expires_at > now()
         AND s.last_seen_at > now() - make_interval(days => $3)
       RETURNING s.token_hash`,
      [hash, organizationId, IDLE_DAYS],
    );
    return Boolean(result.rows[0]);
  }

  async revokeSession(token: string): Promise<void> {
    const hash = tokenHash(token);
    if (hash) await this.pool.query("UPDATE platform_browser_sessions SET revoked_at = now() WHERE token_hash = $1", [hash]);
  }

  async markProviderChecked(token: string): Promise<void> {
    const hash = tokenHash(token);
    if (hash) await this.pool.query(
      "UPDATE platform_browser_sessions SET provider_checked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
      [hash],
    );
  }

  async revokeAccountSessions(accountId: string): Promise<void> {
    await this.pool.query("UPDATE platform_browser_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL", [accountId]);
  }

  async revokeProviderSession(issuer: string, providerSessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE platform_browser_sessions s SET revoked_at = now() FROM platform_accounts a
       WHERE s.account_id = a.id AND a.issuer = $1 AND s.provider_session_id = $2 AND s.revoked_at IS NULL`,
      [issuer, providerSessionId],
    );
  }
}
