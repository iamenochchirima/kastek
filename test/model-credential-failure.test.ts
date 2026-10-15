import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentCredentialResolver, ModelCredentialMissingError } from "../src/model/credentials";
import { MODEL_PROVIDER_DEFINITIONS } from "../src/model/providers";
import { MODEL_PROVIDERS } from "../src/model/types";
import { modelCredentialFailureResult } from "../src/runtime/model-credential-failure";

afterEach(() => vi.unstubAllEnvs());

describe("independent provider credentials", () => {
  it("assigns a different managed key name to each provider", () => {
    const keyNames = MODEL_PROVIDERS.map((provider) => MODEL_PROVIDER_DEFINITIONS[provider].apiKeyEnv);
    expect(new Set(keyNames).size).toBe(MODEL_PROVIDERS.length);
  });

  it.each(MODEL_PROVIDERS)("resolves only the %s key and reports that provider's setup error", async (provider) => {
    const definition = MODEL_PROVIDER_DEFINITIONS[provider];
    const providerIndex = MODEL_PROVIDERS.indexOf(provider);
    const otherProvider = MODEL_PROVIDERS[(providerIndex + 1) % MODEL_PROVIDERS.length]!;
    const otherKey = MODEL_PROVIDER_DEFINITIONS[otherProvider].apiKeyEnv;
    const resolver = new EnvironmentCredentialResolver();

    expect(otherKey).not.toBe(definition.apiKeyEnv);
    vi.stubEnv(definition.apiKeyEnv, "provider-specific-test-key");
    await expect(resolver.resolve(provider)).resolves.toMatchObject({
      apiKey: "provider-specific-test-key",
      fundingSource: "kasitek",
    });

    vi.stubEnv(definition.apiKeyEnv, "  ");
    vi.stubEnv(otherKey, "different-provider-test-key");
    await expect(resolver.resolve(provider)).rejects.toBeInstanceOf(ModelCredentialMissingError);

    const result = modelCredentialFailureResult(new ModelCredentialMissingError(provider));
    expect(result).toMatchObject({
      status: "failed",
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      iterations: 0,
      toolCalls: 0,
      error: {
        code: "MODEL_CREDENTIAL_MISSING",
        failureClass: "terminal",
        userMessage: expect.stringContaining(`${definition.label} is not configured`),
      },
    });
    expect(result.error.userMessage).toContain("Models settings");
    expect(result.error.userMessage).toContain("not interchangeable");
    expect(result.error.remediation).toContain(`${definition.label} key`);
    expect(result.error.remediation).toContain(definition.apiKeyEnv);
    expect(result.error).not.toHaveProperty("apiKey");
    expect(result.error.userMessage).not.toContain("different-provider-test-key");
  });
});
