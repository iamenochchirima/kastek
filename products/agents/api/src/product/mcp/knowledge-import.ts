import { z } from "zod";
import type { DocumentRuntime } from "../../capabilities/knowledge/document-runtime";
import type { KnowledgeStore } from "../../capabilities/knowledge/knowledge";
import { PlatformError } from "../../contracts/contracts";
import { knowledgeJob } from "./projections";
import type { McpOperation } from "./server";

/** The MCP request body is capped at 256 KiB, so keep text imports well below that after JSON escaping. */
export const MCP_KNOWLEDGE_IMPORT_BYTES = 120_000;
export const MCP_KNOWLEDGE_CONTENT_TYPES = Object.freeze(["text/plain", "text/markdown", "application/json", "text/csv"] as const);

export function importKnowledgeOperation(knowledge: KnowledgeStore, runtime?: Pick<DocumentRuntime, "profile">): McpOperation {
  return {
    name: "import_knowledge",
    description: `Import UTF-8 text, Markdown, JSON or CSV as a private knowledge candidate (up to ${MCP_KNOWLEDGE_IMPORT_BYTES} bytes). Reuse operationId on retry; poll knowledge_import_status until ready, then approve with request_knowledge_review.`,
    idempotent: true,
    scope: "agents:manage",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        contentType: { type: "string", enum: [...MCP_KNOWLEDGE_CONTENT_TYPES] },
        content: { type: "string", minLength: 1, maxLength: MCP_KNOWLEDGE_IMPORT_BYTES },
        operationId: { type: "string", minLength: 1, maxLength: 128 },
        sourceId: { type: "string", format: "uuid" },
      },
      required: ["title", "contentType", "content", "operationId"],
      additionalProperties: false,
    },
    run: async (scope, args) => {
      const input = z.strictObject({
        title: z.string().trim().min(1).max(200),
        contentType: z.enum(MCP_KNOWLEDGE_CONTENT_TYPES),
        content: z.string().min(1),
        operationId: z.string().min(1).max(128),
        sourceId: z.uuid().optional(),
      }).parse(args);
      if (Buffer.byteLength(input.content, "utf8") > MCP_KNOWLEDGE_IMPORT_BYTES) {
        throw new PlatformError("SOURCE_SIZE_INVALID", 413, `MCP knowledge imports are limited to ${MCP_KNOWLEDGE_IMPORT_BYTES} bytes`);
      }
      let profileRelease: string | undefined;
      if (runtime) {
        try { profileRelease = (await runtime.profile()).profileRelease; } catch { profileRelease = undefined; }
      }
      const job = profileRelease
        ? await knowledge.admitUpload(scope, { operationId: input.operationId, title: input.title, contentType: input.contentType,
          content: Buffer.from(input.content, "utf8"), parserRelease: profileRelease, embeddingRelease: profileRelease,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}) })
        : await knowledge.admitText(scope, { operationId: input.operationId, title: input.title, text: input.content,
          contentType: input.contentType, ...(input.sourceId ? { sourceId: input.sourceId } : {}) });
      return { ...knowledgeJob(job), acceptedGeneration: job.acceptedGeneration, retrieval: profileRelease ? "hybrid-v1" : "lexical-v1" };
    },
  };
}
