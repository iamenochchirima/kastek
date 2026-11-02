import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { ConnectionVault } from "../src/infrastructure/vault";
import { ModelCredentialVault } from "../src/infrastructure/model-credential-vault";
import { ModelProviderStore } from "../src/product/model-providers/store";
import { builtinProviderRegistry } from "../src/adapters/models/registry";

const vault = new ModelCredentialVault(new ConnectionVault("fixture", { fixture: randomBytes(32).toString("base64") }));
export function fixtureModelProviders(pool: Pool) { return new ModelProviderStore(pool, vault); }
/** Explicit test account setup. No deployment key, live request or runtime fallback. */
export async function connectFixtureModel(pool: Pool, accountId: string, organizationId: string, modelId = "nvidia/nemotron-3-super-120b-a12b", supportedParameters: string[] = ["tools"]) {
  const store = new ModelProviderStore(pool, vault, builtinProviderRegistry, { discoveryFetch: async () => ({ status: 200,
    body: JSON.stringify({ data: [{ id: modelId, name: "Fixture model", context_length: 262144,
      top_provider: { max_completion_tokens: 32768 }, supported_parameters: supportedParameters,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } }] }) }) });
  const scope = { accountId, organizationId };
  const connection = await store.create(scope, { providerId: "openrouter", name: "Fixture", apiKey: "fixture-model-key" });
  await store.refreshModels(scope, connection.id, connection.revision);
  const prior = await store.getDefault(scope);
  await store.setDefault(scope, { connectionId: connection.id, modelId, expectedRevision: prior.revision });
  return { store, scope, connection, modelId };
}
