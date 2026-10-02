import { dtoSchema } from './auth.js';
const SQL = [
  '\n        SELECT\n            i.id AS invite_id,\n            i.tenant_user_id,\n            i.email,\n            u.name,\n            i.workspace_id,\n            w.display_name AS workspace_display_name,\n            w.slug AS workspace_slug,\n            i.expires_at AS expires_at,\n            i.accepted_at AS accepted_at,\n            i.revoked_at AS revoked_at\n        FROM tenant_user_invites i\n        JOIN tenant_users u ON u.id = i.tenant_user_id\n        JOIN workspaces w ON w.id = i.workspace_id\n        WHERE i.token_hash = $1\n        LIMIT 1\n        ',
  '\n        UPDATE tenant_user_invites\n        SET revoked_at = NOW(), updated_at = NOW()\n        WHERE tenant_user_id = $1\n          AND accepted_at IS NULL\n          AND revoked_at IS NULL\n        ',
  '\n        INSERT INTO tenant_user_invites (\n            id,\n            workspace_id,\n            tenant_user_id,\n            email,\n            token_hash,\n            expires_at,\n            created_at,\n            updated_at\n        )\n        VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())\n        ',
  "\n        UPDATE tenant_users\n        SET password_hash = $1,\n            name = COALESCE($2, name),\n            status = 'active',\n            updated_at = NOW()\n        WHERE id = $3\n        ",
  '\n        UPDATE tenant_user_invites\n        SET accepted_at = NOW(),\n            updated_at = NOW()\n        WHERE id = $1\n        ',
  '\n        INSERT INTO tenant_sessions (\n            id,\n            workspace_id,\n            tenant_user_id,\n            token_hash,\n            expires_at,\n            ip_address,\n            user_agent,\n            last_used_at,\n            created_at,\n            updated_at\n        )\n        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), NOW())\n        ',
  '\n        UPDATE tenant_users\n        SET last_login_at = NOW(), updated_at = NOW()\n        WHERE id = $1\n        ',
  '\n        SELECT role\n        FROM tenant_user_roles\n        WHERE tenant_user_id = $1\n        ORDER BY role ASC\n        ',
] as const;
import type { FastifyInstance } from 'fastify';
import type { TenantContext } from '../context.js';
import { transaction } from '../db.js';
import { bad, missing, internal } from '../error.js';
import { tokenHash } from '../middleware.js';
import { workspacePortalUrl, sendTenantAdminInviteEmail } from '../mail.js';
import { createId } from '@paralleldrive/cuid2';
import {
  newToken,
  bodyText,
  hashPassword,
  insertTenantSession,
  tenantRoles,
  buildSessionCookie,
} from './auth.js';
export interface IssuedAdminInvite {
  activation_url: string | null;
  portal_url: string | null;
  email_sent: boolean;
  expires_at: Date;
}
export async function issueAdminInvite(
  context: TenantContext,
  workspace: string,
  slug: string,
  name: string,
  userId: string,
  email: string,
): Promise<IssuedAdminInvite> {
  await context.pool.query(SQL[1], [userId]);
  const id = createId(),
    token = newToken(),
    expires_at = new Date(
      Date.now() + context.config.invite_ttl_hours * 3600000,
    ),
    portal_url = workspacePortalUrl(context, slug),
    activation_url = portal_url
      ? `${portal_url.replace(/\/+$/, '')}/setup?token=${token}`
      : null;
  await context.pool.query(SQL[2], [
    id,
    workspace,
    userId,
    email,
    tokenHash(token),
    expires_at,
  ]);
  const email_sent = activation_url
    ? await sendTenantAdminInviteEmail(
        context,
        email,
        name,
        activation_url,
        portal_url,
        expires_at,
      )
    : false;
  return { activation_url, portal_url, email_sent, expires_at };
}
export function registerAdminInvitesRoutes(
  app: FastifyInstance,
  context: TenantContext,
): void {
  app.get(
    '/api/auth/admin-invite',
    { schema: { querystring: dtoSchema(['token']) } },
    async (request) => {
      const token = bodyText(request.query, 'token').trim();
      if (!token) throw bad('token is required');
      const i = (await context.pool.query(SQL[0], [tokenHash(token)])).rows[0];
      if (!i) throw missing('invite not found');
      return {
        invite: {
          email: i.email,
          name: i.name,
          workspaceDisplayName: i.workspace_display_name,
          workspaceSlug: i.workspace_slug,
          isValid: !i.accepted_at && !i.revoked_at && i.expires_at > new Date(),
          expiresAt: i.expires_at,
        },
      };
    },
  );
  app.post(
    '/api/auth/accept-admin-invite',
    { schema: { body: dtoSchema(['token', 'password'], ['name']) } },
    async (request, reply) => {
      const token = bodyText(request.body, 'token').trim(),
        password = bodyText(request.body, 'password').trim();
      if (!token || !password) throw bad('token and password are required');
      if (Buffer.byteLength(password) < 8)
        throw bad('password must be at least 8 characters');
      const i = (await context.pool.query(SQL[0], [tokenHash(token)])).rows[0];
      if (!i) throw missing('invite not found');
      if (i.accepted_at || i.revoked_at || i.expires_at <= new Date())
        throw bad('This invite is no longer valid');
      const input = request.body as { name?: unknown };
      if (input.name != null && typeof input.name !== 'string')
        throw bad('invalid name');
      const name =
        (typeof input.name === 'string' ? input.name.trim() : null) || null;
      let hash: string;
      try {
        hash = await hashPassword(password);
      } catch (e) {
        throw internal(`password hash failed: ${(e as Error).message}`);
      }
      const session = newToken();
      const roles = await transaction(context.pool, async (tx) => {
        await tx.query(SQL[3], [hash, name, i.tenant_user_id]);
        await tx.query(SQL[4], [i.invite_id]);
        await insertTenantSession(
          tx,
          context,
          request,
          i.workspace_id,
          i.tenant_user_id,
          session,
        );
        await tx.query(SQL[6], [i.tenant_user_id]);
        return tenantRoles(tx, i.tenant_user_id);
      });
      buildSessionCookie(reply, context.config, session);
      return {
        user: {
          id: i.tenant_user_id,
          workspaceId: i.workspace_id,
          workspaceSlug: i.workspace_slug,
          email: i.email,
          name: name ?? i.name,
          roles,
        },
      };
    },
  );
}
