import type { PoolClient } from 'pg';
import { internal } from './error.js';
import * as analytics from './analytics.js';

export type WorkspaceBaseInput = {
  id: string;
  slug: string;
  name: string;
  reportingTimezone: string;
  primaryColor: string | null;
  secondaryColor?: string | null;
  customDomain?: string | null;
  createdAt: Date;
};

/** Insert the shared workspace, branding, safe limits and analytics records inside the caller's transaction. */
export async function createWorkspaceBase(
  tx: PoolClient,
  input: WorkspaceBaseInput,
  options: { ignoreSlugConflict?: boolean } = {},
): Promise<boolean> {
  const conflictClause = options.ignoreSlugConflict
    ? ' ON CONFLICT (slug) DO NOTHING'
    : '';
  const workspace = await tx.query(
    `INSERT INTO workspaces(id,slug,display_name,status,reporting_timezone,created_at,updated_at)
     VALUES($1,$2,$3,'active',$4,NOW(),NOW())${conflictClause} RETURNING id`,
    [input.id, input.slug, input.name, input.reportingTimezone],
  );
  if (!workspace.rows[0]) return false;

  await tx.query(
    `INSERT INTO workspace_branding(workspace_id,display_name,primary_color,secondary_color,custom_domain,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,NOW(),NOW())`,
    [
      input.id,
      input.name,
      input.primaryColor,
      input.secondaryColor ?? null,
      input.customDomain ?? null,
    ],
  );
  await tx.query(
    `INSERT INTO workspace_usage_limits(workspace_id,requests_per_month,tokens_per_month,conversations_per_month,created_at,updated_at)
     VALUES($1,0,0,0,NOW(),NOW())`,
    [input.id],
  );

  try {
    await analytics.enqueueWorkspaceScopeDefinition(
      tx,
      input.id,
      input.createdAt.getTime(),
      input.reportingTimezone,
    );
  } catch (error) {
    throw internal(`analytics workspace scope enqueue failed: ${error}`);
  }
  try {
    await analytics.enqueueScopeManifest(tx, input.id, 1n, input.createdAt);
  } catch (error) {
    throw internal(`analytics workspace manifest enqueue failed: ${error}`);
  }
  return true;
}
