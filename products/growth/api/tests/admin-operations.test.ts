import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { installPgTimestampParsers } from '../src/db.js';
import { readConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { registerAdminOperationsRoutes } from '../src/routes/admin-operations.js';
import {
  currentCycle,
  invoiceInteger,
} from '../src/services/admin/invoices.js';
import { validateBody } from '../src/services/admin/validation.js';
import { validateSupportGrant } from '../src/services/admin/support-access.js';

test('invoice month-end clamping, source integer wrapping, typed DTO and support access validation', () => {
  assert.equal(
    currentCycle(31, new Date('2024-03-01T12:00:00Z')).key,
    '2024-02-29',
  );
  assert.equal(
    currentCycle(31, new Date('2024-03-31T12:00:00Z')).end.toISOString(),
    '2024-04-29T00:00:00.000Z',
  );
  assert.equal(invoiceInteger(4294967297n, 14), 1);
  assert.equal(invoiceInteger('4294967297', 14), 14);
  assert.equal(invoiceInteger(1.5, 3), 3);
  const b = validateBody('billing.CreditGrantRequest', {
    amount: 9223372036854775807n,
    source: 'MANUAL',
    reason: 'Fixture credits',
    idempotencyKey: 'fixture',
  });
  assert.equal(b.amount, 9223372036854775807n);
  assert.equal(
    validateBody('billing.UpsertEntitlementRequest', {
      planKey: 'fixture',
      key: 'fixture',
      value: null,
    }).value,
    null,
  );
  assert.throws(() =>
    validateBody('leads.CreateLeadBody', { businessName: 'x' }),
  );
  assert.throws(() =>
    validateSupportGrant({
      adminId: 'a',
      organizationId: 'o',
      resourceType: 'organization',
      resourceId: 'c',
      reason: 'Fixture support',
      durationMinutes: 5,
    }),
  );
});

test(
  'admin CRM/outreach/invoice state, privacy scopes, distinct replay approvals and operator restrictions',
  { skip: !process.env.CORE_ADMIN_OPERATIONS_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const url = process.env.CORE_ADMIN_OPERATIONS_TEST_DATABASE_URL!,
      schema = `admin_ops_test_${randomUUID().replaceAll('-', '')}`,
      adminPool = new pg.Pool({ connectionString: url });
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
        connectionString: url,
        options: `-c search_path=${schema} -c timezone=UTC`,
      }),
      context = {
        pool,
        config: readConfig({ DATABASE_URL: url, LOG_LEVEL: 'silent' }),
      },
      app = await buildApp(context, [registerAdminOperationsRoutes]);
    const migrations = resolve(
      process.cwd(),
      '../database/prisma/migrations',
    );
    const request = (
      method: any,
      path: string,
      payload?: unknown,
      actor = 'admin',
    ) =>
      app.inject({
        method,
        url: '/api/admin' + path,
        payload: payload as any,
        headers: { cookie: `kasitek_admin_session=${actor}` },
      });
    try {
      const initial = readFileSync(
        resolve(
          migrations,
          '20260301000000_initial_client_schema/migration.sql',
        ),
        'utf8',
      );
      for (const sql of initial.match(/CREATE TYPE [\s\S]*?;/g) ?? [])
        await pool.query(sql);
      for (const table of [
        'AdminUser',
        'QuoteRequest',
        'Quotation',
        'Invoice',
        'OutreachCampaign',
        'OutreachLead',
        'OutreachEmailDeliveryLog',
        'WebServiceLead',
        'Conversation',
        'Message',
        'NotificationEvent',
        'Notification',
      ])
        await pool.query(
          initial.match(new RegExp(`CREATE TABLE "${table}"[\\s\\S]*?;`))![0],
        );
      await pool.query(
        `CREATE TABLE "Organization"(id text PRIMARY KEY);ALTER TABLE "Conversation" ADD COLUMN "orgId" text,ADD COLUMN "customerId" text;ALTER TABLE "OutreachEmailDeliveryLog" ADD COLUMN IF NOT EXISTS "isTest" boolean DEFAULT false;`,
      );
      for (const folder of [
        '20260701103000_add_invoice_recurring_workflow',
        '20260814170000_add_admin_support_access',
        '20260814180000_add_admin_webhook_replay',
      ])
        await pool.query(
          readFileSync(resolve(migrations, folder, 'migration.sql'), 'utf8'),
        );
      await pool.query(
        `CREATE TABLE "PublicApiWebhookSubscription"(id text PRIMARY KEY,"orgId" text,status text);CREATE TABLE "PublicApiWebhookDelivery"(id text PRIMARY KEY,"subscriptionId" text,"eventId" text,"eventType" text,status text,"attemptCount" int,"nextAttemptAt" timestamp,"lastStatusCode" int,"lastError" text,"deliveredAt" timestamp,"updatedAt" timestamp);`,
      );
      for (const [id, role] of [
        ['admin', 'admin'],
        ['support', 'support'],
        ['viewer', 'viewer'],
        ['second', 'operator'],
      ])
        await pool.query(
          `INSERT INTO "AdminUser"(id,name,email,password,role,"updatedAt")VALUES($1,$1,$1||'@example.test','fixture',$2,NOW())`,
          [id, role],
        );
      await pool.query(`INSERT INTO "Organization" VALUES('org-a'),('org-b')`);
      assert.equal(
        (await request('GET', '/leads', undefined, 'missing')).statusCode,
        401,
      );
      const lead = (
        await request('POST', '/leads', {
          businessName: 'Fixture Company',
          contactPerson: 'Test Person',
          phone: '555',
          email: 'fixture@example.test',
          businessType: 'fixture',
          services: ['website'],
          quoteAmount: 12.5,
        })
      ).json();
      assert.ok(lead.id);
      assert.equal(lead.business_name, 'Fixture Company');
      assert.equal(lead.businessName, undefined);
      assert.equal(
        (await request('GET', '/leads?search=COMPANY')).json().length,
        1,
      );
      const note = await request('POST', `/leads/${lead.id}/notes`, {
        text: 'Fixture note',
      });
      assert.equal(note.json().notes[0].adminUserId, 'admin');
      assert.equal(
        (
          await request('PATCH', `/leads/${lead.id}`, {
            followUpDate: 'invalid',
          })
        ).json().follow_up_date,
        null,
      );
      const quoteBody = {
        businessName: 'Fixture Company',
        contactPerson: 'Test Person',
        contactEmail: 'fixture@example.test',
        contactPhone: '555',
        date: '2026-10-02',
        title: 'Fixture document',
        sectionOrder: ['intro'],
        noteSections: [{ title: 'Note' }],
      };
      const quote = await request('POST', '/quotations', quoteBody);
      assert.equal(quote.statusCode, 201);
      assert.deepEqual(quote.json().included_functionality, ['intro']);
      assert.deepEqual(quote.json().important_notes, [{ title: 'Note' }]);
      const invoice = await request('POST', '/invoices', {
        ...quoteBody,
        billingMode: 'monthly',
        billingAnchorDay: 1,
        validityDays: 1,
        reminderDaysAfterDue: 0,
      });
      assert.equal(invoice.statusCode, 201);
      let invoiceData = invoice.json();
      assert.equal(invoiceData.operations.needsInvoiceSend, true);
      const invoiceId = invoiceData.id,
        runId = invoiceData.currentRun.id;
      invoiceData = (
        await request('POST', `/invoices/${invoiceId}/runs/${runId}/actions`, {
          action: 'mark_sent',
        })
      ).json();
      assert.equal(invoiceData.currentRun.sendStatus, 'sent');
      assert.equal(invoiceData.operations.needsReminder, true);
      assert.equal(
        (await pool.query(`SELECT COUNT(*) FROM "NotificationEvent"`)).rows[0]
          .count,
        '1',
      );
      await request('GET', `/invoices/${invoiceId}`);
      assert.equal(
        (await pool.query(`SELECT COUNT(*) FROM "NotificationEvent"`)).rows[0]
          .count,
        '1',
      );
      invoiceData = (
        await request('POST', `/invoices/${invoiceId}/runs/${runId}/actions`, {
          action: 'mark_paid',
        })
      ).json();
      assert.equal(invoiceData.status, 'paid');
      assert.equal(invoiceData.currentRun.status, 'paid');
      // Source actions are administrative state markers, not payment provider
      // calls, and require a valid Admin session rather than a second approval.
      // Repeating mark_paid must not create another cycle or reminder fact.
      const paidRunsBefore = (
        await pool.query(
          'SELECT COUNT(*)::int AS count FROM "InvoiceRun" WHERE "invoiceId"=$1',
          [invoiceId],
        )
      ).rows[0].count;
      const notificationFactsBefore = (
        await pool.query(
          'SELECT COUNT(*)::int AS count FROM "NotificationEvent"',
        )
      ).rows[0].count;
      const paidAgain = await request(
        'POST',
        `/invoices/${invoiceId}/runs/${runId}/actions`,
        { action: 'mark_paid' },
      );
      assert.equal(paidAgain.statusCode, 200);
      assert.equal(paidAgain.json().currentRun.id, runId);
      assert.equal(paidAgain.json().currentRun.status, 'paid');
      assert.equal(
        (
          await pool.query(
            'SELECT COUNT(*)::int AS count FROM "InvoiceRun" WHERE "invoiceId"=$1',
            [invoiceId],
          )
        ).rows[0].count,
        paidRunsBefore,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT COUNT(*)::int AS count FROM "NotificationEvent"',
          )
        ).rows[0].count,
        notificationFactsBefore,
      );
      const unauthenticatedAction = await request(
        'POST',
        `/invoices/${invoiceId}/runs/${runId}/actions`,
        { action: 'mark_paid' },
        'missing-session',
      );
      assert.equal(unauthenticatedAction.statusCode, 401);
      const campaign = await request('POST', '/outreach/import', {
        name: 'Fixture campaign',
        category: 'Fixture',
        listings: [{ name: 'A&B Company' }],
      });
      assert.equal(campaign.statusCode, 201);
      const campaignId = campaign.json().id,
        outreachLead = (
          await request('GET', `/outreach/${campaignId}/leads`)
        ).json()[0];
      assert.equal(
        outreachLead.bizbay_url,
        'https://bizbay.co.za/Company/ab-company',
      );
      await request(
        'PATCH',
        `/outreach/${campaignId}/leads/${outreachLead.id}`,
        { emailStatus: 'sent' },
      );
      assert.equal(
        (await request('GET', `/outreach/${campaignId}`)).json().emails_sent,
        1,
      );
      assert.equal(
        (await request('GET', `/outreach/other/leads/${outreachLead.id}`))
          .statusCode,
        404,
      );
      const web = await request('POST', '/web-services', {
        businessName: 'Web lead',
        category: 'Fixture',
      });
      assert.equal(web.statusCode, 201);
      assert.equal(
        (
          await request('POST', '/web-services/import', {
            leads: [{ businessName: 'Other', category: 'Fixture' }],
          })
        ).json().inserted,
        1,
      );
      await pool.query(
        `INSERT INTO "Conversation"(id,channel,"customerIdentifier","orgId",status,"updatedAt") VALUES('conversation-a','email','a','org-a','open',NOW()),('conversation-b','email','b','org-b','open',NOW());INSERT INTO "Message"(id,"conversationId",sender,content) VALUES('message-a','conversation-a','USER','Private fixture');`,
      );
      assert.equal(
        (
          await request(
            'GET',
            '/conversations?organizationId=org-a',
            undefined,
            'support',
          )
        ).statusCode,
        403,
      );
      const grant = await request('POST', '/operations/support-grants', {
        adminId: 'support',
        organizationId: 'org-a',
        resourceType: 'organization',
        reason: 'Fixture support investigation',
        durationMinutes: 5,
      });
      assert.equal(grant.statusCode, 201);
      const convo = await request(
        'GET',
        '/conversations/conversation-a',
        undefined,
        'support',
      );
      assert.equal(convo.statusCode, 200);
      assert.equal(convo.json().conversation.org_id, undefined);
      assert.equal(convo.json().messages[0].role, 'USER');
      assert.equal(
        (
          await request(
            'GET',
            '/conversations/conversation-b',
            undefined,
            'support',
          )
        ).statusCode,
        403,
      );
      await pool.query(
        'UPDATE "AdminSupportAccessGrant" SET "expiresAt"=NOW()-INTERVAL \'1 second\' WHERE id=$1',
        [grant.json().id],
      );
      assert.equal(
        (
          await request(
            'GET',
            '/conversations/conversation-a',
            undefined,
            'support',
          )
        ).statusCode,
        403,
      );
      await pool.query(
        'UPDATE "AdminSupportAccessGrant" SET "expiresAt"=NOW()+INTERVAL \'5 minutes\' WHERE id=$1',
        [grant.json().id],
      );
      assert.equal(
        (
          await request(
            'GET',
            '/conversations/conversation-a',
            undefined,
            'support',
          )
        ).statusCode,
        200,
      );
      await request(
        'POST',
        `/operations/support-grants/${grant.json().id}/revoke`,
      );
      assert.equal(
        (
          await request(
            'GET',
            '/conversations/conversation-a',
            undefined,
            'support',
          )
        ).statusCode,
        403,
      );
      await pool.query(
        `INSERT INTO "PublicApiWebhookSubscription" VALUES('sub','org-a','ACTIVE');INSERT INTO "PublicApiWebhookDelivery"(id,"subscriptionId","eventId","eventType",status,"attemptCount","updatedAt")VALUES('delivery','sub','event','fixture','FAILED',3,NOW())`,
      );
      const replay = await app.inject({
        method: 'POST',
        url: '/api/admin/operations/webhooks/replays',
        headers: {
          cookie: 'kasitek_admin_session=admin',
          'idempotency-key': 'fixture-replay-key',
        },
        payload: {
          deliveryId: 'delivery',
          expectedStatus: 'failed',
          expectedAttemptCount: 3,
        },
      });
      assert.equal(replay.statusCode, 202);
      const replayId = replay.json().id;
      assert.equal(
        (
          await request(
            'POST',
            `/operations/webhooks/replays/${replayId}/approve`,
          )
        ).statusCode,
        409,
      );
      const completed = await request(
        'POST',
        `/operations/webhooks/replays/${replayId}/approve`,
        {},
        'second',
      );
      assert.equal(completed.statusCode, 202);
      assert.equal(completed.json().status, 'completed');
      assert.equal(
        (
          await pool.query(
            `SELECT status,"attemptCount" FROM "PublicApiWebhookDelivery"`,
          )
        ).rows[0].status,
        'PENDING',
      );
      assert.equal(
        (
          await request(
            'POST',
            `/operations/webhooks/replays/${replayId}/approve`,
            {},
            'second',
          )
        ).json().status,
        'completed',
      );
      assert.equal(
        (await request('GET', '/billing/catalog', undefined, 'viewer'))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await request(
            'POST',
            '/operations/commands',
            { commandType: 'test' },
            'support',
          )
        ).statusCode,
        403,
      );
      const global = await app.inject({
        method: 'POST',
        url: '/api/admin/operations/commands',
        headers: {
          cookie: 'kasitek_admin_session=admin',
          'idempotency-key': 'fixture-global-key',
        },
        payload: {
          commandType: 'kill_switch_enable',
          payload: { scopeType: 'global' },
        },
      });
      assert.equal(global.statusCode, 403);
      assert.equal(
        (await request('GET', '/operations/runs?limit=501')).statusCode,
        400,
      );
      const ownNotification = (
        await pool.query(
          `SELECT id FROM "Notification" WHERE "recipientId"='admin' LIMIT 1`,
        )
      ).rows[0].id;
      assert.equal(
        (
          await request(
            'PATCH',
            `/notifications/${ownNotification}`,
            {},
            'support',
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (await request('PATCH', `/notifications/${ownNotification}`))
          .statusCode,
        200,
      );
    } finally {
      await app.close();
      await pool.end();
      await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await adminPool.end();
    }
  },
);
