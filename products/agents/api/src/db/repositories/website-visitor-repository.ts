import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { query } from "../pool";
import type { WebsiteDeploymentRecord } from "./website-deployment-repository";

export interface WebsiteVisitorRecord {
  id: string;
  organization_id: string;
  deployment_id: string;
  origin: string;
  conversation_id: string | null;
  expires_at: string;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export class WebsiteVisitorRepository {
  constructor(private readonly pool: Pool) {}

  /** Read-only discovery in a server-established operator scope. */
  async findDeployment(publicId: string, origin: string): Promise<WebsiteDeploymentRecord | null> {
    return (await query<WebsiteDeploymentRecord>(this.pool,
      `SELECT deployment.* FROM agent_website_deployments deployment
       JOIN agent_installations installation ON installation.id = deployment.installation_id
       JOIN agent_definitions definition ON definition.id = installation.agent_definition_id
       WHERE deployment.public_id = $1 AND deployment.status = 'ACTIVE'
         AND installation.status = 'active' AND definition.status = 'active'
         AND definition.agent_audience = 'customer_service'
         AND deployment.allowed_origins ? $2`, [publicId, origin])).rows[0] ?? null;
  }

  async create(deployment: WebsiteDeploymentRecord, origin: string): Promise<{ session: WebsiteVisitorRecord; token: string }> {
    const id = randomUUID(), token = `kvisitor_${id}_${randomBytes(32).toString("base64url")}`;
    const session = (await query<WebsiteVisitorRecord>(this.pool,
      `INSERT INTO agent_website_visitor_sessions (id, organization_id, deployment_id, origin, secret_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, organization_id, deployment_id, origin, conversation_id, expires_at`,
      [id, deployment.organization_id, deployment.id, origin, hash(token)])).rows[0]!;
    return { session, token };
  }

  /** Validates a visitor capability without trusting request workspace/install IDs. */
  async authenticate(sessionId: string, token: string, origin: string): Promise<{ session: WebsiteVisitorRecord; deployment: WebsiteDeploymentRecord } | null> {
    if (!new RegExp(`^kvisitor_${sessionId}_[A-Za-z0-9_-]{43}$`).test(token)) return null;
    const result = await query<WebsiteVisitorRecord & { secret_hash: string; deployment: WebsiteDeploymentRecord }>(this.pool,
      `SELECT session.*, row_to_json(deployment) AS deployment FROM agent_website_visitor_sessions session
       JOIN agent_website_deployments deployment ON deployment.id = session.deployment_id
       JOIN agent_installations installation ON installation.id = deployment.installation_id
       JOIN agent_definitions definition ON definition.id = installation.agent_definition_id
       WHERE session.id = $1 AND session.origin = $2 AND session.expires_at > now()
         AND deployment.status = 'ACTIVE' AND deployment.allowed_origins ? $2
         AND installation.status = 'active' AND definition.status = 'active'`, [sessionId, origin]);
    const row = result.rows[0];
    if (!row || !timingSafeEqual(Buffer.from(row.secret_hash, "hex"), Buffer.from(hash(token), "hex"))) return null;
    const { secret_hash: _hash, deployment, ...session } = row;
    return { session, deployment };
  }

  async attachConversation(session: WebsiteVisitorRecord, conversationId: string): Promise<void> {
    const result = await query(this.pool,
      `UPDATE agent_website_visitor_sessions SET conversation_id = $3
       WHERE organization_id = $1 AND id = $2 AND (conversation_id IS NULL OR conversation_id = $3) RETURNING id`,
      [session.organization_id, session.id, conversationId]);
    if (!result.rows[0]) throw new Error("Website visitor conversation changed");
  }

  async latestRun(session: WebsiteVisitorRecord): Promise<{ id: string; status: string } | null> {
    if (!session.conversation_id) return null;
    return (await query<{ id: string; status: string }>(this.pool,
      `SELECT id, status FROM agent_runs WHERE organization_id = $1 AND conversation_id = $2
       ORDER BY created_at DESC LIMIT 1`, [session.organization_id, session.conversation_id])).rows[0] ?? null;
  }
}
