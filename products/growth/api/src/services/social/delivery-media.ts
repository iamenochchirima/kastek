import { ApiError } from "../../error.js";

export interface DeliveryMediaItem {
  assetId: string;
  altText?: string | null;
  sortOrder?: number | null;
}
const invalid = () => new ApiError(409, "delivery_media_invalid", "The publishing media selection is unavailable. Recreate the draft before publishing");

/** A recognized unpublished delivery selection is authoritative, including an empty selection. */
export function resolveDeliveryMedia<T extends DeliveryMediaItem>(
  job: { platform: string; status: string; deliverySnapshot?: unknown },
  common: readonly T[],
): T[] {
  if (!["PENDING", "QUEUED", "PROCESSING", "FAILED"].includes(job.status)) return [...common];
  const value = job.deliverySnapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [...common];
  const snapshot = value as Record<string, unknown>;
  if (snapshot.schema !== "kasitek-content-delivery-v1") return [...common];
  if (snapshot.platform !== job.platform || !Array.isArray(snapshot.media) || snapshot.media.length > 10) throw invalid();
  const seen = new Set<string>();
  return snapshot.media.map((item: unknown, index: number) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const selection = item as Record<string, unknown>;
    if (typeof selection.assetId !== "string" || seen.has(selection.assetId)) throw invalid();
    seen.add(selection.assetId);
    const asset = common.find(m => m.assetId === selection.assetId);
    if (!asset) throw invalid();
    if (selection.altText !== undefined && selection.altText !== null && typeof selection.altText !== "string") throw invalid();
    if (selection.sortOrder !== undefined && selection.sortOrder !== null && (!Number.isInteger(selection.sortOrder) || Number(selection.sortOrder) < 0)) throw invalid();
    return { ...asset, altText: selection.altText === undefined ? asset.altText : selection.altText as string | null, sortOrder: selection.sortOrder as number | null ?? index };
  }).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}
