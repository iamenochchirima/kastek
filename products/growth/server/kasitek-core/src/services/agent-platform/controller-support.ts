import { Readable, Transform } from "node:stream";
import type { FastifyRequest } from "fastify";
import { ApiError, RequestExtractionError } from "../../error.js";
import { queryU32, queryU64 } from "../../typed-query.js";
export function bad(message: string): never {
  throw new ApiError(400, "bad_request", message);
}
export const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
export function requiredString(
  body: unknown,
  key: string,
  message: string,
): string {
  const value =
    body && typeof body === "object"
      ? (body as Record<string, unknown>)[key]
      : undefined;
  if (!nonempty(value)) bad(message);
  return value.trim();
}
export function validUint(value: string, bits: number): boolean {
  return /^\+?\d+$/.test(value) && BigInt(value) <= (1n << BigInt(bits)) - 1n;
}
export function validatedQuery(
  request: FastifyRequest,
  numeric: Record<string, 32 | 64>,
  fields: readonly string[] = Object.keys(numeric),
): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>,
    accepted = new Set(fields);
  const params = new URLSearchParams(
    request.raw.url?.split("?").slice(1).join("?") ?? "",
  );
  for (const [key, value] of params) {
    if (!accepted.has(key)) continue;
    if (Object.hasOwn(result, key))
      throw new RequestExtractionError("query", `duplicate field \`${key}\``);
    result[key] = value;
    if (numeric[key]) {
      result[key] =
        numeric[key] === 64
          ? queryU64(value, key)
          : queryU32(value, key);
    }
  }
  return result;
}
export function checkLimit(value: unknown, max: number, message: string): void {
  if (
    value !== undefined &&
    value !== null &&
    (Number(value) < 1 || Number(value) > max)
  )
    bad(message);
}
export function sanitizeMessageBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body))
    bad("Message body must be an object");
  const object = body as Record<string, unknown>;
  const message = requiredString(object, "message", "Message text is required");
  if ([...message].length > 20000) bad("Message text is too long");
  const idempotencyKey = requiredString(
    object,
    "idempotencyKey",
    "A valid idempotencyKey is required",
  );
  if (
    Buffer.byteLength(idempotencyKey) < 8 ||
    Buffer.byteLength(idempotencyKey) > 240
  )
    bad("A valid idempotencyKey is required");
  const result: Record<string, unknown> = { message, idempotencyKey };
  const conversationId = nonempty(object.conversationId)
    ? object.conversationId.trim()
    : null;
  const createNew = object.createNew === true;
  if (Boolean(conversationId) === createNew)
    bad("Choose either conversationId or createNew=true");
  if (conversationId) {
    if (Buffer.byteLength(conversationId) > 64)
      bad("Conversation id is invalid");
    result.conversationId = conversationId;
  } else result.createNew = true;
  const provider =
    typeof object.modelProvider === "string" ? object.modelProvider : null;
  const model = typeof object.model === "string" ? object.model : null;
  if ((provider !== null) !== (model !== null))
    bad("Model provider and model must be changed together");
  if (provider !== null && model !== null) {
    if (
      ![
        "openrouter",
        "openai",
        "anthropic",
        "gemini",
        "deepseek",
        "glm",
        "kimi",
        "minimax",
        "xai",
        "opencode_go",
        "opencode_zen",
      ].includes(provider) ||
      !model.trim() ||
      Buffer.byteLength(model) > 240
    )
      bad("Selected model is invalid");
    result.modelProvider = provider;
    result.model = model;
  }
  if (Object.hasOwn(object, "context")) {
    const context = object.context;
    if (!context || typeof context !== "object" || Array.isArray(context))
      bad("Message context must be an object");
    const safe: Record<string, string> = {};
    for (const key of ["route", "pageTitle"]) {
      const value = (context as Record<string, unknown>)[key];
      if (typeof value === "string") {
        if ([...value].length > (key === "route" ? 500 : 240))
          bad("Message context value is too long");
        safe[key] = value;
      }
    }
    result.context = safe;
  }
  return result;
}
export function validAudioSignature(bytes: Buffer, mime: string): boolean {
  switch (mime) {
    case "audio/aac":
      return bytes.length >= 2 && bytes[0] === 255 && (bytes[1]! & 246) === 240;
    case "audio/flac":
      return bytes.subarray(0, 4).toString() === "fLaC";
    case "audio/m4a":
    case "audio/mp4":
      return bytes.length >= 12 && bytes.subarray(4, 8).toString() === "ftyp";
    case "audio/mpeg":
      return (
        bytes.subarray(0, 3).toString() === "ID3" ||
        (bytes.length >= 2 && bytes[0] === 255 && (bytes[1]! & 224) === 224)
      );
    case "audio/ogg":
    case "audio/opus":
    case "application/ogg":
      return bytes.subarray(0, 4).toString() === "OggS";
    case "audio/wav":
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString() === "RIFF" &&
        bytes.subarray(8, 12).toString() === "WAVE"
      );
    case "audio/webm":
      return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
    default:
      return false;
  }
}
/** Stop raw channel uploads at the source limit while chunks are still arriving. */
export function guardRawPayload(
  payload: Readable,
  max: number,
  message: string,
): Transform & { receivedEncodedLength: number } {
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      guard.receivedEncodedLength += chunk.length;
      if (guard.receivedEncodedLength > max)
        callback(new ApiError(400, "bad_request", message));
      else callback(null, chunk);
    },
  }) as Transform & { receivedEncodedLength: number };
  guard.receivedEncodedLength = 0;
  payload.on("error", (error) => guard.destroy(error));
  return payload.pipe(guard);
}
