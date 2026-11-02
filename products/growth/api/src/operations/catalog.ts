import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { ApiError } from "../error.js";
import { growthOperations, type GrowthOperationDefinition } from "@kasitek-labs/contracts";
export { growthOperations } from "@kasitek-labs/contracts";

const definitions = new Map(growthOperations.map(value => [value.name, value]));
if (definitions.size !== growthOperations.length) throw new Error("Duplicate Growth operation identity");
const ajv = new Ajv({ strict: true, allErrors: false });
addFormats.default(ajv);
const validators = new Map(growthOperations.map(value => [value.name, ajv.compile(value.inputSchema)]));
export function getGrowthOperation(name: string): GrowthOperationDefinition {
  const definition = definitions.get(name);
  if (!definition) throw new ApiError(404, "operation_not_found", "Growth operation not found");
  return definition;
}
export function validateGrowthOperationInput(name: string, input: unknown): asserts input is Record<string, unknown> {
  getGrowthOperation(name);
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(input)); }
  catch { throw new ApiError(422, "operation_arguments_invalid", "Operation arguments must be JSON data"); }
  const maxBytes = 28_672;
  if (size > maxBytes) throw new ApiError(413, "operation_input_too_large", "Operation arguments exceed the supported limit");
  if (!validators.get(name)!(input)) throw new ApiError(422, "operation_arguments_invalid", "Check the operation arguments");
  const fields = input as Record<string, unknown>;
  if (name === "content.media.upload" && typeof fields.base64 === "string" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(fields.base64))
    throw new ApiError(422, "operation_arguments_invalid", "Choose canonical base64 media");
  if (name === "content.media.transfer.prepare" && (!/^(image|video)\/[a-zA-Z0-9.+-]+$/.test(String(fields.mimeType)) || fields.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(fields.sha256))))
    throw new ApiError(422, "operation_arguments_invalid", "Choose a valid media type and checksum");
  if (name === "content.posts.publish_batch.status" && !((input as Record<string, unknown>).postId || (input as Record<string, unknown>).batchId))
    throw new ApiError(422, "operation_arguments_invalid", "Choose a post or batch");
}
