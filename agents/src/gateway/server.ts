import { z } from "zod";
import { buildGateway } from "./app";

const config = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GATEWAY_HOST: z.string().default("0.0.0.0"),
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(4200),
  AGENT_PLATFORM_URL: z.string().url().default("http://127.0.0.1:4100"),
  AGENT_GATEWAY_SHARED_SECRET: z.string().optional(),
}).parse(process.env);

const app = buildGateway({ agentPlatformUrl: config.AGENT_PLATFORM_URL, sharedSecret: config.AGENT_GATEWAY_SHARED_SECRET });

app.listen({ host: config.GATEWAY_HOST, port: config.GATEWAY_PORT }).catch((error) => {
  app.log.error(error);
  process.exitCode = 1;
});
