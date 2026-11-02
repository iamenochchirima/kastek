import { z } from "zod";
import { canonicalJson, PlatformError } from "../contracts/contracts";
import { modelEndpointSchema, modelProtocolSchema } from "../contracts/model-providers";
import { ConnectionVault, type SecretEnvelope } from "./vault";

const contextSchema = z.strictObject({ organizationId: z.uuid(), connectionId: z.uuid(),
  credentialRevision: z.number().int().positive(), endpoint: modelEndpointSchema, protocol: modelProtocolSchema });
export type ModelCredentialContext = z.infer<typeof contextSchema>;
export const modelApiKeySchema = z.string().min(1).refine(value => Buffer.byteLength(value) <= 4096 && !/[\u0000-\u0020\u007f]/.test(value),
  "API key must fit the credential header and contain no whitespace or control characters");

/** Domain separation prevents a tool-connection envelope from becoming a model credential. */
export class ModelCredentialVault {
  constructor(private readonly vault: ConnectionVault) {}
  private reference(context: ModelCredentialContext): string {
    const parsed = contextSchema.parse(context);
    return canonicalJson({ domain: "model-provider-credential-v1", connectionId: parsed.connectionId,
      endpoint: parsed.endpoint, protocol: parsed.protocol });
  }
  seal(context: ModelCredentialContext, apiKey: string): SecretEnvelope {
    const secret = canonicalJson({ domain: "model-provider-credential-v1", apiKey: modelApiKeySchema.parse(apiKey) });
    return this.vault.seal(context.organizationId, this.reference(context), context.credentialRevision, secret, 65536);
  }
  open(context: ModelCredentialContext, envelope: SecretEnvelope): string {
    try {
      const parsed = z.strictObject({ domain: z.literal("model-provider-credential-v1"), apiKey: modelApiKeySchema })
        .parse(JSON.parse(this.vault.open(context.organizationId, this.reference(context), context.credentialRevision, envelope)));
      return parsed.apiKey;
    } catch {
      throw new PlatformError("MODEL_CREDENTIAL_UNAVAILABLE", 503, "Model credential is unavailable");
    }
  }
}
