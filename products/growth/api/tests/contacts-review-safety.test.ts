import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { apiJson, canonicalJson } from "@kasitek-labs/server-support/json";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { updateAgentContact } from "../src/services/whatsapp/contacts.js";
import { installPgTimestampParsers } from "../src/db.js";

const database = process.env.CORE_SOCIAL_RECOVERY_TEST_DATABASE_URL;
test("reviewed list contact updates lock both membership and contact and roll back failed domain changes", { skip: !database }, async () => {
  installPgTimestampParsers();
  const db = await isolatedDatabase(database!, "contact_review_safety", ["WhatsappContact", "WhatsappContactListMembership", "Customer", "CustomerIdentity"]);
  try {
    await db.pool.query(`INSERT INTO "WhatsappContact"(id,"userId","orgId",phone,tags,"updatedAt") VALUES('contact','user','org','+263771234567','{}',now())`);
    await db.pool.query(`INSERT INTO "WhatsappContactListMembership"(id,"userId","orgId","contactId",tags,"updatedAt") VALUES('membership','user','org','contact','{}',now())`);
    const snapshot = async () => {
      const row = (await db.pool.query(`SELECT m."updatedAt" AS "membershipRevision",c."updatedAt" AS "contactRevision" FROM "WhatsappContactListMembership" m JOIN "WhatsappContact" c ON c.id=m."contactId" AND c."orgId"=m."orgId" WHERE m.id='membership'`)).rows[0];
      return createHash("sha256").update(canonicalJson(JSON.parse(apiJson(row)))).digest("hex");
    };
    const initial = await snapshot();
    const other = await db.pool.connect();
    await other.query('BEGIN');
    await other.query(`SELECT id FROM "WhatsappContactListMembership" WHERE id='membership' FOR UPDATE`);
    const pending = updateAgentContact(db.pool, "org", "membership", { full_name: "Should reject" }, "request-first", { expectedSnapshot: initial });
    const rejection = assert.rejects(pending, /reviewed contact changed/);
    await other.query(`UPDATE "WhatsappContactListMembership" SET notes='Concurrent edit',"updatedAt"=now()+interval '1 millisecond' WHERE id='membership'`);
    await other.query('COMMIT');
    other.release();
    await rejection;
    assert.equal((await db.pool.query(`SELECT "fullName" FROM "WhatsappContactListMembership" WHERE id='membership'`)).rows[0].fullName, null);
    const beforeContactChange = await snapshot();
    await db.pool.query(`UPDATE "WhatsappContact" SET "updatedAt"=now()+interval '1 millisecond' WHERE id='contact'`);
    await assert.rejects(updateAgentContact(db.pool, "org", "membership", { full_name: "Should reject" }, "request-second", { expectedSnapshot: beforeContactChange }), /reviewed contact changed/);
    const approved = await updateAgentContact(db.pool, "org", "membership", { full_name: "Approved" }, "request-third", { expectedSnapshot: await snapshot() });
    assert.equal(approved.contact.fullName, "Approved");
    assert.equal(approved.contact.metadata?._kasitek_agent_contact_update_idempotency_key, undefined);
    const receiptRevision = await snapshot();
    await updateAgentContact(db.pool, "org", "membership", { full_name: "Approved" }, "request-third", { expectedSnapshot: beforeContactChange });
    assert.equal(await snapshot(), receiptRevision);
    await updateAgentContact(db.pool, "org", "membership", { full_name: "Next approved" }, "request-fourth", { expectedSnapshot: receiptRevision });
    await db.pool.query(`INSERT INTO "WhatsappContactListMembership"(id,"userId","orgId","contactId","listLabel",tags,"updatedAt") VALUES('second-membership','user','org','contact','duplicate','{}',now())`);
    await assert.rejects(updateAgentContact(db.pool, "org", "membership", { phone: "+263771234568", list_label: "duplicate" }, "request-fifth", { expectedSnapshot: await snapshot() }), /already in that list/);
    assert.equal((await db.pool.query(`SELECT phone FROM "WhatsappContact" WHERE id='contact'`)).rows[0].phone, "+263771234567");
    assert.equal((await db.pool.query(`SELECT metadata->>'_kasitek_agent_contact_update_idempotency_key' AS receipt FROM "WhatsappContactListMembership" WHERE id='membership'`)).rows[0].receipt, "request-fourth");
  } finally { await db.close(); }
});
