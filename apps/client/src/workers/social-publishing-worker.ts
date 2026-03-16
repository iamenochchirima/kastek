import { processDueSocialPublishJobs } from "../lib/social/publish-service";

const pollIntervalMs = Number(process.env.SOCIAL_PUBLISH_POLL_INTERVAL_MS || "10000");
const batchSize = Number(process.env.SOCIAL_PUBLISH_BATCH_SIZE || "10");

let running = true;

async function loop() {
  while (running) {
    try {
      const processed = await processDueSocialPublishJobs(batchSize);
      if (processed > 0) {
        console.log(`[social-publishing-worker] processed=${processed}`);
      }
    } catch (error) {
      console.error("[social-publishing-worker] iteration failed", error);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

void loop();

process.on("SIGTERM", () => {
  running = false;
  process.exit(0);
});

process.on("SIGINT", () => {
  running = false;
  process.exit(0);
});

