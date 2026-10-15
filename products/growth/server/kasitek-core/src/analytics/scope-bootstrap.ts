import type { Pool } from 'pg';
import { transaction } from '../db.js';
import { enqueueOrganizationScopeDefinition } from './index.js';
/** Repair organizations that predate transactional scope publication; never reads Analytics DB. */
export async function enqueueMissingScopeDefinitions(pool:Pool):Promise<number> {
 const organizations=(await pool.query<{id:string;createdAt:Date;reportingTimezone:string}>(`SELECT id,"createdAt" AT TIME ZONE 'UTC' AS "createdAt","reportingTimezone" FROM "Organization" ORDER BY id`)).rows;
 let queued=0;for(const organization of organizations){await transaction(pool,async tx=>{const exists=(await tx.query(`SELECT EXISTS(SELECT 1 FROM analytics_outbox WHERE source_service='core' AND record_category='scope_definition' AND scope_kind='core_organization' AND scope_external_id=$1) AS exists`,[organization.id])).rows[0].exists;
 if(!exists){await enqueueOrganizationScopeDefinition(tx,organization.id,Math.max(1,organization.createdAt.getTime()),organization.reportingTimezone,'active');queued++;}});}return queued;
}
