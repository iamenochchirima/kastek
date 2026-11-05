import { ApiError } from "../error.js";
import { platformCapabilities } from "../services/social/channels.js";

const invalid = (): never => { throw new ApiError(502, "agent_read_projection_invalid", "The connection list is unavailable"); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const required = (value: unknown): string => typeof value === "string" && value.length > 0 ? value : invalid();
const label = (value: unknown, fallback: string): string => typeof value === "string" && value.trim() ? value : fallback;

/** The signed preview URL is a bearer credential. The agent only needs asset metadata. */
export function projectAgentMediaPreview(value: Record<string, unknown>): Record<string, unknown> {
  if (value.state !== "succeeded") return invalid();
  const result=object(value.result),asset=object(result.asset);
  const fields=["id","kind","mimeType","fileName","byteSize","checksum","width","height","durationMs","processingStatus","scanStatus","createdAt"];
  const projected=Object.fromEntries(fields.filter(key=>asset[key]!==undefined).map(key=>[key,asset[key]]));
  required(projected.id);required(projected.kind);required(projected.mimeType);
  return {state:"succeeded",result:{asset:projected,previewReady:true}};
}

/** Model views are built before transport fragmentation. Identifiers remain usable selectors. */
export function projectAgentConnectionRead(operation: string, value: Record<string, unknown>): Record<string, unknown> {
  if (operation !== "connections.list" && operation !== "content.accounts.list") return value;
  if (value.state !== "succeeded") return invalid();
  const result = object(value.result), pagination = object(result.pagination);
  const key = operation === "connections.list" ? "connections" : "accounts";
  const rows = result[key];
  if (!Array.isArray(rows) || !Number.isSafeInteger(pagination.cursor) || !Number.isSafeInteger(pagination.limit) ||
      !(pagination.nextCursor === null || Number.isSafeInteger(pagination.nextCursor))) return invalid();
  const records = rows.map(raw => {
    const row = object(raw);
    if (key === "accounts") return { id: required(row.id), name: label(row.display_name, "Unnamed account"), platform: label(row.platform, "UNKNOWN"), status: label(row.status, "UNKNOWN"),
      ...(typeof row.handle === "string" ? { handle: row.handle } : {}),
      ...(typeof row.external_account_id === "string" && row.external_account_id ? { platformAccountId: row.external_account_id } : {}),
      capabilities: platformCapabilities(label(row.platform, "UNKNOWN")) };
    const capabilities = Array.isArray(row.capabilities) ? row.capabilities.flatMap(item => {
      const capability = object(item);
      return typeof capability.key === "string" && capability.key ? [{ key: capability.key, enabled: capability.enabled === true }] : [];
    }) : [];
    const permissions = Array.isArray(row.permissions) ? row.permissions.flatMap(item => {
      const permission = object(item);
      return typeof permission.key === "string" && permission.key ? [{ key: permission.key, label: label(permission.label, permission.key), state: label(permission.state, "UNKNOWN"), requestable: permission.requestable === true }] : [];
    }) : [];
    return { id: required(row.id), name: label(row.displayName, "Unnamed account"), platform: label(row.provider, "UNKNOWN"), status: label(row.status, "UNKNOWN"),
      ...(typeof row.handle === "string" ? { handle: row.handle } : {}), healthStatus: label(row.healthStatus, "UNKNOWN"), capabilities, permissions };
  });
  const included: typeof records = [];
  const cursor = pagination.cursor as number;
  for (const record of records) {
    const candidate = [...included, record];
    if (Buffer.byteLength(JSON.stringify({ state: value.state, result: { [key]: candidate, pagination: { limit: pagination.limit, cursor, nextCursor: cursor + candidate.length } } })) > 7000) break;
    included.push(record);
  }
  if (records.length && !included.length) return invalid();
  const nextCursor = included.length < records.length ? cursor + included.length : pagination.nextCursor;
  return { state: value.state, result: { [key]: included, pagination: { limit: pagination.limit, cursor, nextCursor } } };
}
