import { z } from "zod";
import type { ProductCapabilityInvocation, ProductCapabilityResult } from "@kasitek-labs/contracts";
import type { AdapterManifest } from "./capability-catalog";

export interface ProductAdapterInstallation {
  registerAdapter(manifest:AdapterManifest,adapter:{handlers:readonly string[];invoke(command:ProductCapabilityInvocation,signal?:AbortSignal):Promise<ProductCapabilityResult>}):unknown;
}

/** Product records stay in their product. This assertion carries an exact execution ceiling. */
export const productAssertionSchema = z.strictObject({
  iss: z.url(), aud: z.literal("agents-execution"), sub: z.string().min(1).max(512),
  iat: z.number().int(), exp: z.number().int(), jti: z.uuid(),
  product: z.enum(["growth", "agencies"]), tenantId: z.string().min(1).max(256),
  resourceId: z.string().min(1).max(256), versionId: z.uuid(), actorIssuer: z.url(),
  operations: z.array(z.enum(["model.reply", "knowledge.read"])).min(1).max(2),
  sourceRevisionIds: z.array(z.uuid()).max(20),
  maxInputBytes: z.number().int().positive().max(2147483647), maxOutputTokens: z.number().int().positive().max(2147483647),
  maxContextTokens: z.number().int().positive().max(2147483647).default(8192),
  rootTokenLimit: z.number().int().positive().max(2147483647), inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ProductAssertion = z.infer<typeof productAssertionSchema>;
