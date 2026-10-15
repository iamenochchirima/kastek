import { ApiError } from "../../error.js";
import { UtcTimestamp } from "../../db.js";
export const PLATFORMS = [
  "FACEBOOK",
  "INSTAGRAM",
  "THREADS",
  "TIKTOK",
  "BLUESKY",
  "LINKEDIN",
  "X",
];
export const CHANNEL_STATUSES = ["CONNECTED", "DISCONNECTED", "NEEDS_REAUTH"];
export const POST_STATUSES = [
  "DRAFT",
  "SCHEDULED",
  "PROCESSING",
  "PUBLISHED",
  "FAILED",
];
export const JOB_STATUSES = [
  "PENDING",
  "QUEUED",
  "PROCESSING",
  "PUBLISHED",
  "FAILED",
  "CANCELED",
];
export const VARIANT_STATUSES = ["DRAFT", "APPROVED", "NEEDS_EDITS"];
export const isValidPlatform = (value: string) => PLATFORMS.includes(value);
export const bad = (message: string) =>
  new ApiError(400, "bad_request", message);
export const missing = (message: string) =>
  new ApiError(404, "not_found", message);
export const internal = (message: string) =>
  new ApiError(500, "internal_error", message);
export const trimmed = (value: string | null | undefined) =>
  value?.trim() || null;
export function parseOptionalDatetime(
  value: string | null | undefined,
): Date | null {
  const raw = trimmed(value);
  if (!raw) return null;
  try {
    if (
      !/^\d{4}-\d\d-\d\d[Tt]\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:[Zz]|[+-]\d\d:\d\d)$/.test(
        raw,
      )
    )
      throw new Error();
    const leapSecond = raw.slice(17, 19) === "60";
    const normalized = raw.replace("t", "T").replace(/z$/, "Z");
    // Chrono admits RFC3339 leap seconds; PostgreSQL stores their next-second instant.
    const storageInstant = leapSecond
      ? `${normalized.slice(0, 17)}59${normalized.slice(19)}`
      : normalized;
    const result = new UtcTimestamp(storageInstant, true);
    if (leapSecond) result.setTime(result.getTime() + 1000);
    const datePart = raw.slice(0, 10);
    const [year, month, day] = datePart.split("-").map(Number);
    if (
      month! < 1 ||
      month! > 12 ||
      day! < 1 ||
      day! >
        [
          31,
          year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0) ? 29 : 28,
          31,
          30,
          31,
          30,
          31,
          31,
          30,
          31,
          30,
          31,
        ][month! - 1]! ||
      Number(raw.slice(11, 13)) > 23 ||
      Number(raw.slice(14, 16)) > 59 ||
      Number(raw.slice(17, 19)) > 60
    )
      throw new Error();
    return result;
  } catch {
    throw bad("Scheduled time is invalid");
  }
}
