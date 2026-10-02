import test from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { readConfig } from "../src-ts/config.js";
import {
  claimQueuedCampaignRecipient,
  recoverStuckProcessingCampaignRecipients,
} from "../src-ts/services/whatsapp/campaigns.js";
const database = process.env.CORE_WHATSAPP_RECOVERY_TEST_DATABASE_URL;
test(
  "competing campaign recovery and claims preserve active leases, paused recipients and future schedules",
  { skip: !database, timeout: 30000 },
  async () => {
    const db = await isolatedDatabase(
      database!,
      "campaign_recipient_recovery",
      ["WhatsappCampaign", "WhatsappCampaignRecipient"],
    );
    const options = {
      publishEvent: async () => {
        throw new Error("Unexpected fixture publication");
      },
      config: readConfig({
        DATABASE_URL: database!,
        WHATSAPP_CAMPAIGN_PROCESSING_TIMEOUT_SECONDS: "120",
      }),
    };
    try {
      await db.pool
        .query(`INSERT INTO "WhatsappCampaign"(id,"userId","orgId","connectionId",name,"templateName","templateLanguage",status,"updatedAt")
 VALUES('active','user','org','wa','Fixture','fixture','en','SENDING',NOW()),('paused','user','org','wa','Paused','fixture','en','PAUSED',NOW()),('future','user','org','wa','Future','fixture','en','SCHEDULED',NOW());
 UPDATE "WhatsappCampaign" SET "scheduledAt"=NOW()+INTERVAL '1 day' WHERE id='future';
 INSERT INTO "WhatsappCampaignRecipient"(id,"campaignId","contactId",status,"attemptCount","updatedAt") VALUES('active-recipient','active','contact','PROCESSING',1,NOW()-INTERVAL '60 seconds'),('paused-recipient','paused','paused-contact','PROCESSING',1,NOW()-INTERVAL '5 minutes'),('future-recipient','future','future-contact','QUEUED',0,NOW())`);
      const paused = await recoverStuckProcessingCampaignRecipients(
        db.pool,
        options,
      );
      assert.deepEqual(
        paused.map((row) => row.recipientId),
        ["paused-recipient"],
      );
      assert.equal(
        (
          await db.pool.query(
            "SELECT status FROM \"WhatsappCampaignRecipient\" WHERE id='paused-recipient'",
          )
        ).rows[0].status,
        "PENDING",
      );
      assert.equal(
        await claimQueuedCampaignRecipient(db.pool, "paused-recipient"),
        false,
      );
      assert.equal(
        await claimQueuedCampaignRecipient(db.pool, "future-recipient"),
        false,
      );
      assert.equal(
        (
          await db.pool.query(
            "SELECT status FROM \"WhatsappCampaignRecipient\" WHERE id='active-recipient'",
          )
        ).rows[0].status,
        "PROCESSING",
      );
      await db.pool.query(
        "UPDATE \"WhatsappCampaignRecipient\" SET \"updatedAt\"=NOW()-INTERVAL '5 minutes' WHERE id='active-recipient'",
      );
      const recovered = await Promise.all(
        Array.from({ length: 6 }, () =>
          recoverStuckProcessingCampaignRecipients(db.pool, options),
        ),
      );
      assert.equal(recovered.flat().length, 1);
      const claims = await Promise.all(
        Array.from({ length: 6 }, () =>
          claimQueuedCampaignRecipient(db.pool, "active-recipient"),
        ),
      );
      assert.equal(claims.filter(Boolean).length, 1);
      const recipient = (
        await db.pool.query(
          'SELECT status,"attemptCount","lastAttemptAt" IS NOT NULL AS attempted FROM "WhatsappCampaignRecipient" WHERE id=\'active-recipient\'',
        )
      ).rows[0];
      assert.deepEqual(recipient, {
        status: "PROCESSING",
        attemptCount: 2,
        attempted: true,
      });
      assert.equal(
        (await recoverStuckProcessingCampaignRecipients(db.pool, options))
          .length,
        0,
      );
    } finally {
      await db.close();
    }
  },
);
