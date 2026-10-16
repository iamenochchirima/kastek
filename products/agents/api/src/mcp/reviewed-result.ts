import { z } from "zod";
import { remoteMcpToolSchema } from "./remote";

const sensitiveField = /(api[_-]?key|secret|token|password|authorization|cookie|private[_-]?key)/i;
export const reviewedResultFieldSchema = z.string().trim().min(1).max(80)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
  .refine(field => !sensitiveField.test(field) && !["constructor", "prototype"].includes(field), "Secret fields cannot be returned to the agent");
export const remoteMcpPublicationSchema = z.object({
  resultFields: z.record(z.string(), z.array(reviewedResultFieldSchema).max(20)).default({}),
}).strict();
// Discovery uses the wire schema, which strips this locally reviewed policy.
export const reviewedRemoteMcpToolsSchema = z.array(remoteMcpToolSchema.extend({
  reviewedResultFields: z.array(reviewedResultFieldSchema).max(20).default([]),
})).max(100);

/** Return only reviewed top-level scalar fields, never arbitrary remote content. */
export function projectReviewedMcpResult(result: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  const envelope = result as Record<string, unknown>;
  if (envelope.isError === true) throw new Error("REMOTE_MCP_TOOL_FAILED");
  let record = envelope;
  if (envelope.structuredContent && typeof envelope.structuredContent === "object" && !Array.isArray(envelope.structuredContent)) {
    record = envelope.structuredContent as Record<string, unknown>;
  } else if (Array.isArray(envelope.content)) {
    // JSON text is a common MCP result. Free-form text needs a separate reviewed
    // projection, rather than exposing an arbitrary text blob as one field.
    const text = envelope.content.find(item => item?.type === "text" && typeof item.text === "string")?.text;
    if (typeof text !== "string" || text.length > 100_000) return {};
    try { const parsed: unknown = JSON.parse(text); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}; record = parsed as Record<string, unknown>; }
    catch { return {}; }
  }
  return Object.fromEntries(fields.filter(field => reviewedResultFieldSchema.safeParse(field).success)
    .filter(field => Object.prototype.hasOwnProperty.call(record, field))
    .flatMap<[string, unknown]>(field => {
      const value = record[field];
      if (value === "[REDACTED]") return [];
      if (typeof value === "string") return [[field, value.slice(0, 2_000)]];
      if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return [[field, value]];
      return [];
    }));
}
