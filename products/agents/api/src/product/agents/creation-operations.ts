import { z } from "zod";
import type { Pool } from "pg";
import { agentConfigurationSchema, defaultBusinessConfiguration, type AgentConfiguration } from "../../contracts/contracts";
import { applyCustomerSetup, customerConfigurationForSetup, customerSetupSchema, type CustomerSetup } from "../offerings/customer-setup";
import type { PlatformStore } from "./store";
import { customerSetupReadiness } from "./setup-readiness";
import { agentAvatarSchema } from "./avatars";
import { setupUpdatedLayers } from "./identity";
type CreationScope = { accountId: string; organizationId: string };

const nameSchema = z.string().trim().min(1).max(120);
const createSchema = z.strictObject({ name: nameSchema, offering: z.literal("customer-service").optional(),
 purpose: z.string().trim().min(1).max(600).optional(), instructions: z.string().trim().min(1).max(8000).optional(),
 configuration: agentConfigurationSchema.optional(), setup: customerSetupSchema.optional(), operationId: z.uuid().optional() })
 .refine(input => !(input.setup || input.offering || input.configuration) || !(input.purpose || input.instructions),
  { message: "Purpose and instructions cannot be combined with a setup, offering, or configuration" });
const saveSchema = z.strictObject({ name: nameSchema.optional(), avatar: agentAvatarSchema.optional(), configuration: agentConfigurationSchema,
 expectedRevision: z.number().int().positive(), confirmImpact: z.boolean().optional(), setup: customerSetupSchema.optional(),
 setupStep: z.enum(["Business", "Responsibilities", "Knowledge", "Channels", "Preferences", "Bookings", "Review", "complete"]).optional() });
const profileSchema = z.strictObject({ name: nameSchema.optional(), avatar: agentAvatarSchema.optional() })
 .refine(input => input.name !== undefined || input.avatar !== undefined, { message: "Nothing to update" });
const capabilitiesSchema = z.strictObject({ responsibilities: customerSetupSchema.shape.responsibilities,
 expectedRevision: z.number().int().positive(), confirmImpact: z.boolean().optional() });

function baseSetup(agent: { name: string; setup: CustomerSetup | null }, responsibilities: CustomerSetup["responsibilities"]): CustomerSetup {
 return {
  business: agent.setup?.business ?? { name: agent.name, website: "", description: "" },
  responsibilities,
  channels: agent.setup?.channels ?? [],
  booking: agent.setup?.booking,
  intake: agent.setup?.intake,
  supportHours: agent.setup?.supportHours,
  behaviour: agent.setup?.behaviour ?? { agentName: agent.name, language: "English", tone: "friendly", handoffInstructions: "" },
 };
}

/** Product operations use the same authorization and validation for every caller. */
export function agentCreationOperations(options: { store: PlatformStore; pool: Pool; assertBindings(configuration: AgentConfiguration): Promise<void> }) {
 const { store } = options;
 return {
  list: (scope: CreationScope) => store.listAgents(scope.accountId, scope.organizationId),
  get: (scope: CreationScope, agentId: string) => store.getAgent(scope.accountId, scope.organizationId, z.uuid().parse(agentId)),
  readiness: (scope: CreationScope, agentId: string) => customerSetupReadiness(options.pool, scope.accountId, scope.organizationId, z.uuid().parse(agentId)),
  create: async (scope: CreationScope, raw: unknown) => {
   const input = createSchema.parse(raw);
   const generic = !input.offering && !input.setup && !input.configuration;
   const configuration = generic ? agentConfigurationSchema.parse({ ...defaultBusinessConfiguration(),
    instructions: input.instructions ?? "Help the user with their request. Be clear about what you can verify and what you cannot.",
    ...(input.purpose ? { identity: { purpose: input.purpose, voice: "Clear and helpful" } } : {}),
   }) : input.configuration;
   if (configuration) await options.assertBindings(configuration);
   return store.createConfiguredAgent({ ...scope, name: input.name, offering: input.offering,
    configuration, setup: input.setup, operationId: input.operationId });
  },
  save: async (scope: CreationScope, agentId: string, raw: unknown) => {
   const input = saveSchema.parse(raw);
   await options.assertBindings(input.configuration);
   return store.saveConfiguration({ ...input, ...scope, agentId: z.uuid().parse(agentId) });
  },
  profile: (scope: CreationScope, agentId: string, raw: unknown) => {
   const input = profileSchema.parse(raw);
   return store.updateAgentProfile({ ...scope, agentId: z.uuid().parse(agentId), ...input });
  },
  setCapabilities: async (scope: CreationScope, agentId: string, raw: unknown) => {
   const input = capabilitiesSchema.parse(raw);
   const id = z.uuid().parse(agentId);
   const agent = await store.getAgent(scope.accountId, scope.organizationId, id);
   const previous = (agent.setup ?? null) as CustomerSetup | null;
   const setup = baseSetup({ name: agent.name, setup: previous }, input.responsibilities);
   // Capability changes update derived tools and setup, but keep instructions the owner has edited.
   const customInstructions = previous !== null && agent.draft.instructions !== customerConfigurationForSetup(previous).instructions;
   const derived = applyCustomerSetup(agent.draft, setup, previous ?? undefined);
   const configuration = { ...derived, ...(customInstructions ? { instructions: agent.draft.instructions } : {}),
    ...setupUpdatedLayers(agent.draft, { offering: agent.offering, responsibilities: previous?.responsibilities ?? null }, { offering: agent.offering, responsibilities: setup.responsibilities }) };
   return store.saveConfiguration({ ...scope, agentId: id, configuration, setup, expectedRevision: input.expectedRevision, confirmImpact: input.confirmImpact });
  },
 };
}
