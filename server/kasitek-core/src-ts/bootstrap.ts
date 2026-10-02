import { config as loadEnvironment } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** Initialize instrumentations before loading Fastify, pg, Redis or provider clients. */
export async function boot(): Promise<void> {
  if (
    loadEnvironment({
      path: fileURLToPath(new URL("../.env", import.meta.url)),
    }).error
  )
    loadEnvironment();
  process.env.TZ = "UTC";
  const { initTelemetry } = await import("@kasitek/server-support/telemetry");
  const telemetry = initTelemetry("kasitek-core");
  let closing: Promise<void> | undefined;
  const shutdownTelemetry = () => (closing ??= telemetry.shutdown());
  try {
    const { start } = await import("./main.js");
    await start({ shutdownTelemetry });
  } catch (error) {
    await shutdownTelemetry();
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  boot().catch(() => {
    console.error(
      "Core startup failed. Check service configuration and database availability.",
    );
    process.exitCode = 1;
  });
}
