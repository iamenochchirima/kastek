import { SerdeFloat } from "@kasitek-labs/server-support/json";
import { nativeRedisFixture } from "./helpers/redis-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import type { FastifyRequest } from "fastify";
import type { CoreContext } from "../src/context.js";
import { readConfig } from "../src/config.js";
import {
  claimDelegationReplay,
  resolveDelegation,
} from "../src/identity/internal-delegation.js";
import {
  createPubsub,
  createRealtimeStream,
  publishInboxEvent,
  enqueueWhatsappInboxMessage,
  drainWhatsappInboxQueue,
  buildInboxOrgChannel,
} from "../src/services/realtime.js";
const core = (url: string) =>
  ({
    config: readConfig({
      DATABASE_URL: "postgresql://fixture",
      REDIS_URL: url,
    }),
  }) as CoreContext;
test(
  "Native Redis atomically prevents delegated replay, scopes issuer keys and fails closed on authentication/outage",
  { skip: !process.env.CORE_REDIS_TEST_BINARY },
  async () => {
    const fixture = await nativeRedisFixture();
    try {
      const context = core(fixture.url),
        claims = await Promise.all(
          Array.from({ length: 12 }, () =>
            claimDelegationReplay(context, "issuer", "race"),
          ),
        );
      assert.equal(claims.filter(Boolean).length, 1);
      assert(
        (await fixture.inspector.pTTL("agents:delegation:issuer:race")) >
          120000,
      );
      assert.equal(
        await claimDelegationReplay(context, "other-issuer", "race"),
        true,
      );
      const keys = await generateKeyPair("ES256"),
        publicKey = await exportSPKI(keys.publicKey),
        now = Math.floor(Date.now() / 1000);
      context.config.env.AGENTS_DELEGATION_PUBLIC_KEY = publicKey;
      const token = await new SignJWT({
        organizationId: "org",
        installationId: "installation",
        capability: "customer_get",
        capabilityVersion: "1",
        runId: "run",
        invocationId: "invoke",
        correlationId: "correlation",
      })
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer("kasitek-agents")
        .setAudience("kasitek-core-internal")
        .setSubject("installation")
        .setJti("signed-once")
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .sign(keys.privateKey);
      const request = {
        headers: { authorization: "Bearer " + token },
      } as FastifyRequest;
      assert.equal(
        (await resolveDelegation(request, context)).organizationId,
        "org",
      );
      await assert.rejects(
        () => resolveDelegation(request, context),
        (error) => (error as { status: number }).status === 401,
      );
      await assert.rejects(
        () =>
          claimDelegationReplay(
            core(fixture.url.replace("fixture-password", "incorrect-password")),
            "issuer",
            "auth-failure",
          ),
        (error) => (error as { status: number }).status === 401,
      );
      await assert.rejects(
        () =>
          claimDelegationReplay(
            core("redis://127.0.0.1:1"),
            "issuer",
            "outage",
          ),
        (error) => (error as { status: number }).status === 401,
      );
      assert.equal(
        await fixture.inspector.exists("agents:delegation:issuer:auth-failure"),
        0,
      );
    } finally {
      await fixture.close();
    }
  },
);
test(
  "Native Redis realtime isolates organization channels, owns subscriber cleanup and drains inbox FIFO",
  { skip: !process.env.CORE_REDIS_TEST_BINARY },
  async () => {
    const fixture = await nativeRedisFixture();
    let stream: ReturnType<typeof createRealtimeStream> | undefined;
    try {
      const context = core(fixture.url),
        client = await createPubsub(context);
      assert(client);
      stream = createRealtimeStream(client, buildInboxOrgChannel("org-a"));
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));
      stream.on("error", () => {});
      for (let attempt = 0; attempt < 100; attempt++) {
        const counts =
          await fixture.inspector.pubSubNumSub("whatsapp:org:org-a");
        if (counts["whatsapp:org:org-a"] === 1) break;
        await delay(10);
      }
      assert.equal(
        (await fixture.inspector.pubSubNumSub("whatsapp:org:org-a"))[
          "whatsapp:org:org-a"
        ],
        1,
      );
      await publishInboxEvent(context, "org-b", { type: "private-other" });
      await publishInboxEvent(context, "org-a", {
        type: "message.created",
        message: {
          id: "local-fixture",
          counter: 9007199254740993n,
          score: new SerdeFloat(1),
        },
      });
      for (
        let attempt = 0;
        attempt < 100 && !chunks.join("").includes("local-fixture");
        attempt++
      )
        await delay(10);
      assert(chunks.join("").startsWith("event: ready\ndata: {}\n\n"));
      assert.match(chunks.join(""), /data: \{[^\n]+\}\n\n/);
      assert.match(chunks.join(""), /"counter":9007199254740993/);
      assert.match(chunks.join(""), /"score":1\.0/);
      assert(!chunks.join("").includes("private-other"));
      await enqueueWhatsappInboxMessage(context, "first");
      await enqueueWhatsappInboxMessage(context, "second");
      await enqueueWhatsappInboxMessage(context, "third");
      assert.deepEqual(await drainWhatsappInboxQueue(context, 2), [
        "first",
        "second",
      ]);
      assert.deepEqual(await drainWhatsappInboxQueue(context, 2), ["third"]);
      assert.deepEqual(await drainWhatsappInboxQueue(context, 0), []);
      const closed = once(stream, "close");
      stream.destroy();
      await closed;
      assert.equal(client.isOpen, false);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          (await fixture.inspector.pubSubNumSub("whatsapp:org:org-a"))[
            "whatsapp:org:org-a"
          ] === 0
        )
          break;
        await delay(10);
      }
      assert.equal(
        (await fixture.inspector.pubSubNumSub("whatsapp:org:org-a"))[
          "whatsapp:org:org-a"
        ],
        0,
      );
      await assert.rejects(
        () =>
          publishInboxEvent(
            core(fixture.url.replace("fixture-password", "incorrect-password")),
            "org-a",
            {},
          ),
        (error) => (error as { status: number }).status === 500,
      );
    } finally {
      stream?.destroy();
      await fixture.close();
    }
  },
);
