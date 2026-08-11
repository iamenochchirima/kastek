import type { ModelCredentials, ModelProvider } from "./types";

export interface CredentialResolver {
  resolve(provider: ModelProvider, credentialReference?: string): Promise<ModelCredentials>;
}

const environmentKeys: Record<ModelProvider, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

/**
 * Local/Poc resolver. Production will replace this with a core-owned secret-manager adapter;
 * only the activity receives the secret, never a workflow input or model-visible message.
 */
export class EnvironmentCredentialResolver implements CredentialResolver {
  public async resolve(provider: ModelProvider, credentialReference?: string): Promise<ModelCredentials> {
    const apiKey = process.env[environmentKeys[provider]];
    if (!apiKey) throw new Error(`No ${provider} credential configured for reference ${credentialReference ?? "default"}`);
    return { apiKey, fundingSource: "kasitek", credentialReference };
  }
}
