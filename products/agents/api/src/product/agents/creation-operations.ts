import { z } from "zod";
import type { Pool } from "pg";
import { agentConfigurationSchema, type AgentConfiguration } from "../../contracts/contracts";
import { customerSetupSchema } from "../offerings/customer-setup";
import type { PlatformStore } from "./store";
import { customerSetupReadiness } from "./setup-readiness";
type CreationScope = { accountId: string; organizationId: string };

const createSchema = z.strictObject({ name: z.string().min(1).max(120), offering: z.literal("customer-service").optional(),
 configuration: agentConfigurationSchema.optional(), setup: customerSetupSchema.optional(), operationId: z.uuid().optional() });
const saveSchema = z.strictObject({ name: z.string().min(1).max(120).optional(), configuration: agentConfigurationSchema,
 expectedRevision: z.number().int().positive(), confirmImpact: z.boolean().optional(), setup: customerSetupSchema.optional(),
 setupStep: z.enum(["Business", "Responsibilities", "Knowledge", "Channels", "Preferences", "Bookings", "Review", "complete"]).optional() });

/** Product operations use the same authorization and validation for every caller. */
export function agentCreationOperations(options: { store: PlatformStore; pool: Pool; assertBindings(configuration: AgentConfiguration): Promise<void> }) {
 const { store } = options;
 return {
  list: (scope: CreationScope) => store.listAgents(scope.accountId, scope.organizationId),
  get: (scope: CreationScope, agentId: string) => store.getAgent(scope.accountId, scope.organizationId, z.uuid().parse(agentId)),
  readiness: (scope: CreationScope, agentId: string) => customerSetupReadiness(options.pool, scope.accountId, scope.organizationId, z.uuid().parse(agentId)),
  create: (scope: CreationScope, raw: unknown) => {
   const input = createSchema.parse(raw);
   return store.createConfiguredAgent({ ...scope, name: input.name, offering: input.offering ?? (input.configuration ? undefined : "customer-service"),
    configuration: input.configuration, setup: input.setup, operationId: input.operationId });
  },
  save: async (scope: CreationScope, agentId: string, raw: unknown) => {
   const input = saveSchema.parse(raw);
   await options.assertBindings(input.configuration);
   return store.saveConfiguration({ ...input, ...scope, agentId: z.uuid().parse(agentId) });
  },
 };
}
