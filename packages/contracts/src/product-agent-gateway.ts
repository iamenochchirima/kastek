import { z } from "zod";

/**
 * Wire contract for trusted product backends (Growth, Agencies). The envelope is signed by
 * the product service and carries shared agent, conversation and run operations. Product
 * composition stays in the product; this contract has no product-specific operation names.
 */
export const productAgentTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("product_feature"), featureId: z.string().min(1).max(64) }),
  z.strictObject({ kind: z.literal("agent"), agentId: z.uuid() }),
]);
export type ProductAgentTarget = z.infer<typeof productAgentTargetSchema>;

const id = z.string().min(1).max(128);
const page = { cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100).optional() };
const context = z.unknown().nullable().optional();

export const productAgentInputSchemas = {
  "conversations.create": z.strictObject({ target: productAgentTargetSchema, title: z.string().trim().min(1).max(240).optional(), context }),
  "conversations.get": z.strictObject({ conversationId: id, ...page }),
  "conversations.list": z.strictObject({ target: productAgentTargetSchema.optional(), search: z.string().max(200).optional(), ...page }),
  "conversations.context": z.strictObject({ conversationId: id, context: z.unknown().nullable() }),
  "runs.start": z.strictObject({ conversationId: id, message: z.string().trim().min(1).max(131072), context }),
  "runs.get": z.strictObject({ taskId: id }),
  "runs.list": z.strictObject({ conversationId: id.optional(), state: z.string().max(32).optional(), search: z.string().max(200).optional(), ...page }),
  "runs.activity": z.strictObject({ taskId: id, childTaskId: id.optional(), cursor: z.string().max(2048).optional(), operationCursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100).optional() }),
  "runs.events": z.strictObject({ taskId: id, ...page }),
  "runs.steer": z.strictObject({ taskId: id, instruction: z.string().trim().min(1).max(4000) }),
  "runs.cancel": z.strictObject({ taskId: id }),
  "runs.continue": z.strictObject({ taskId: id }),
  "reviews.list": z.strictObject({ taskId: id }),
  "reviews.decide": z.strictObject({ taskId: id, reviewId: id, payloadDigest: z.string().min(1).max(256), decision: z.enum(["approve", "reject"]) }),
} as const;

export type ProductAgentInputs = {
  [K in keyof typeof productAgentInputSchemas]: z.infer<(typeof productAgentInputSchemas)[K]>;
};
export type ProductAgentOperation = keyof ProductAgentInputs;
export const productAgentOperations = Object.keys(productAgentInputSchemas) as ProductAgentOperation[];

export type ProductAgentCommand<K extends ProductAgentOperation = ProductAgentOperation> = K extends ProductAgentOperation ? {
  version: "1";
  requestId: string;
  product: "growth" | "agencies";
  tenantId: string;
  actor: { issuer: string; subject: string };
  operation: K;
  input: ProductAgentInputs[K];
} : never;

const envelopeSchema = z.strictObject({
  version: z.literal("1"),
  requestId: z.string().min(1).max(128),
  product: z.enum(["growth", "agencies"]),
  tenantId: z.string().min(1).max(128),
  actor: z.strictObject({ issuer: z.string().min(1).max(512), subject: z.string().min(1).max(512) }),
  operation: z.enum(productAgentOperations as [ProductAgentOperation, ...ProductAgentOperation[]]),
  input: z.unknown(),
});

export class ProductAgentContractError extends Error {}

/** Parses the envelope and the operation-specific input. Unknown fields are rejected. */
export function parseProductAgentCommand(value: unknown): ProductAgentCommand {
  try {
    const root = envelopeSchema.parse(value);
    const input = productAgentInputSchemas[root.operation].parse(root.input);
    return { ...root, input } as ProductAgentCommand;
  } catch (error) {
    if (error instanceof z.ZodError) throw new ProductAgentContractError("Invalid product agent command");
    throw error;
  }
}

export const PRODUCT_AGENT_GATEWAY_PATH = "/internal/v1/products";

export function productAgentGatewayPath(product: "growth" | "agencies"): string {
  return `${PRODUCT_AGENT_GATEWAY_PATH}/${product}/agent-gateway`;
}
