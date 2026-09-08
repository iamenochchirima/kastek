import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const required = {
  AGENTS_DATABASE_URL: "postgres://localhost/agents",
  TEMPORAL_ENABLED: "true",
  NODE_ENV: "production",
  AUTH_MODE: "hmac",
  INTERNAL_AUTH_SECRET: "secret",
};

describe("agent runtime configuration", () => {
  it("requires the credential for the selected KasiAi provider in production", () => {
    expect(() => loadConfig(required)).toThrow("OPENROUTER_API_KEY");
    expect(loadConfig({ ...required, OPENROUTER_API_KEY: "key", INSTALLATION_TOKEN_PRIVATE_KEY: "test-key" }).KASIAI_MODEL_PROVIDER).toBe("openrouter");
  });

  it("validates the selected provider credential rather than unrelated keys", () => {
    expect(() => loadConfig({ ...required, KASIAI_MODEL_PROVIDER: "anthropic", OPENROUTER_API_KEY: "key" })).toThrow("ANTHROPIC_API_KEY");
  });

  it("allows delegation-only core authentication", () => {
    const config = loadConfig({
      ...required,
      OPENROUTER_API_KEY: "key",
      INSTALLATION_TOKEN_PRIVATE_KEY: "test-key",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_DELEGATION_PRIVATE_KEY: "delegation-key",
    });
    expect(config.KASITEK_CORE_INTERNAL_TOKEN).toBeUndefined();
  });

  it("keeps the 2026 stateless path off by default in production and explicit in rollout", () => {
    const production = loadConfig({
      ...required,
      OPENROUTER_API_KEY: "key",
      INSTALLATION_TOKEN_PRIVATE_KEY: "test-key",
    });
    expect(production.MCP_STATELESS_ENABLED).toBe(false);
    const enabled = loadConfig({
      ...required,
      OPENROUTER_API_KEY: "key",
      INSTALLATION_TOKEN_PRIVATE_KEY: "test-key",
      MCP_STATELESS_ENABLED: "true",
    });
    expect(enabled.MCP_STATELESS_ENABLED).toBe(true);
  });

  it("keeps the memory-v2 path enabled by default but provides an explicit rollback switch", () => {
    const enabled = loadConfig({
      ...required,
      OPENROUTER_API_KEY: "key",
      INSTALLATION_TOKEN_PRIVATE_KEY: "test-key",
    });
    expect(enabled.MEMORY_V2_ENABLED).toBe(true);
    const disabled = loadConfig({
      ...required,
      OPENROUTER_API_KEY: "key",
      INSTALLATION_TOKEN_PRIVATE_KEY: "test-key",
      MEMORY_V2_ENABLED: "false",
    });
    expect(disabled.MEMORY_V2_ENABLED).toBe(false);
  });
});
