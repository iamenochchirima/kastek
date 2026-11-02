import { adminFixtureHeaders, seedAdminFixtureSessions } from "./helpers/admin-fixture.js";
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { createServer } from 'node:http';
import { readConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { registerEarlyAccessRoutes } from '../src/routes/early-access.js';
import { installPgTimestampParsers } from '../src/db.js';
import { getApplication, rejectApplication, recordSubmission, packageParameters,
  betaPackageSnapshot, selectedCapabilities, transitionAllowed, boundedText,
  signupInvitationPreview, markInvitationDelivery, releaseActivationClaim,
  approveApplication, activateInvitation, resendInvitation, revokeApplication, restoreApplication,
  batchApprove, statusForOrg, listApplications } from '../src/services/early-access.js';

test('early-access package validation refuses invalid allocations and preserves lifecycle reversals', () => {
  assert.equal(transitionAllowed('new', 'active'), false);
  assert.equal(transitionAllowed('rejected', 'approved'), false);
  assert.equal(transitionAllowed('revoked', 'invited'), true);
  assert.equal(transitionAllowed('active', 'expired'), true);
  assert.deepEqual(packageParameters(betaPackageSnapshot()), { durationDays: 30, credits: 1000n,
    capabilities: selectedCapabilities() });
  assert.throws(() => packageParameters({ ...betaPackageSnapshot(), credits: 1_000_001 }), /allocation is invalid/);
  assert.throws(() => packageParameters({ ...betaPackageSnapshot(), durationDays: 1.5 }), /duration is invalid/);
  assert.throws(() => selectedCapabilities(['feature.unsupported']), /Unsupported early-access capability/);
  assert.throws(() => boundedText('éé', 'Name', 3), /at most 3 characters/);
  assert.deepEqual(selectedCapabilities([' feature.inbox.access ', '', 'feature.inbox.access']), ['feature.inbox.access']);
});

test('early-access rejection records one transition, retains microsecond projections and refuses invalid state',
  { skip: !process.env.CORE_EARLY_ACCESS_TEST_DATABASE_URL }, async () => {
    installPgTimestampParsers();
    const url = process.env.CORE_EARLY_ACCESS_TEST_DATABASE_URL!;
    const schema = `early_access_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c timezone=UTC` });
    try {
      await pool.query(`CREATE TABLE "ProductWaitlistEntry"(id text PRIMARY KEY,"businessName" text,"contactPerson" text,
        phone text,email text,"businessType" text,website text,products text[],notes text,source text,status text,cohort text,
        "reviewNotes" text,"decisionReason" text,"reviewedById" text,"reviewedAt" timestamp,"approvedById" text,
        "approvedAt" timestamp,"organizationId" text,"earlyAccessInvitationId" text,"packageKey" text,"packageSnapshot" jsonb,
        "activatedAt" timestamp,"earlyAccessEndsAt" timestamp,"entitlementGrantIds" jsonb,"creditGrantId" text,
        "createdAt" timestamp,"updatedAt" timestamp);
        CREATE TABLE "EarlyAccessInvitation"(id text PRIMARY KEY,status text,"deliveryStatus" text,"expiresAt" timestamp,
          "waitlistEntryId" text,email text,"tokenHash" text,"deliveryAttempts" integer DEFAULT 0,
          "lastDeliveryAttemptAt" timestamp,"lastDeliveryErrorCode" text,"updatedAt" timestamp,"acceptedAt" timestamp);
        CREATE TABLE "ProductWaitlistEvent"(id text PRIMARY KEY,"waitlistEntryId" text,"fromStatus" text,"toStatus" text,
          action text,"actorId" text,reason text,metadata jsonb,"createdAt" timestamp);
        INSERT INTO "EarlyAccessInvitation"(id,status,"deliveryStatus","expiresAt","waitlistEntryId",email)
          VALUES ('invitation','pending','sent','2026-10-05 01:02:03.123456','application','person@example.test');
        INSERT INTO "ProductWaitlistEntry"(id,"contactPerson",email,status,"earlyAccessInvitationId","createdAt","entitlementGrantIds")
          VALUES ('application','Person','person@example.test','new','invitation','2026-10-01 01:02:03.123456','[]')`);
      await recordSubmission(pool, 'application');
      const before = await getApplication(pool, 'application');
      assert.equal((before.application.invitationExpiresAt as Date).toISOString(), '2026-10-05T01:02:03.123456Z');
      assert.equal(before.application.businessName, 'Person');
      await pool.query(`UPDATE "EarlyAccessInvitation" SET "tokenHash"=$1 WHERE id='invitation'`,
        [createHash('sha256').update('synthetic-invite-token').digest('hex')]);
      const preview = await signupInvitationPreview(pool, 'synthetic-invite-token');
      assert.equal(preview.email, 'person@example.test');
      assert.equal(preview.businessName, 'Person');
      await assert.rejects(signupInvitationPreview(pool, 'wrong-token'), /invitation not found/);
      await markInvitationDelivery(pool, 'invitation', false);
      await markInvitationDelivery(pool, 'invitation', true);
      const delivery = (await pool.query(`SELECT * FROM "EarlyAccessInvitation" WHERE id='invitation'`)).rows[0];
      assert.equal(delivery.deliveryAttempts, 2);
      assert.equal(delivery.deliveryStatus, 'sent');
      assert.equal(delivery.lastDeliveryErrorCode, null);
      await pool.query(`UPDATE "EarlyAccessInvitation" SET status='accepted',"acceptedAt"=NOW() WHERE id='invitation'`);
      await releaseActivationClaim(pool, 'invitation');
      assert.equal((await signupInvitationPreview(pool, 'synthetic-invite-token')).status, 'pending');
      const rejected = await rejectApplication(pool, 'application', 'operator', { reason: ' Out of scope ' });
      assert.equal(rejected.status, 'rejected');
      assert.equal(rejected.decisionReason, 'Out of scope');
      assert.equal(rejected.reviewedById, 'operator');
      await rejectApplication(pool, 'application', 'operator', { reason: 'Repeated' });
      const after = await getApplication(pool, 'application');
      assert.deepEqual(after.events.map((event) => event.action), ['submitted', 'rejected']);
      await pool.query(`UPDATE "ProductWaitlistEntry" SET status='active' WHERE id='application'`);
      await assert.rejects(rejectApplication(pool, 'application', 'operator', { reason: 'Invalid' }), /Cannot reject.*active/);
      await assert.rejects(getApplication(pool, 'missing'), /application not found/);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });

test('isolated early-access approval, activation, retries, revocation and expiry preserve credits and access',
  { skip: !process.env.CORE_EARLY_ACCESS_TEST_DATABASE_URL }, async () => {
    installPgTimestampParsers();
    const url = process.env.CORE_EARLY_ACCESS_TEST_DATABASE_URL!;
    const schema = `early_activation_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c timezone=UTC` });
    const messages: { To: { Email: string }[]; Text: string }[] = [];
    let failMail = false;
    const server = createServer((request, response) => {
      const bytes: Buffer[] = [];
      request.on('data', (chunk: Buffer) => bytes.push(chunk));
      request.on('end', () => {
        messages.push(JSON.parse(Buffer.concat(bytes).toString()));
        response.writeHead(failMail ? 503 : 200, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const core = { pool, config: readConfig({ DATABASE_URL: url, LOG_LEVEL: 'silent',
      LOCAL_MAILPIT_URL: `http://127.0.0.1:${address.port}` }) };
    const app = await buildApp(core, [registerEarlyAccessRoutes]);
    try {
      // Clone schema definitions only. No production rows or foreign keys are copied.
      const enumNames = ['EntitlementSource', 'OrgRole', 'NotificationScopeType', 'NotificationSeverity',
        'NotificationRecipientType', 'NotificationChannel', 'NotificationStatus'];
      for (const name of enumNames) {
        const labels = (await admin.query(`SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid=enumtypid
          JOIN pg_namespace ON pg_namespace.oid=typnamespace WHERE pg_namespace.nspname='public' AND typname=$1 ORDER BY enumsortorder`, [name])).rows;
        await pool.query(`CREATE TYPE "${name}" AS ENUM (${labels.map((row) => "'" + String(row.enumlabel).replaceAll("'", "''") + "'").join(',')})`);
      }
      for (const name of ['User', 'Organization', 'OrganizationMember', 'ReferralCode', 'analytics_outbox',
        'CreditAccount', 'CreditGrant', 'CreditLedgerEntry', 'CreditReservation', 'CreditUsageEvent', 'CreditAdminOperation',
        'OrganizationEntitlementGrant', 'ProductWaitlistEntry', 'EarlyAccessInvitation', 'ProductWaitlistEvent',
        'AdminUser', 'NotificationEvent', 'Notification']) {
        await pool.query(`CREATE TABLE "${name}" (LIKE public."${name}" INCLUDING ALL)`);
      }
      await pool.query(await readFile(new URL("../../database/prisma/migrations/20261023170000_growth_agent_setup/migration.sql",import.meta.url),"utf8"));
      const enumColumns = (await admin.query(`SELECT table_name,column_name,udt_name FROM information_schema.columns
        WHERE table_schema=$1 AND udt_schema='public' AND udt_name=ANY($2::text[])`, [schema, enumNames])).rows;
      for (const column of enumColumns) {
        await pool.query(`ALTER TABLE "${column.table_name}" ALTER COLUMN "${column.column_name}" DROP DEFAULT;
          ALTER TABLE "${column.table_name}" ALTER COLUMN "${column.column_name}" TYPE "${column.udt_name}"
          USING "${column.column_name}"::text::"${column.udt_name}"`);
      }
      await pool.query(`INSERT INTO "User"(id,name,email,"createdAt","updatedAt") VALUES
        ('owner','Owner','Owner@example.test',NOW(),NOW()),('wrong','Wrong','wrong@example.test',NOW(),NOW());
        INSERT INTO "AdminUser"(id,name,email,password,role,"createdAt","updatedAt")
          VALUES('operator','Operator','operator@example.test','synthetic','admin',NOW(),NOW());
        INSERT INTO "ProductWaitlistEntry"(id,"contactPerson",email,products,"createdAt","updatedAt")
          VALUES('application','Owner','owner@example.test','{}',NOW(),NOW())`);
      await seedAdminFixtureSessions(pool);
      const headers = adminFixtureHeaders("operator");
      const unauthorized = await app.inject({ url: '/api/admin/early-access/application' });
      assert.equal(unauthorized.statusCode, 401);
      await pool.query(`UPDATE "AdminUser" SET role='support' WHERE id='operator'`);
      assert.equal((await app.inject({ url: '/api/admin/early-access/application', headers })).statusCode, 403);
      await pool.query(`UPDATE "AdminUser" SET role='admin' WHERE id='operator'`);
      const approval = await app.inject({ method: 'POST', url: '/api/admin/early-access/application/approve', headers, payload: {} });
      assert.equal(approval.statusCode, 200, approval.body);
      const approved = approval.json().application;
      assert.equal(approved.status, 'invited');
      assert.equal(approved.invitationDeliveryStatus, 'sent');
      assert.equal(messages.length, 1);
      assert.equal(messages[0]!.To[0]!.Email, 'owner@example.test');
      const token = messages[0]!.Text.match(/\/early-access\/([A-Za-z0-9_-]+)/)![1]!;
      assert.ok(!JSON.stringify(approved).includes(token));
      assert.equal((await app.inject({ url: `/api/early-access/invitations/${token}` })).statusCode, 200);
      assert.equal((await app.inject({ url: '/api/admin/early-access?limit=9223372036854775808', headers })).statusCode, 400);
      await approveApplication(core, 'application', 'operator', {});
      assert.equal(messages.length, 1);
      await assert.rejects(activateInvitation(core, token, 'wrong', { workspaceName: 'Wrong' }), /approved email address/);
      const [first, repeated] = await Promise.all([
        activateInvitation(core, token, 'owner', { workspaceName: 'Early Workspace' }),
        activateInvitation(core, token, 'owner', { workspaceName: 'Must Not Create Another' }),
      ]);
      assert.equal(first.status, 'active');
      assert.equal(first.organizationId, repeated.organizationId);
      assert.equal((await pool.query('SELECT COUNT(*) FROM "Organization"')).rows[0].count, '1');
      assert.equal((await pool.query('SELECT COUNT(*) FROM "GrowthAgentSetup"')).rows[0].count, '1');
      assert.equal((await pool.query('SELECT COUNT(*) FROM "OrganizationEntitlementGrant"')).rows[0].count, '5');
      assert.equal((await pool.query('SELECT SUM(amount) AS amount FROM "CreditGrant"')).rows[0].amount, '1000');
      assert.equal((await statusForOrg(pool, String(first.organizationId)))?.status, 'active');
      await assert.rejects(resendInvitation(core, 'application', 'operator'), /Only approved or invited/);
      await revokeApplication(pool, 'application', 'operator', 'Withdraw access');
      assert.equal((await pool.query('SELECT balance FROM "CreditAccount"')).rows[0].balance, '0');
      const revoked = await getApplication(pool, 'application');
      assert.equal(revoked.application.status, 'revoked');
      assert.equal((await pool.query('SELECT COUNT(*) FROM "Notification"')).rows[0].count, '1');
      failMail = true;
      const restored = await restoreApplication(core, 'application', 'operator', 'Retry access');
      assert.equal(restored.status, 'approved');
      assert.equal(restored.invitationDeliveryStatus, 'failed');
      failMail = false;
      await resendInvitation(core, 'application', 'operator');
      assert.equal((await getApplication(pool, 'application')).application.status, 'invited');
      await pool.query(`INSERT INTO "ProductWaitlistEntry"(id,"contactPerson",email,products,"createdAt","updatedAt")
        VALUES('failure','Wrong','wrong@example.test','{}',NOW(),NOW())`);
      await approveApplication(core, 'failure', 'operator', {});
      const failureToken = messages.at(-1)!.Text.match(/\/early-access\/([A-Za-z0-9_-]+)/)![1]!;
      // A controlled schema fault verifies compensation without touching real service tables.
      await pool.query(`ALTER TABLE "OrganizationEntitlementGrant" RENAME TO "HiddenEntitlementGrant"`);
      try {
        await assert.rejects(activateInvitation(core, failureToken, 'wrong', { workspaceName: 'Failed Workspace' }), /does not exist/);
        assert.equal((await pool.query('SELECT COUNT(*) FROM "Organization"')).rows[0].count, '1');
        assert.equal((await signupInvitationPreview(pool, failureToken)).status, 'pending');
      } finally {
        await pool.query(`ALTER TABLE "HiddenEntitlementGrant" RENAME TO "OrganizationEntitlementGrant"`);
      }
      await pool.query(`UPDATE "ProductWaitlistEntry" SET "earlyAccessEndsAt"=NOW()-INTERVAL '1 day' WHERE id='application'`);
      assert.equal((await listApplications(pool, { status: 'expired' }))[0]?.status, 'expired');
      const batch = await batchApprove(core, 'operator', { applicationIds: ['application', 'missing'] });
      assert.equal(batch.alreadyProcessed, 1);
      assert.equal(batch.failed, 1);
    } finally {
      await app.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
