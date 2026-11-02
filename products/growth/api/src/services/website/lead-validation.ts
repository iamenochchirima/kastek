import { ApiError } from "../../error.js";
export const bad = (message: string) => new ApiError(400, "bad_request", message);
export function optionalUrl(value: string | null | undefined, field: string): string | null {
  const clean = value?.trim() || null;
  if (clean) {
    let url: URL;
    try { url = new URL(clean); } catch { throw bad(field + " must be a valid http(s) URL"); }
    if (!["http:", "https:"].includes(url.protocol)) throw bad(field + " must be a valid http(s) URL");
  }
  return clean;
}
