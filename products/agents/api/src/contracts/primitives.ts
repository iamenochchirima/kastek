import { createHash } from "node:crypto";
import { z } from "zod";

export class PlatformError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number, message: string) {
    super(message);
    this.name = "PlatformError";
  }
}

export const principalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human"), issuer: z.url(), subject: z.string().min(1).max(512) }),
  z.strictObject({ kind: z.literal("application"), applicationId: z.uuid() }),
  z.strictObject({ kind: z.literal("automation"), id: z.uuid(), ownerAccountId: z.uuid() }),
  z.strictObject({ kind: z.literal("visitor"), deploymentId: z.uuid(), sessionId: z.uuid() }),
  z.strictObject({ kind: z.literal("channel_customer"), deploymentId: z.uuid(), participantId: z.uuid() }),
]);
export type InitiatingPrincipal = z.infer<typeof principalSchema>;
export function isCustomerPrincipal(principal: InitiatingPrincipal): principal is Extract<InitiatingPrincipal, { kind: "visitor" | "channel_customer" }> {
  return principal.kind === "visitor" || principal.kind === "channel_customer";
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requestDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
