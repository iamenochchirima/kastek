import type { AppConfig } from "../config";

export type DeveloperApiKeyScope = "api:read" | "api:write";

export interface DeveloperApiKeyIdentity {
  apiKeyId: string;
  organizationId: string;
  scopes: DeveloperApiKeyScope[];
}

export interface DeveloperApiKeyResolver {
  resolve(secret: string): Promise<DeveloperApiKeyIdentity | null>;
}

/**
 * Core remains the authority for Developer API keys. The Agent Platform only
 * asks the public Core principal endpoint to validate the bearer and receives
 * non-secret workspace metadata back.
 */
export class KasitekCoreDeveloperApiKeyResolver implements DeveloperApiKeyResolver {
  public constructor(private readonly config: AppConfig) {}

  public async resolve(secret: string): Promise<DeveloperApiKeyIdentity | null> {
    const baseUrl = this.config.KASITEK_CORE_URL?.replace(/\/$/, "");
    if (!baseUrl) throw Object.assign(new Error("Developer API-key validation is not configured"), { statusCode: 503 });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.KASITEK_CORE_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/v1/whoami`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${secret}`,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok) throw Object.assign(new Error(`Core returned ${response.status} while validating the Developer API key`), { statusCode: 503 });

      const payload = await response.json() as Partial<DeveloperApiKeyIdentity> & { principal?: unknown };
      if (
        payload.principal !== "workspace_api_key"
        || typeof payload.apiKeyId !== "string"
        || !payload.apiKeyId
        || typeof payload.organizationId !== "string"
        || !payload.organizationId
        || !Array.isArray(payload.scopes)
      ) return null;
      const scopes = payload.scopes.filter((scope): scope is DeveloperApiKeyScope => scope === "api:read" || scope === "api:write");
      return { apiKeyId: payload.apiKeyId, organizationId: payload.organizationId, scopes };
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw Object.assign(new Error("Core Developer API-key validation timed out"), { statusCode: 503 });
      }
      throw Object.assign(new Error("Core Developer API-key validation failed"), { statusCode: 503 });
    } finally {
      clearTimeout(timeout);
    }
  }
}
