import "../telemetry";
import { shutdownTelemetry } from "../telemetry";
import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { ChannelCredentialRepository } from "../db/repositories/channel-credential-repository";
import { ChannelRepository } from "../db/repositories/channel-repository";
import { DiscordGatewaySupervisor } from "./gateway";
import { operationalLogger } from "../telemetry/logger";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.DISCORD_GATEWAY_ENABLED) {
    operationalLogger.info({ event: "discord_gateway.disabled", reason: "feature_disabled" }, "Discord gateway disabled");
    await shutdownTelemetry();
    return;
  }
  if (!config.INTERNAL_AUTH_SECRET) throw new Error("INTERNAL_AUTH_SECRET is required for the Discord Gateway");
  const pool = createPool(config);
  const supervisor = new DiscordGatewaySupervisor(
    new ChannelRepository(pool),
    new ChannelCredentialRepository(pool, config.AGENTS_CREDENTIAL_ENCRYPTION_KEY),
    config,
  );
  await supervisor.start();
  const close = async (): Promise<void> => {
    await supervisor.stop();
    await pool.end();
    await shutdownTelemetry();
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  operationalLogger.info({ event: "discord_gateway.started" }, "Discord gateway started");
}

main().catch((error) => {
  operationalLogger.error({ err: error, event: "discord_gateway.startup_failed" }, "Discord gateway startup failed");
  void shutdownTelemetry().finally(() => { process.exitCode = 1; });
});
