import { SerdeFloat } from "@kasitek-labs/server-support/json";
import type { Row } from "./types.js";
export function obj(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}
export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function inboundText(message: unknown): string | null {
  const m = obj(message);
  return str(obj(m.text).body) ?? str(obj(m.button).text);
}
export function isOptOutMessage(value: string | null): boolean {
  return ["stop", "unsubscribe", "cancel", "end", "optout", "opt-out"].includes(
    (value ?? "").trim().replace(/[A-Z]/g, (c) => c.toLowerCase()),
  );
}
export interface IncomingMedia {
  kind: string;
  mediaId: string;
  mimeType: string | null;
  caption: string | null;
  filename: string | null;
  sha256: string | null;
}
export function incomingMedia(message: unknown): IncomingMedia | null {
  for (const kind of ["image", "video", "audio", "document", "sticker"]) {
    const m = obj(obj(message)[kind]),
      id = str(m.id);
    if (id !== null)
      return {
        kind,
        mediaId: id,
        mimeType: str(m.mime_type),
        caption: str(m.caption),
        filename: str(m.filename),
        sha256: str(m.sha256),
      };
  }
  return null;
}
export function parseStatusFailureDetails(
  payload: unknown,
): [string | null, string | null] {
  const error = obj(arr(obj(payload).errors)[0]),
    code = error.code;
  const integer =
    !(code instanceof SerdeFloat) &&
    (typeof code === "bigint" ||
      (typeof code === "number" && Number.isSafeInteger(code)))
      ? BigInt(code as number | bigint)
      : null;
  const resolved =
    integer !== null &&
    integer >= -9223372036854775808n &&
    integer <= 9223372036854775807n
      ? integer.toString()
      : str(code);
  const message = [
    str(error.title),
    str(error.message),
    str(obj(error.error_data).details),
  ]
    .filter((v): v is string => v !== null)
    .map((v) => v.trim())
    .filter(Boolean)
    .join(" | ");
  return [resolved, message || null];
}
export function isBlockedFailure(
  code: string | null,
  message: string | null,
): boolean {
  return (
    ["131026", "131048"].includes(code ?? "") ||
    !!message?.replace(/[A-Z]/g, (c) => c.toLowerCase()).includes("blocked")
  );
}
function bounded(value: unknown): string | null {
  const text = str(value)?.trim();
  return text && Buffer.byteLength(text) <= 64 && /^[a-zA-Z0-9_.-]+$/.test(text)
    ? text
    : null;
}
export function parseStatusPricingDetails(
  value: unknown,
): {
  billable: boolean;
  category: string;
  model: string | null;
  pricingType: string | null;
} | null {
  const pricing = obj(obj(value).pricing),
    category = bounded(pricing.category);
  return typeof pricing.billable === "boolean" && category
    ? {
        billable: pricing.billable,
        category,
        model: bounded(pricing.pricing_model),
        pricingType: bounded(pricing.type),
      }
    : null;
}
