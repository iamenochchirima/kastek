import { z } from "zod";

/** Stable, workspace-owned media identity. Never persist provider URLs or bytes here. */
export const agentMediaReferenceSchema = z.object({
  assetId: z.string().trim().min(1).max(160),
  kind: z.enum(["image", "video", "audio", "document", "file"]),
  mimeType: z.string().trim().min(1).max(160).optional(),
  fileName: z.string().trim().min(1).max(240).optional(),
  altText: z.string().trim().min(1).max(1_000).optional(),
  caption: z.string().trim().min(1).max(2_000).optional(),
  disposition: z.enum(["inline", "attachment"]).default("inline"),
}).strict();
export type AgentMediaReference = z.infer<typeof agentMediaReferenceSchema>;

/** The one durable response shape shared by hosted agents and channel gateways. */
export const agentResponseSchema = z.object({
  version: z.literal("1").default("1"),
  text: z.string().trim().max(50_000).default(""),
  media: z.array(agentMediaReferenceSchema).max(10).default([]),
}).strict().superRefine((value, context) => {
  if (!value.text && !value.media.length) context.addIssue({ code: "custom", message: "A response requires text or media" });
  const seen = new Set<string>();
  for (const media of value.media) {
    if (seen.has(media.assetId)) context.addIssue({ code: "custom", message: "A response cannot include an asset twice" });
    seen.add(media.assetId);
  }
});
export type AgentResponse = z.infer<typeof agentResponseSchema>;

export const agentResponseToolInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    version: { type: "string", const: "1", default: "1" },
    text: { type: "string", maxLength: 50_000, default: "" },
    media: {
      type: "array", maxItems: 10, default: [],
      items: {
        type: "object",
        properties: {
          assetId: { type: "string", minLength: 1, maxLength: 160 },
          kind: { type: "string", enum: ["image", "video", "audio", "document", "file"] },
          mimeType: { type: "string", minLength: 1, maxLength: 160 },
          fileName: { type: "string", minLength: 1, maxLength: 240 },
          altText: { type: "string", minLength: 1, maxLength: 1_000 },
          caption: { type: "string", minLength: 1, maxLength: 2_000 },
          disposition: { type: "string", enum: ["inline", "attachment"], default: "inline" },
        },
        required: ["assetId", "kind"], additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export function parseAgentResponse(value: unknown): AgentResponse {
  if (typeof value === "string") return agentResponseSchema.parse({ text: value });
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.response && typeof record.response === "object") return agentResponseSchema.parse(record.response);
    if (typeof record.message === "string" && record.text === undefined) return agentResponseSchema.parse({ text: record.message, media: record.media ?? [] });
  }
  return agentResponseSchema.parse(value);
}
