import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJson, PlatformError } from "./contracts";

export const executorRequestSchema = z.strictObject({ schemaVersion: z.literal("1"), resourceKind: z.enum(["sandbox", "document"]),
  allocationId: z.uuid(), executorId: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/), generation: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  commandId: z.string().min(1).max(160), command: z.enum(["available", "profile", "analyze", "start", "status", "result", "finalize", "destroy", "quiesce"]),
  issuedAt: z.number().int().positive(), payload: z.unknown() });
export type ExecutorRequest = z.infer<typeof executorRequestSchema>;
export interface ExecutorRoute { id: string; url: string; key: string }
export interface ExecutorOwner { resource_kind: "sandbox" | "document"; allocation_id: string; executor_id: string; generation: string;
  request_digest: string; lease_expires_at: Date; quiescent: boolean; quiescence_receipt: string | null }
export const EXECUTOR_METADATA_ID = "00000000-0000-4000-8000-000000000000";
export function executorSignature(body: ExecutorRequest, key: string): string { return createHmac("sha256", key).update(canonicalJson(body)).digest("hex"); }
export function verifyExecutorSignature(body: ExecutorRequest, signature: string | undefined, key: string): void {
  const expected = executorSignature(body, key);
  if (!signature || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature)) || Math.abs(Date.now() - body.issuedAt) > 60_000)
    throw new PlatformError("EXECUTOR_AUTH_DENIED", 403, "Executor request denied");
}
export function encodeExecutorValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $executorBytes: Buffer.from(value).toString("base64") };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(encodeExecutorValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, encodeExecutorValue(item)]));
  return value;
}
export function decodeExecutorValue(value: unknown): any {
  if (Array.isArray(value)) return value.map(decodeExecutorValue);
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length === 1 && typeof row.$executorBytes === "string") {
      const bytes = Buffer.from(row.$executorBytes, "base64"); if (bytes.toString("base64") !== row.$executorBytes) throw new PlatformError("EXECUTOR_PAYLOAD_INVALID", 400, "Invalid executor bytes"); return bytes;
    }
    return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, decodeExecutorValue(item)]));
  }
  return value;
}
