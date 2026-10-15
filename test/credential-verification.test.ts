import { describe, expect, it, vi } from "vitest";
import { CredentialVerificationError, verifyProviderCredential } from "../src/model/credential-verification";

function response(status: number): Response {
  return new Response(null, { status });
}

describe("provider credential verification", () => {
  it.each([
    ["openrouter", "https://openrouter.ai/api/v1/models", "authorization"],
    ["openai", "https://api.openai.com/v1/models", "authorization"],
    ["anthropic", "https://api.anthropic.com/v1/models", "x-api-key"],
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/models?key=secret-key", undefined],
    ["deepseek", "https://api.deepseek.com/models", "authorization"],
    ["glm", "https://api.z.ai/api/paas/v4/models", "authorization"],
    ["kimi", "https://api.moonshot.ai/v1/models", "authorization"],
    ["minimax", "https://api.minimaxi.com/anthropic/v1/models", "x-api-key"],
    ["xai", "https://api.x.ai/v1/models", "authorization"],
    ["opencode_go", "https://opencode.ai/zen/go/v1/models", "authorization"],
    ["opencode_zen", "https://opencode.ai/zen/v1/models", "authorization"],
  ] as const)("uses the read-only %s verification endpoint", async (provider, expectedUrl, secretHeader) => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(expectedUrl);
      expect(init?.method).toBe("GET");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      if (secretHeader) expect(headers.get(secretHeader)).toContain("secret-key");
      return response(200);
    });

    const result = await verifyProviderCredential({ provider, apiKey: " secret-key " }, fetcher);
    expect(result).toMatchObject({ provider, status: "verified" });
    expect(result.verifiedAt).toEqual(expect.any(String));
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("rejects invalid provider credentials without exposing provider response data", async () => {
    const fetcher = vi.fn(async () => response(401));
    await expect(verifyProviderCredential({ provider: "openai", apiKey: "secret-key" }, fetcher)).rejects.toMatchObject({
      code: "credential_rejected",
      statusCode: 422,
      message: "openai rejected this credential",
    });
    await expect(verifyProviderCredential({ provider: "openai", apiKey: "secret-key" }, fetcher)).rejects.not.toThrow("secret-key");
  });

  it("fails closed when the provider is unavailable or the request times out", async () => {
    const fetcher = vi.fn(async () => response(503));
    await expect(verifyProviderCredential({ provider: "gemini", apiKey: "secret-key" }, fetcher)).rejects.toMatchObject({
      code: "verification_unavailable",
      statusCode: 503,
    });

    const networkFailure = vi.fn(async () => {
      throw new Error("secret-key leaked by provider");
    });
    const error = await verifyProviderCredential({ provider: "openrouter", apiKey: "secret-key" }, networkFailure).catch((cause) => cause);
    expect(error).toBeInstanceOf(CredentialVerificationError);
    expect(error).toMatchObject({ code: "verification_unavailable", statusCode: 503 });
    expect(error.message).not.toContain("secret-key");
  });
});
