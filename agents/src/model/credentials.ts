import type { ModelCredentials, ModelProvider } from "./types";
import type { CredentialVaultRepository } from "../db/repositories/credential-vault-repository";
import { MODEL_PROVIDER_DEFINITIONS } from "./providers";

export interface CredentialResolver {
  resolve(provider: ModelProvider, credentialReference?: string, organizationId?: string): Promise<ModelCredentials>;
}

/**
 * Local/Poc resolver. Production will replace this with a core-owned secret-manager adapter;
 * only the activity receives the secret, never a workflow input or model-visible message.
 */
export class EnvironmentCredentialResolver implements CredentialResolver {
  public async resolve(provider: ModelProvider, credentialReference?: string): Promise<ModelCredentials> {
    const apiKey = process.env[MODEL_PROVIDER_DEFINITIONS[provider].apiKeyEnv];
    if (!apiKey) throw new Error(`No ${provider} credential configured for reference ${credentialReference ?? "default"}`);
    return { apiKey, fundingSource: "kasitek", credentialReference };
  }
}

export class VaultCredentialResolver implements CredentialResolver {
  public constructor(
    private readonly vault: CredentialVaultRepository,
    private readonly fallback = new EnvironmentCredentialResolver(),
  ) {}

  public async resolve(provider: ModelProvider, credentialReference?: string, organizationId?: string): Promise<ModelCredentials> {
    if (credentialReference) {
      if (!organizationId) throw new Error("Organization scope is required for a credential reference");
      return this.vault.resolve(organizationId, provider, credentialReference);
    }
    return this.fallback.resolve(provider);
  }
}
