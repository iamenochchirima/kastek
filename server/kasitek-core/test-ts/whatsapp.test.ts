import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";
import { readConfig } from "../src-ts/config.js";
import { installPgTimestampParsers } from "../src-ts/db.js";
import { encryptSocialSecret } from "../src-ts/integrations/crypto.js";
import {
  normalizePhone,
  sanitizeListLabel,
  parseBoolLike,
  pickFirst,
  variablesCount,
  contactEligible,
  fetchGraphJson,
  type MarketingOptions,
} from "../src-ts/services/whatsapp/common.js";
import {
  importContacts,
  listContacts,
  updateContact,
  updateAgentContact,
  exportContactList,
  renameContactList,
  deleteContactList,
} from "../src-ts/services/whatsapp/contacts.js";
import {
  syncConnectionTemplates,
  createTemplate,
  listTemplates,
} from "../src-ts/services/whatsapp/templates.js";
import {
  createCampaign,
  getCampaign,
  getCampaignSummary,
  launchCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  deleteCampaign,
  retryFailedCampaign,
  processQueuedCampaignRecipients,
  buildBodyParameters,
  parseFailureDetails,
} from "../src-ts/services/whatsapp/campaigns.js";
import { runWhatsappCampaigns } from "../src-ts/workers/whatsapp-campaigns.js";
import {
  WHATSAPP_MARKETING_ROUTES,
  contactUpdateInput,
  campaignCreateInput,
  contactListQuery,
} from "../src-ts/routes/whatsapp.js";
import { SerdeFloat } from "@kasitek/server-support/json";
const config = readConfig({
  DATABASE_URL: "postgres://fixture",
  WHATSAPP_TOKEN_ENCRYPTION_KEY: "synthetic-key",
  WHATSAPP_DEFAULT_COUNTRY_CODE: "+27",
});
test("WhatsApp normalization, transport integers, template variables and provider failure classes match source", () => {
  assert.equal(normalizePhone("(082) 123-4567", config), "+27821234567");
  assert.equal(normalizePhone("0027821234567", config), "+27821234567");
  assert.equal(normalizePhone("+0123", config), "");
  assert.equal(sanitizeListLabel("  Western Cape / VIP  "), "western-cape-vip");
  assert.equal(parseBoolLike(" Yes "), true);
  assert.equal(
    pickFirst({ phone: " ", mobile: "valid" }, ["phone", "mobile"]),
    null,
  );
  assert.equal(variablesCount("{{1}} {{unfinished {{2}}"), 3);
  assert.equal(WHATSAPP_MARKETING_ROUTES.length, 16);
  assert.throws(() => campaignCreateInput({ batchSize: new SerdeFloat(1) }));
  assert.throws(() => contactUpdateInput({ optIn: "true" }));
  assert.throws(() => contactListQuery({ cursor: "-1" }));
  assert.equal(
    contactListQuery({ limit: "9223372036854775807" }).limit,
    9223372036854775807n,
  );
  assert.deepEqual(
    parseFailureDetails(new Error("(#131026) Recipient unavailable")),
    ["131026", "(#131026) Recipient unavailable", true],
  );
  assert.deepEqual(
    buildBodyParameters(
      {
        full_name: "Ada",
        phone: "+27821234567",
        location: null,
        tags: ["vip"],
        metadata: { amount: 9223372036854775807n },
      } as any,
      [{ key: "name" }, { source: "static", key: "Hello" }, { key: "amount" }],
    ),
    ["Ada", "Hello", "9223372036854775807"],
  );
});
test("pre-aborted campaign worker has no database or provider effects", async () => {
  const signal = AbortSignal.abort();
  await runWhatsappCampaigns(
    {
      query() {
        throw new Error("Unexpected query");
      },
    } as any,
    config,
    signal,
    async () => {
      throw new Error("Unexpected publish");
    },
    { info() {}, error() {} },
  );
});
test(
  "isolated contacts, templates and campaign lifecycle keep scope, consent, journal, analytics and send idempotency",
  { skip: !process.env.CORE_WHATSAPP_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const url = process.env.CORE_WHATSAPP_TEST_DATABASE_URL!,
      schema = `whatsapp_test_${randomUUID().replaceAll("-", "")}`,
      admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    const sent: Record<string, any>[] = [],
      events: unknown[] = [];
    let rejectSend = false;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const payload = chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString())
          : null;
        response.setHeader("Content-Type", "application/json");
        if (request.url?.includes("/message_templates")) {
          if (request.method === "POST") {
            assert.equal(payload.category, "MARKETING");
            response.end(
              JSON.stringify({ id: "meta-template", status: "PENDING" }),
            );
          } else
            response.end(
              JSON.stringify({
                data: [
                  {
                    name: "hello",
                    language: "en",
                    category: "MARKETING",
                    status: "APPROVED",
                    components: [{ type: "BODY", text: "Hello {{1}}" }],
                  },
                  { name: "ignored", language: "en", category: "UNKNOWN" },
                ],
              }),
            );
        } else {
          sent.push(payload);
          assert.equal(request.headers.authorization, "Bearer synthetic-token");
          if (rejectSend) {
            response.statusCode = 400;
            response.end(
              JSON.stringify({ error: { message: "(#131026) blocked" } }),
            );
          } else
            response.end(
              JSON.stringify({
                messages: [{ id: `synthetic-${sent.length}` }],
              }),
            );
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${
      (
        server.address() as {
          port: number;
        }
      ).port
    }`;
    const options: MarketingOptions = {
      config: readConfig({
        DATABASE_URL: url,
        WHATSAPP_TOKEN_ENCRYPTION_KEY: "synthetic-key",
        WHATSAPP_CAMPAIGN_PROCESSING_TIMEOUT_SECONDS: "120",
      }),
      graphBase: base,
      publishEvent: async (_, event) => {
        events.push(event);
      },
    };
    const enforcement = process.env.KASITEK_BILLING_ENFORCEMENT;
    process.env.KASITEK_BILLING_ENFORCEMENT = "false";
    try {
      await pool.query(
        readFileSync(
          "../../client/packages/database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql",
          "utf8",
        ),
      );
      const tables = [
        "WhatsappContact",
        "WhatsappContactListMembership",
        "WhatsappConnection",
        "WhatsappTemplate",
        "WhatsappCampaign",
        "WhatsappCampaignRecipient",
        "WhatsappSendEvent",
        "ExternalConnection",
        "Customer",
        "CustomerIdentity",
        "UsageEvent",
      ];
      const columns = (
        await admin.query(
          `SELECT c.relname AS table_name,a.attname AS column_name,t.typname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid WHERE n.nspname='public' AND c.relname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped AND t.typtype='e'`,
          [tables],
        )
      ).rows;
      for (const name of new Set(columns.map((row) => row.typname as string))) {
        const labels = (
          await admin.query(
            `SELECT enumlabel FROM pg_enum JOIN pg_type t ON t.oid=enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname=$1 ORDER BY enumsortorder`,
            [name],
          )
        ).rows;
        await pool.query(
          `CREATE TYPE "${name}" AS ENUM (${labels.map((row) => "'" + row.enumlabel.replaceAll("'", "''") + "'").join(",")})`,
        );
      }
      for (const name of tables)
        await pool.query(
          `CREATE TABLE "${name}" (LIKE public."${name}" INCLUDING ALL)`,
        );
      for (const row of columns)
        await pool.query(
          `ALTER TABLE "${row.table_name}" ALTER COLUMN "${row.column_name}" DROP DEFAULT;ALTER TABLE "${row.table_name}" ALTER COLUMN "${row.column_name}" TYPE "${row.typname}" USING "${row.column_name}"::text::"${row.typname}"`,
        );
      await pool.query(
        `INSERT INTO "WhatsappConnection"(id,"userId","orgId","phoneNumberId","accessTokenEncrypted","wabaId","currentQualityRating","authMethod","updatedAt")VALUES('connection','user','org','phone',$1,'waba','GREEN','manual',NOW())`,
        [encryptSocialSecret(options.config, "synthetic-token")],
      );
      await pool.query(
        `INSERT INTO "ExternalConnection"(id,"orgId","sourceType","sourceId",provider,"displayName",status,"credentialStatus","healthStatus","webhookStatus","updatedAt")VALUES('external','org','WHATSAPP','connection','whatsapp','Synthetic','CONNECTED','VALID','HEALTHY','ACTIVE',NOW());`,
      );
      const bytes = Buffer.from(
        'phone,fullName,optIn,listLabel,Code\n0821234567,"Ada, Example",true,VIP,42\n0821234567,Updated,true,VIP,43\ninvalid,Bad,true,VIP,\n0827654321,Blocked,true,VIP,44\n',
      );
      await assert.rejects(
        importContacts(pool, "user", "org", { bytes }),
        /Confirm that you have permission/,
      );
      const imported = await importContacts(pool, "user", "org", {
        bytes,
        consentConfirmed: true,
      });
      assert.equal(imported.summary.created, 2);
      assert.equal(imported.summary.invalidRows, 1);
      const listed = await listContacts(pool, "org", {});
      assert.equal(listed.contacts.length, 2);
      assert.equal(listed.stats.totalContacts, 2);
      assert.equal(
        (await listContacts(pool, "foreign", {})).contacts.length,
        0,
      );
      const contact = listed.contacts.find(
        (contact: any) => contact.phone === "+27821234567",
      );
      assert.equal(contact.fullName, "Updated");
      assert.equal(contact.metadata.Code, "43");
      assert.equal(typeof contact.customerId, "string");
      await assert.rejects(
        updateContact(pool, "foreign", contact.id, { notes: "foreign" }),
        /Contact not found/,
      );
      await updateAgentContact(
        pool,
        "org",
        contact.id,
        { notes: "Synthetic", metadata: { Code: "45" } },
        "synthetic-key",
      );
      const exported = await exportContactList(pool, "org", "vip");
      assert.match(exported.bytes.toString(), /Code/);
      assert.equal(exported.filename, "vip.csv");
      await pool.query(
        `UPDATE "ExternalConnection" SET status='REVOKED' WHERE id='external'`,
      );
      await assert.rejects(
        syncConnectionTemplates(pool, "user", "org", "connection", options),
        /not active/,
      );
      await pool.query(
        `UPDATE "ExternalConnection" SET status='CONNECTED' WHERE id='external'`,
      );
      const synced = await syncConnectionTemplates(
        pool,
        "user",
        "org",
        "connection",
        options,
      );
      assert.deepEqual(synced, {
        connectionId: "connection",
        fetched: 2,
        synced: 1,
      });
      const template = (await listTemplates(pool, "org", "APPROVED"))
        .templates[0];
      assert.equal(template.variablesCount, 1);
      const createdTemplate = await createTemplate(
        pool,
        "user",
        "org",
        {
          connection_id: "connection",
          template_name: "New Greeting",
          language: "en",
          body: "Hello",
        },
        options,
      );
      assert.equal(createdTemplate.template.template_name, "new_greeting");
      assert.equal(createdTemplate.metaTemplateId, "meta-template");
      const contacts = (await listContacts(pool, "org", {})).contacts;
      await importContacts(pool, "other-user", "foreign", {
        bytes: Buffer.from("phone,optIn\n0831112222,true\n"),
        consentConfirmed: true,
      });
      const foreign = (await listContacts(pool, "foreign", {})).contacts[0];
      const campaign = await createCampaign(
        pool,
        "user",
        "org",
        {
          name: "Synthetic campaign",
          connection_id: "connection",
          template_id: template.id,
          list_label: "vip",
          recipient_ids: contacts.map((c: any) => c.contactId),
          variable_mappings: [{ key: "fullName" }],
          batch_size: 2,
          excluded_contact_ids: [foreign.contactId],
        },
        options,
      );
      const id = campaign.campaign.id;
      assert.equal(campaign.createdRecipients, 2);
      await assert.rejects(
        getCampaignSummary(pool, "foreign", id),
        /Campaign not found/,
      );
      assert.equal(
        (await getCampaign(pool, "org", id)).campaign.recipients.length,
        2,
      );
      await launchCampaign(pool, "user", "org", id, null, 2, options);
      await pauseCampaign(pool, "user", "org", id, options);
      assert.equal(
        (await getCampaignSummary(pool, "org", id)).campaign.status,
        "PAUSED",
      );
      await resumeCampaign(pool, "user", "org", id, null, options);
      await pool.query(
        `UPDATE "WhatsappCampaignRecipient" SET status='PROCESSING',"updatedAt"=NOW()-INTERVAL '5 minutes' WHERE id=(SELECT id FROM "WhatsappCampaignRecipient" WHERE "campaignId"=$1 ORDER BY "createdAt" LIMIT 1)`,
        [id],
      );
      assert.equal(await processQueuedCampaignRecipients(pool, 1, options), 1);
      assert.equal(sent.length, 1);
      const recipient = (
        await pool.query(
          'SELECT id FROM "WhatsappCampaignRecipient" WHERE "campaignId"=$1 AND status=\'SENT\'',
          [id],
        )
      ).rows[0].id;
      await pool.query(
        "UPDATE \"WhatsappCampaignRecipient\" SET status='QUEUED' WHERE id=$1",
        [recipient],
      );
      assert.equal(await processQueuedCampaignRecipients(pool, 1, options), 1);
      assert.equal(sent.length, 1);
      rejectSend = true;
      assert.equal(await processQueuedCampaignRecipients(pool, 1, options), 1);
      assert.equal(sent.length, 2);
      const finished = (await getCampaignSummary(pool, "org", id)).campaign;
      assert.equal(finished.status, "COMPLETED");
      assert.equal(finished.sent_count, 1);
      assert.equal(finished.blocked_count, 1);
      assert.equal(
        (
          await pool.query(
            'SELECT COUNT(*)::integer AS count FROM "WhatsappSendEvent"',
          )
        ).rows[0].count,
        2,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT COUNT(*)::integer AS count FROM "UsageEvent"',
          )
        ).rows[0].count,
        1,
      );
      assert.ok(
        (
          await pool.query(
            "SELECT COUNT(*)::integer AS count FROM analytics_outbox",
          )
        ).rows[0].count >= 3,
      );
      assert.ok(events.length > 0);
      await assert.rejects(
        retryFailedCampaign(pool, "org", id, options),
        /no failed recipients/,
      );
      await cancelCampaign(pool, "user", "org", id, options);
      await deleteCampaign(pool, "org", id);
      await renameContactList(pool, "org", "vip", "new-label");
      assert.equal(
        (await listContacts(pool, "org", {})).lists[0].label,
        "new-label",
      );
      await deleteContactList(pool, "org", "new-label");
      assert.equal((await listContacts(pool, "org", {})).contacts.length, 0);
    } finally {
      if (enforcement === undefined)
        delete process.env.KASITEK_BILLING_ENFORCEMENT;
      else process.env.KASITEK_BILLING_ENFORCEMENT = enforcement;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
