import { z } from "zod";
import { PlatformError,requestDigest } from "../../contracts/contracts";

export const STASH_MCP_ENDPOINT = "https://api.stash.kasitek.co.za/mcp";
export const STASH_ADAPTER_RELEASE = "stash-items-read-v1";
const invalid = () => new PlatformError("STASH_RESPONSE_INVALID", 502, "Stash did not return the selected note or document");
const itemSchema = z.object({
  id: z.uuid(), kind: z.enum(["note", "idea"]), title: z.string().max(1000),
  body: z.string().max(50000), revision: z.number().int().positive(),
  projectId: z.uuid().nullable(), bodyTruncated: z.boolean().optional(),
  offset: z.number().int().min(0).max(500000).optional(),
  totalCharacters: z.number().int().min(0).max(500000).optional(),
  nextOffset: z.number().int().min(0).max(500000).nullable().optional(),
});
/** Interpret only inline text. Saved URLs and instructions are never followed. */
export function stashItemObservation(raw: Record<string, unknown>, itemId: string, operation: string, offset: number) {
  const content = raw.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text" || typeof content[0].text !== "string") throw invalid();
  let envelope: unknown;
  try { envelope = JSON.parse(content[0].text); } catch { throw invalid(); }
  const parsed = itemSchema.safeParse((envelope as { data?: unknown })?.data);
  if (!parsed.success || parsed.data.id !== itemId) throw invalid();
  const item = parsed.data;
  if (operation === "read_project_document" && (!item.projectId || item.offset !== offset || item.totalCharacters === undefined || item.nextOffset === undefined || item.body.length !== Math.min(30000, Math.max(0, item.totalCharacters - offset)) || item.nextOffset !== (offset + 30000 < item.totalCharacters ? offset + 30000 : null))) throw invalid();
  if (operation !== "get_item" && operation !== "read_project_document") throw invalid();
  let sourceBody = item.body;
  const hasContinuation = item.bodyTruncated || item.nextOffset !== undefined && item.nextOffset !== null;
  // The server slices UTF-16. Leave a split pair for the next passage instead of encoding a replacement character.
  if (hasContinuation && /[\uD800-\uDBFF]$/.test(sourceBody)) sourceBody = sourceBody.slice(0, -1);
  const body = operation === "get_item" ? sourceBody.slice(offset) : sourceBody;
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(body)) throw new PlatformError("STASH_TEXT_BOUNDARY", 400, "Read the Stash passage from a complete Unicode character boundary");
  const bytes = Buffer.from(body), text = bytes.length <= 4096 ? body : new TextDecoder().decode(bytes.subarray(0, 4096), { stream: true });
  const nextOffset = text.length < body.length || item.bodyTruncated || item.nextOffset !== undefined && item.nextOffset !== null ? offset + text.length : null;
  return { text, truncated: nextOffset !== null, title: item.title, provenance: {
    kind: "timestamped_observation", itemId, projectId: item.projectId, revision: item.revision,
    offset, nextOffset, providerNextOffset: item.nextOffset ?? null,
    bodyDigest: requestDigest({ itemId, revision: item.revision, offset: operation === "get_item" ? 0 : offset, body: item.body }),
    ...(operation === "get_item" && item.bodyTruncated ? { continuationTool: "read_project_document" } : {}),
  } };
}
