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
export function inboundApprovalToken(message: unknown): string | null {
  const id = str(obj(obj(obj(message).interactive).button_reply).id);
  return id?.startsWith("ka_approval_") ? id : null;
}
export function approvalAcknowledgement(value: unknown): string {
  const r = obj(value);
  if (r.status === "approval_group_already_signalled")
    return "Already decided.";
  if (r.status === "approval_group_signalled" && r.decision === "rejected")
    return "Denied.";
  if (r.status === "approval_group_signalled" && r.decision === "approved")
    return "Approval received. Processing…";
  return "Approval received.";
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
export function normalizedMediaMime(value: string | null): string | null {
  return value?.split(";")[0]?.trim().toLowerCase() || null;
}
export function mediaKindFromMime(value: string): string | null {
  return value.startsWith("image/")
    ? "image"
    : value.startsWith("video/")
      ? "video"
      : value.startsWith("audio/") || value === "application/ogg"
        ? "audio"
        : null;
}
export function mediaMimeFromFilename(value: string | null): string | null {
  const extension = value?.split(".").at(-1)?.trim().toLowerCase();
  const values: Record<string, string> = {
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    aac: "audio/aac",
    flac: "audio/flac",
    m4a: "audio/m4a",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    opus: "audio/opus",
    wav: "audio/wav",
  };
  return extension ? (values[extension] ?? null) : null;
}
export function agentMediaKind(media: IncomingMedia): string | null {
  const mime = normalizedMediaMime(media.mimeType);
  if (
    mime &&
    !["application/octet-stream", "binary/octet-stream"].includes(mime)
  )
    return mediaKindFromMime(mime);
  const fileMime = mediaMimeFromFilename(media.filename);
  return (
    (fileMime ? mediaKindFromMime(fileMime) : null) ??
    (["image", "sticker"].includes(media.kind)
      ? "image"
      : ["video", "audio"].includes(media.kind)
        ? media.kind
        : null)
  );
}
export function agentMediaLimit(kind: string): number {
  return (kind === "video" ? 512 : kind === "audio" ? 25 : 20) * 1024 * 1024;
}
export function agentMediaMime(
  media: IncomingMedia,
  downloaded: string,
  kind: string,
): string {
  return (
    [
      normalizedMediaMime(downloaded),
      normalizedMediaMime(media.mimeType),
      mediaMimeFromFilename(media.filename),
    ].find((value) => value && mediaKindFromMime(value) === kind) ??
    (kind === "video"
      ? "video/mp4"
      : kind === "audio"
        ? "audio/ogg"
        : "image/jpeg")
  );
}
export function mediaFailureMessage(kind: string): string {
  return kind === "audio"
    ? "I couldn't access that audio. Please try sending it again."
    : kind === "video"
      ? "I couldn't process that video. Please try sending it again."
      : "I couldn't process that image. Please try sending it again.";
}
export const INGEST_FAILURE_MESSAGE =
  "I couldn't process that message right now. Please try again.";
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
