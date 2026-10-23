import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
export const adminFixtureToken = (id: string) => createHash('sha256').update(`isolated-admin-fixture:${id}`).digest('base64url');
export const adminFixtureHeaders = (id: string) => ({cookie: `kasitek_admin_session=${adminFixtureToken(id)}`, origin:'http://localhost:3001'});
export async function seedAdminFixtureSessions(pool: Pool) {
 await pool.query('CREATE TABLE IF NOT EXISTS "AdminSession" ("tokenHash" TEXT PRIMARY KEY,"adminId" TEXT NOT NULL,"createdAt" TIMESTAMP DEFAULT NOW(),"expiresAt" TIMESTAMP NOT NULL,"revokedAt" TIMESTAMP)');
 for(const {id} of (await pool.query<{id:string}>('SELECT id FROM "AdminUser"')).rows){
  const token=adminFixtureToken(id), hash=createHash('sha256').update(token).digest('hex');
  await pool.query('INSERT INTO "AdminSession" ("tokenHash","adminId","expiresAt") VALUES ($1,$2,NOW()+INTERVAL \'1 hour\') ON CONFLICT DO NOTHING',[hash,id]);
 }
}
