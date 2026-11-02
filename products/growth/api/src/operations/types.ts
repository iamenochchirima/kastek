import type { CoreContext } from "../context.js";
import type { RequestContext } from "../identity/request-context.js";

export type { GrowthOperationEffect, GrowthOperationScope, GrowthOperationDefinition } from "@kasitek-labs/contracts";
export type GrowthOperationInput = Record<string, unknown>;
export type GrowthOperationHandler = (core: CoreContext, context: RequestContext, input: GrowthOperationInput) => Promise<unknown>;
