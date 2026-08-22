import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { ChannelCredentialRepository } from "../db/repositories/channel-credential-repository";
import { ChannelRepository } from "../db/repositories/channel-repository";
import { DiscordGatewaySupervisor } from "./gateway";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.DISCORD_GATEWAY_ENABLED) {
    console.log("Discord Gateway is disabled; set DISCORD_GATEWAY_ENABLED=true to start it.");
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
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  console.log("Kasitek Discord Gateway is listening for active Discord channel connections.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
