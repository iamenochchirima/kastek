import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src-ts/config.js";
import { installPgTimestampParsers } from "../src-ts/db.js";
import { apiJson } from "../src-ts/json.js";
import { decryptSocialSecret } from "../src-ts/integrations/crypto.js";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import {
  addWhatsappCapabilityChecks,
  mapQualityRating,
  estimateDailyLimit,
  connectManualConnection,
  completeEmbeddedSignup,
  listWhatsappConnections,
  whatsappConnectionHealth,
  refreshWhatsappConnection,
  updateWhatsappAccessToken,
} from "../src-ts/services/whatsapp/connections.js";
import { getConnectionRowForOrg } from "../src-ts/services/whatsapp/common.js";

test("WhatsApp quality tiers and permission evidence keep inbound and outbound capabilities distinct", () => {
  assert.equal(mapQualityRating("yellow"), "YELLOW");
  assert.equal(mapQualityRating("unrecognized"), "UNKNOWN");
  assert.equal(estimateDailyLimit("tier_2"), 10000);
  assert.equal(estimateDailyLimit("unlimited"), null);
  assert.deepEqual(
    addWhatsappCapabilityChecks(["whatsapp_business_messaging"], false, true)
      ?.capabilityChecks,
    {
      MESSAGING_INBOUND: false,
      MESSAGING_OUTBOUND: true,
      MEDIA_PUBLISH: false,
    },
  );
  assert.equal(addWhatsappCapabilityChecks("uninspected", true, true), null);
});

test(
  "isolated WhatsApp setup, embedded signup, token refresh and health preserve provider facts and account isolation",
  { skip: !process.env.CORE_WHATSAPP_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const fixture = await isolatedDatabase(
      process.env.CORE_WHATSAPP_TEST_DATABASE_URL!,
      "whatsapp_connection_test",
      [
        "WhatsappConnection",
        "WhatsappTemplate",
        "ExternalConnection",
        "ExternalConnectionCapability",
        "ExternalConnectionPermission",
        "ExternalConnectionConsumer",
        "EmailConnection",
        "EmailInboxBinding",
        "SocialChannelConnection",
        "analytics_outbox",
      ],
    );
    const { pool } = fixture;
    const config = readConfig({
      DATABASE_URL: process.env.CORE_WHATSAPP_TEST_DATABASE_URL!,
      LOG_LEVEL: "silent",
      SOCIAL_TOKEN_ENCRYPTION_KEY: "synthetic-encryption-secret",
      AUTH_META_APP_ID: "app",
      AUTH_META_APP_SECRET: "secret",
    });
    const calls: string[] = [];
    let subscribed = true,
      valid = true;
    const options = {
      config,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const parsed = new URL(String(url));
        calls.push(parsed.pathname);
        const body = (value: unknown, status = 200) =>
          new Response(JSON.stringify(value), {
            status,
            headers: { "content-type": "application/json" },
          });
        if (parsed.pathname.endsWith("/debug_token"))
          return body({
            data: {
              is_valid: true,
              scopes: [
                "whatsapp_business_messaging",
                "whatsapp_business_management",
              ],
            },
          });
        if (parsed.pathname.endsWith("/oauth/access_token")) {
          return parsed.searchParams.has("grant_type")
            ? body({ error: { message: "Optional long exchange failed" } }, 400)
            : body({ access_token: "synthetic-provider-token" });
        }
        if (parsed.pathname.endsWith("/me/businesses"))
          return body({
            data: [{ owned_whatsapp_business_accounts: [{ id: "waba" }] }],
          });
        if (parsed.pathname.endsWith("/phone_numbers"))
          return body({
            data: [{ id: "phone-two", display_phone_number: "+27222222222" }],
          });
        if (parsed.pathname.endsWith("/subscribed_apps")) {
          if (init?.method === "POST")
            return subscribed
              ? body({ success: true })
              : body({ error: { message: "Subscription denied" } }, 400);
          return body({ data: subscribed ? [{ id: "app" }] : [] });
        }
        if (parsed.pathname.endsWith("/message_templates"))
          return body({ data: [] });
        if (/\/phone(?:-two)?$/.test(parsed.pathname))
          return valid
            ? body({
                id: parsed.pathname.split("/").at(-1),
                display_phone_number: "+27111111111",
                verified_name: "Verified name",
                quality_rating: "GREEN",
                code_verification_status: "VERIFIED",
                messaging_limit_tier: "TIER_2",
              })
            : body({ error: { message: "Invalid token" } }, 400);
        throw new Error(`Unexpected fixture path ${parsed.pathname}`);
      }) as typeof fetch,
    };
    try {
      const connected = await connectManualConnection(
        pool,
        "user",
        "org",
        "waba",
        "phone",
        "synthetic-provider-token",
        " Manual label ",
        options,
      );
      assert.equal(connected.webhookSubscribed, true);
      assert.equal(connected.connection.phoneDisplayNumber, "Manual label");
      assert.equal(connected.connection.dailyLimitEstimate, 10000);
      assert.ok(!apiJson(connected).includes("synthetic-provider-token"));
      const id = connected.connection.id;
      const stored = (
        await pool.query(
          'SELECT "accessTokenEncrypted","providerPermissions" FROM "WhatsappConnection" WHERE id=$1',
          [id],
        )
      ).rows[0];
      assert.equal(
        decryptSocialSecret(config, stored.accessTokenEncrypted),
        "synthetic-provider-token",
      );
      assert.equal(
        stored.providerPermissions.capabilityChecks.MESSAGING_INBOUND,
        true,
      );
      await assert.rejects(
        connectManualConnection(
          pool,
          "other",
          "other-org",
          "waba",
          "phone",
          "synthetic-provider-token",
          null,
          options,
        ),
        /another account/,
      );
      assert.equal(
        (await listWhatsappConnections(pool, "other-org")).length,
        0,
      );
      const embedded = await completeEmbeddedSignup(
        pool,
        "user",
        "org",
        "code",
        null,
        null,
        options,
      );
      assert.equal(embedded.connection.phoneNumberId, "phone-two");
      assert.equal(embedded.diagnostics.length, 3);
      const refreshed = await refreshWhatsappConnection(
        pool,
        "org",
        id,
        options,
      );
      assert.equal(refreshed.connection.phoneDisplayNumber, "Verified name");
      assert.equal(
        (await whatsappConnectionHealth(pool, "org", id, options)).healthy,
        true,
      );
      subscribed = false;
      const changed = await updateWhatsappAccessToken(
        pool,
        "org",
        id,
        "synthetic-rotated-token",
        options,
      );
      assert.equal(changed.webhookSubscribed, false);
      assert.equal(changed.webhookError, "Subscription denied");
      assert.equal(
        (await whatsappConnectionHealth(pool, "org", id, options)).healthy,
        false,
      );
      valid = false;
      const invalid = await whatsappConnectionHealth(pool, "org", id, options);
      assert.equal(invalid.tokenValid, false);
      assert.equal(invalid.steps.length, 1);
      await pool.query(
        `UPDATE "ExternalConnection" SET status='REVOKED' WHERE id=$1`,
        [`ext_${id}`],
      );
      await assert.rejects(
        getConnectionRowForOrg(pool, "org", id),
        /not active/,
      );
      await assert.rejects(
        refreshWhatsappConnection(pool, "other-org", id, options),
        /Connection not found/,
      );
      assert.ok(calls.includes("/v19.0/phone"));
    } finally {
      await fixture.close();
    }
  },
);
