import { describe, expect, it, vi } from "vitest";
import { EnvironmentCredentialResolver, ModelCredentialMissingError } from "../src/model/credentials";
import { modelCredentialFailureResult } from "../src/runtime/model-credential-failure";

describe("missing backend model credentials", () => {
  it("returns an actionable terminal run result when the backend key is empty", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "  ");
    try {
      await expect(new EnvironmentCredentialResolver().resolve("openrouter"))
        .rejects.toBeInstanceOf(ModelCredentialMissingError);
    } finally {
      vi.unstubAllEnvs();
    }

    const result = modelCredentialFailureResult(new ModelCredentialMissingError("openrouter"));

    expect(result).toMatchObject({
      status: "failed",
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      iterations: 0,
      toolCalls: 0,
      error: {
        code: "MODEL_CREDENTIAL_MISSING",
        failureClass: "terminal",
        userMessage: expect.stringContaining("OpenRouter is not configured"),
        remediation: expect.stringContaining("OPENROUTER_API_KEY"),
      },
    });
    expect(result.error).not.toHaveProperty("apiKey");
  });
});
