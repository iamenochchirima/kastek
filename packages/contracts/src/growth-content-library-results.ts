const string = (maxLength = 256) => ({ type: "string", maxLength });
const nullable = (maxLength = 256) => ({ type: ["string", "null"], maxLength });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({type: "object", properties, required, additionalProperties: true});
const ref = (name: string) => ({$ref: `#/$defs/${name}`});
const array = (items: unknown, maxItems: number) => ({type: "array", items, maxItems});
const number = {type: ["integer", "null"], minimum: 0};
const media = object({assetId: string(), sortOrder: number, altText: nullable(4000), crop: {type: ["object", "null"], maxProperties: 20, additionalProperties: true}}, ["assetId"]);
const variant = object({platform: string(32), content: string(32768), media: array(media, 10)}, ["platform", "content"]);
const template = object({
  id: string(), orgId: string(), name: string(240), description: nullable(2000), category: nullable(120),
  content: string(32768), channels: array(string(32), 7), variants: array(variant, 7),
  fields: array(object({key: string(64), label: string(120), required: {type: "boolean"}, defaultValue: string(8192)}, ["key", "label"]), 30),
  media: array(media, 10), revision: {type: "integer", minimum: 1}, archivedAt: nullable(64),
  creatorId: nullable(), updatedById: nullable(), createdAt: string(64), updatedAt: string(64),
}, ["id", "name", "content", "channels", "variants", "fields", "media", "revision"]);
const asset = object({
  id: string(), kind: {type: "string", enum: ["IMAGE", "VIDEO"]}, mimeType: string(100), fileName: nullable(255),
  displayName: nullable(240), tags: array(string(50), 20), defaultAltText: nullable(2000),
  byteSize: {anyOf: [{type: "integer", minimum: 0}, string(30)]}, width: number, height: number, durationMs: number,
  processingStatus: string(40), scanStatus: string(40), checksum: nullable(128), createdAt: string(64), updatedAt: string(64),
  archivedAt: nullable(64), revision: {type: "integer", minimum: 1},
}, ["id", "kind", "mimeType", "byteSize", "processingStatus", "scanStatus", "revision"]);
const pagination = object({limit: {type: "integer", minimum: 1, maximum: 100}, nextCursor: nullable(4096)}, ["limit", "nextCursor"]);
const rendered = object({
  templateId: string(), revision: {type: "integer", minimum: 1}, title: string(240), content: string(32768),
  channels: array(string(32), 7), variants: array(variant, 7), media: array(media, 10), valuesDigest: string(64),
  validation: object({ready: {type: "boolean"}, errors: array(object({platform: string(32), code: string(128), message: string(2000)}, ["platform", "code", "message"]), 1000)}, ["ready", "errors"]),
}, ["templateId", "revision", "content", "channels", "variants", "media", "validation"]);
const chunk = object({encoding: {const: "json"}, chunk: string(4000), offset: {type: "integer", minimum: 0}, totalCharacters: {type: "integer", maximum: 2097152}, digest: string(64), continuation: nullable(512)}, ["encoding", "chunk", "offset", "digest"]);

/** New library tools describe the actual operation envelope, including bounded continuations. */
export function growthContentLibraryResultSchema(name: string): Record<string, unknown> | undefined {
  let result: Record<string, unknown>;
  if (name === "content.media.list") result = object({assets: array(ref("asset"), 100), pagination: ref("pagination")}, ["assets", "pagination"]);
  else if (name === "content.media.usage") result = object({assetId: string(), usage: array(object({type: {enum: ["post", "template"]}, id: string(), title: nullable(240), status: string(40), platforms: array(string(32), 7)}, ["type", "id", "title", "status"]), 100), pagination: ref("pagination")}, ["assetId", "usage", "pagination"]);
  else if (["content.media.update", "content.media.archive", "content.media.restore"].includes(name)) result = object({asset: ref("asset")}, ["asset"]);
  else if (name === "content.templates.list") result = object({templates: array(ref("template"), 100), pagination: ref("pagination")}, ["templates", "pagination"]);
  else if (name === "content.templates.render") result = object({rendered: ref("rendered")}, ["rendered"]);
  else if (name === "content.templates.instantiate") result = object({post: object({id: string(), status: string(40), media: array(object({asset_id: string()}, ["asset_id"]), 10)}, ["id"]), postId: string(), reconciled: {type: "boolean"}, receipt: string(100)});
  else if (["content.templates.get", "content.templates.create", "content.templates.update", "content.templates.archive", "content.templates.restore"].includes(name)) result = object({template: ref("template")}, ["template"]);
  else return undefined;
  return { ...object({state: string(40), result: {anyOf: [result, ref("chunk")]}, review: {type: "object", additionalProperties: true}, code: string(128), message: string(2000)}), anyOf: [{properties: {state: string(40)}, required: ["state"]}, {properties: {code: string(128), message: string(2000)}, required: ["code", "message"]}], $defs: {asset, template, rendered, pagination, chunk} };
}
