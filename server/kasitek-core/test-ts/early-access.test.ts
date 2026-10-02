import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { installPgTimestampParsers } from '../src-ts/db.js';
import { getApplication, rejectApplication, recordSubmission, packageParameters,
  betaPackageSnapshot, selectedCapabilities, transitionAllowed, boundedText,
  signupInvitationPreview, markInvitationDelivery, releaseActivationClaim } from '../src-ts/services/early-access.js';

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
