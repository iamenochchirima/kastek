import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import pg from 'pg';
import { createServer } from 'node:http';
import { readConfig } from '../src/config.js';
import { slugify,createOrg,createInvitation,acceptInvitation,revokeInvitation,requireAdmin,removeMember,getInvitationByToken } from '../src/services/orgs.js';
import { validateLogo } from '../src/services/org-support.js';
test('organization names, trial settings and image trust boundary retain Rust behavior',()=>{
 assert.equal(slugify('  Café + SALES  '),'café-sales');assert.equal(slugify('😀'), '');assert.equal([...slugify('a'.repeat(80))].length,48);
 assert.throws(()=>validateLogo(Buffer.from('not an image'),'image/png'));
 assert.throws(()=>validateLogo(Buffer.from('<svg>'),'image/svg+xml'));
 validateLogo(Buffer.from([137,80,78,71,13,10,26,10,0]),'image/png');
});
test('synthetic PostgreSQL: organization lifecycle, trial idempotency and atomic invitation denial/accept/revoke', {skip:!process.env.CORE_ORGS_TEST_DATABASE_URL},async()=>{
 const url=process.env.CORE_ORGS_TEST_DATABASE_URL!;const schema=`orgs_test_${randomUUID().replaceAll('-','')}`;const admin=new pg.Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`);
 const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema} -c timezone=UTC`});
 try{
 await pool.query(`CREATE TYPE "OrgRole" AS ENUM('OWNER','ADMIN','MEMBER');
 CREATE TABLE "User"(id text PRIMARY KEY,name text,email text,image text,"emailVerified" timestamp);
 CREATE TABLE "Organization"(id text PRIMARY KEY,name text,slug text UNIQUE,logo text,"ownerId" text,"reportingTimezone" text,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "OrganizationMember"(id text PRIMARY KEY,"orgId" text,"userId" text,role "OrgRole","joinedAt" timestamp,"createdAt" timestamp,"updatedAt" timestamp,UNIQUE("orgId","userId"));
 CREATE TABLE "OrganizationInvitation"(id text PRIMARY KEY,"orgId" text,email text,role "OrgRole","tokenHash" text,"invitedById" text,"expiresAt" timestamp,"acceptedAt" timestamp,"revokedAt" timestamp,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE analytics_outbox(outbox_id text PRIMARY KEY,source_service text,source_domain text,source_stream_key text,record_category text,record_id text,contract_name text,schema_version integer,scope_kind text,scope_external_id text,idempotency_key text,envelope jsonb,payload_hash text,source_sequence bigserial,UNIQUE(source_service,record_category,record_id));`);
 await pool.query(await readFile(new URL('../../database/prisma/migrations/20261023170000_growth_agent_setup/migration.sql',import.meta.url),'utf8'));
 await pool.query('INSERT INTO "User"(id,name,email,"emailVerified") VALUES(\'owner\',\'Owner\',\'owner@example.test\',NOW()),(\'guest\',\'Guest\',\'guest@example.test\',NOW()),(\'wrong\',\'Wrong\',\'wrong@example.test\',NOW())');
 const context={pool,config:readConfig({DATABASE_URL:url})};const org=await createOrg(context,'owner','Synthetic organization','synthetic-org',null);
 assert.equal((await pool.query('SELECT count(*) FROM "GrowthAgentSetup" WHERE "orgId"=$1',[org.id])).rows[0].count,'1');
 assert.equal(org.ownerId,'owner');assert.equal(org.reportingTimezone,'UTC');assert.equal((await pool.query('SELECT role FROM "OrganizationMember" WHERE "orgId"=$1',[org.id])).rows[0].role,'OWNER');
 const record=(await pool.query('SELECT * FROM analytics_outbox')).rows[0];assert.equal(record.contract_name,'core.scope.definition@1');assert.equal(record.envelope.data.scope_external_id,org.id);assert.equal(record.source_stream_key,`organization:${org.id}:scopes`);
 await assert.rejects(requireAdmin(pool,org.id,'wrong'),/Not a member/);await assert.rejects(removeMember(pool,org.id,'owner'),/Cannot remove/);
 const token='synthetic-private-invitation';await pool.query('INSERT INTO "OrganizationInvitation"(id,"orgId",email,role,"tokenHash","invitedById","expiresAt","createdAt") VALUES(\'invite\',$1,\'guest@example.test\',\'MEMBER\',$2,\'owner\',NOW()+INTERVAL \'7 days\',NOW())',[org.id,createHash('sha256').update(token).digest('hex')]);
 assert.equal((await getInvitationByToken(pool,token))?.orgName,org.name);
 await assert.rejects(acceptInvitation(pool,token,'wrong'),/Sign in with/);assert.equal((await pool.query('SELECT "acceptedAt" FROM "OrganizationInvitation"')).rows[0].acceptedAt,null);
 const outcomes=await Promise.allSettled([acceptInvitation(pool,token,'guest'),acceptInvitation(pool,token,'guest')]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal((await pool.query('SELECT COUNT(*) FROM "OrganizationMember" WHERE "orgId"=$1 AND "userId"=\'guest\'',[org.id])).rows[0].count,'1');
 await assert.rejects(revokeInvitation(pool,org.id,'invite'),/Pending invitation not found/);
 await pool.query('UPDATE "OrganizationInvitation" SET id=\'revoked\',"acceptedAt"=NULL');await revokeInvitation(pool,org.id,'revoked');await assert.rejects(acceptInvitation(pool,token,'guest'),/Invitation not found/);
 // Mail failure is visible but invitation remains durable; a later send replaces the pending token.
 const messages: Record<string,unknown>[]=[];let mailStatus=503;
 const sink=createServer((request,response)=>{const chunks:Buffer[]=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{messages.push(JSON.parse(Buffer.concat(chunks).toString()));response.writeHead(mailStatus,{'content-type':'application/json'});response.end('{}');});});
 await new Promise<void>(resolve=>sink.listen(0,'127.0.0.1',resolve));
 try{const address=sink.address();assert.ok(address&&typeof address==='object');const mailContext={pool,config:readConfig({DATABASE_URL:url,LOCAL_MAILPIT_URL:`http://127.0.0.1:${address.port}`})};
 await assert.rejects(createInvitation(mailContext,org.id,org.name,'owner','Owner','new@example.test','MEMBER'),/Local email delivery failed/);
 assert.equal((await pool.query('SELECT COUNT(*) FROM "OrganizationInvitation" WHERE email=\'new@example.test\'')).rows[0].count,'1');
 mailStatus=200;const delivered=await createInvitation(mailContext,org.id,org.name,'owner','Owner','new@example.test','MEMBER');assert.equal(delivered.token,'');
 const text=String(messages.at(-1)!.Text);const token=text.match(/\/invite\/([A-Za-z0-9_-]{64})/)?.[1];assert.ok(token);assert.equal((await getInvitationByToken(pool,token))?.email,'new@example.test');
 assert.equal((await pool.query('SELECT COUNT(*) FROM "OrganizationInvitation" WHERE email=\'new@example.test\'')).rows[0].count,'1');
 }finally{await new Promise<void>((resolve,reject)=>sink.close(error=>error?reject(error):resolve()));}
 // A missing setup migration fails atomically rather than creating an organisation without its setup intent.
 await pool.query('ALTER TABLE "GrowthAgentSetup" RENAME TO "GrowthAgentSetup_hidden"');
 await assert.rejects(createOrg(context,'owner','Setup rollback','setup-rollback',null),/GrowthAgentSetup/);
 assert.equal((await pool.query('SELECT count(*) FROM "Organization" WHERE slug=\'setup-rollback\'')).rows[0].count,'0');
 await pool.query('ALTER TABLE "GrowthAgentSetup_hidden" RENAME TO "GrowthAgentSetup"');
 // Source-scope failure must roll back Organization and OWNER membership together.
 const setupCount=(await pool.query('SELECT count(*) FROM "GrowthAgentSetup"')).rows[0].count;
 await pool.query('DROP TABLE analytics_outbox');await assert.rejects(createOrg(context,'owner','Rollback','rollback-org',null),/failed to queue organization/);assert.equal((await pool.query('SELECT COUNT(*) FROM "Organization" WHERE slug=\'rollback-org\'')).rows[0].count, '0');assert.equal((await pool.query('SELECT count(*) FROM "GrowthAgentSetup"')).rows[0].count,setupCount);
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
