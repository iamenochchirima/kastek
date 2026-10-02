import type { Pool } from "pg";
import type {
  PublicActionDefinition,
  PublicDomainAdapter,
} from "../services/public-api.js";
import type { ActionDefinition } from "../actions/index.js";
import { growthRegistry } from "../actions/index.js";
import * as content from "./content-adapter.js";
import * as bookings from "./core-adapter.js";
/** These mandatory bindings are supplied by the actual inbox/campaign/template domain services. */
export type PublicReadPorts = Pick<
  PublicDomainAdapter,
  | "listContacts"
  | "listInboxConversations"
  | "listInboxMessages"
  | "listCampaigns"
  | "getCampaignSummary"
  | "listTemplates"
>;
export function publicDefinition(
  definition: ActionDefinition,
): PublicActionDefinition {
  return {
    name: definition.id.name,
    version: definition.id.version,
    owningDomain: definition.owning_domain,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.input_schema,
    outputSchema: definition.output_schema,
    risk: definition.risk,
    approval: definition.approval,
    supportedRuntimes: definition.supported_runtimes,
    supportedActors: definition.supported_actors.filter(
      (
        actor,
      ): actor is
        | "direct_user"
        | "api_client"
        | "external_agent"
        | "native_agent" =>
        [
          "direct_user",
          "api_client",
          "external_agent",
          "native_agent",
        ].includes(actor),
    ),
    requiredGrants: definition.required_grants,
    requiredOAuthScopes: definition.required_oauth_scopes,
    requiredEntitlements: definition.required_entitlements,
    idempotency: definition.idempotency,
    dataClassification: definition.data_classification,
    audit: definition.audit,
    usage: definition.usage,
    lifecycle: definition.lifecycle,
  };
}
export function createPublicDomainAdapter(
  pool: Pool,
  reads: PublicReadPorts,
): PublicDomainAdapter {
  const registry = growthRegistry();
  return {
    ...reads,
    definitions: function* () {
      for (const definition of registry.definitions())
        yield publicDefinition(definition);
    },
    listContentPosts: (ctx) => content.listPosts(pool, ctx),
    getContentPost: async (ctx, id) =>
      ((await content.getPost(pool, ctx, id)) as unknown as Record<
        string,
        unknown
      >) ?? null,
    getContentActivity: async (ctx, id) =>
      ((await content.getPostActivity(pool, ctx, id)) as Record<
        string,
        unknown
      >) ?? null,
    createContentDraft: async (ctx, input) =>
      (await content.createDraft(pool, ctx, input)) as unknown as Record<
        string,
        unknown
      >,
    updateContentDraft: async (ctx, id, input) =>
      (await content.updateDraft(pool, ctx, id, input)) as unknown as Record<
        string,
        unknown
      >,
    listBookings: async (ctx) => ({
      bookings: await bookings.listBookings(pool, ctx),
    }),
  };
}
