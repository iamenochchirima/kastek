import { SerdeFloat } from "@kasitek-labs/server-support/json";
import { nativeRedisFixture } from "./helpers/redis-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { CoreContext } from "../src/context.js";
import { readConfig } from "../src/config.js";
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
