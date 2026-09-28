import type { ModelProvider } from "./types";
import { MODEL_PROVIDER_DEFINITIONS } from "./providers";

export type CredentialVerificationCode = "credential_rejected" | "verification_unavailable";

export interface CredentialVerificationInput {
  provider: ModelProvider;
  apiKey: string;
}

export interface CredentialVerificationResult {
  provider: ModelProvider;
  status: "verified";
  verifiedAt: string;
}

export class CredentialVerificationError extends Error {
  public constructor(
    message: string,
    public readonly code: CredentialVerificationCode,
    public readonly statusCode: 422 | 503,
  ) {
    super(message);
    this.name = "CredentialVerificationError";
  }
}

export type CredentialVerificationFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const VERIFICATION_TIMEOUT_MS = 10_000;

function verificationRequest(provider: ModelProvider, apiKey: string): { url: string; init: RequestInit } {
  const definition = MODEL_PROVIDER_DEFINITIONS[provider];
  if (definition.verificationAuth === "bearer") {
    return { url: definition.verificationUrl, init: { headers: { authorization: `Bearer ${apiKey}` } } };
  }
  if (definition.verificationAuth === "gemini-query") {
    // Gemini's API-key contract requires the key in the query string. Do not
    // include this URL in logs or error messages.
    return { url: `${definition.verificationUrl}?key=${encodeURIComponent(apiKey)}`, init: {} };
  }
  return {
    url: definition.verificationUrl,
    init: { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } },
  };
}

function rejected(provider: ModelProvider): CredentialVerificationError {
  return new CredentialVerificationError(
    `${provider} rejected this credential`,
    "credential_rejected",
    422,
  );
}

function unavailable(): CredentialVerificationError {
  return new CredentialVerificationError(
    "The provider could not verify this credential right now",
    "verification_unavailable",
    503,
  );
}

/**
 * Verify a provider key without persisting it. The provider-specific endpoint
 * is intentionally a read-only metadata request; it validates the key while
 * avoiding a model invocation or billable effect.
 */
export async function verifyProviderCredential(
  input: CredentialVerificationInput,
  fetcher: CredentialVerificationFetcher = fetch,
): Promise<CredentialVerificationResult> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw rejected(input.provider);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFICATION_TIMEOUT_MS);
  try {
    const request = verificationRequest(input.provider, apiKey);
    const response = await fetcher(request.url, {
      ...request.init,
      method: "GET",
      signal: controller.signal,
    });
    // Do not parse provider bodies: they may contain account/model metadata
    // and are not needed to decide whether the credential is usable.
    await response.body?.cancel();
    if (response.ok) {
      return { provider: input.provider, status: "verified", verifiedAt: new Date().toISOString() };
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw rejected(input.provider);
    }
    throw unavailable();
  } catch (error) {
    if (error instanceof CredentialVerificationError) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timeout);
  }
}
