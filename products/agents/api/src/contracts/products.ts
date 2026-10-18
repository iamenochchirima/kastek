import { z } from "zod";

/** Product records stay in their product. This assertion carries an exact execution ceiling. */
export const productAssertionSchema = z.strictObject({
  iss: z.url(), aud: z.literal("agents-execution"), sub: z.string().min(1).max(512),
  iat: z.number().int(), exp: z.number().int(), jti: z.uuid(),
  product: z.enum(["growth", "agencies"]), tenantId: z.string().min(1).max(256),
  resourceId: z.string().min(1).max(256), versionId: z.uuid(), actorIssuer: z.url(),
  operations: z.array(z.enum(["model.reply", "knowledge.read"])).min(1).max(2),
  sourceRevisionIds: z.array(z.uuid()).max(20),
  maxInputBytes: z.number().int().positive().max(16384), maxOutputTokens: z.number().int().positive().max(1024),
  rootTokenLimit: z.number().int().min(2048).max(32000), inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ProductAssertion = z.infer<typeof productAssertionSchema>;
