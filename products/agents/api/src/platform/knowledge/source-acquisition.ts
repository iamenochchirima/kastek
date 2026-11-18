import { createHash } from "node:crypto";
import { SOURCE_LIMITS } from "../../contracts/source-contracts";
import { ConnectedNetworkError,createBoundedFetch,type NetworkAttempt } from "../../infrastructure/connected-network";

export const SOURCE_ACQUISITION_RELEASE = "public-url-v1";
export interface SourceUrlAuthorization {
  /** Loaded from an owner-authorized import or a server-issued resource handle, never composed from model text. */
  url: string;
  redirectUrls?: readonly string[];
  deadlineAt: number;
  testLoopback?: boolean;
}
export interface AcquiredSource {
  bytes: Buffer;
  rawDigest: string;
  format: "pdf" | "html" | "text" | "markdown";
  contentType: string;
  acquiredAt: string;
  finalUrl: string;
  etag: string | null;
  lastModified: string | null;
  attempts: NetworkAttempt[];
}
export class SourceAcquisitionError extends Error {
  constructor(public readonly code: string, public readonly attempts: NetworkAttempt[] = [], public readonly status?: number) { super(code); }
}
const formats: Record<string, AcquiredSource["format"]> = { "application/pdf": "pdf", "text/html": "html", "text/plain": "text", "text/markdown": "markdown" };
export async function acquirePublicSource(authorization: SourceUrlAuthorization, signal?: AbortSignal): Promise<AcquiredSource> {
  const attempts: NetworkAttempt[] = [];
  try {
    if ((authorization.redirectUrls?.length ?? 0) > 3) throw new SourceAcquisitionError("SOURCE_URL_DENIED");
    const allowed = new Set([authorization.url, ...(authorization.redirectUrls ?? [])].map(value => {
      const url = new URL(value);
      if (url.username || url.password || url.hash || Buffer.byteLength(url.href) > 8192) throw new SourceAcquisitionError("SOURCE_URL_DENIED");
      return url.href;
    }));
    const fetch = createBoundedFetch({ authorizeUrl: url => allowed.has(url.href), maxRequestBytes: 0, maxResponseBytes: SOURCE_LIMITS.rawBytes, responseProfile: "source-import-v1",
      deadlineAt: authorization.deadlineAt, maxAttempts: 3, maxRequests: 3, signal, testLoopback: authorization.testLoopback,
      headers: { accept: "text/plain, text/markdown, application/pdf, text/html", "user-agent": "KasitekSourceAcquisition/1.0" }, onAttempt: attempt => attempts.push(attempt) });
    const response = await fetch(authorization.url);
    if (response.status !== 200) throw new SourceAcquisitionError("SOURCE_HTTP_REJECTED", attempts, response.status);
    const declaredType = response.headers.get("content-type") ?? "";
    const contentType = declaredType.split(";", 1)[0]!.trim().toLowerCase(), format = formats[contentType];
    if (!format) throw new SourceAcquisitionError("SOURCE_FORMAT_UNSUPPORTED", attempts);
    const charset = /;\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(declaredType)?.[1]?.toLowerCase();
    if (format !== "pdf" && charset && !["utf-8", "utf8", "us-ascii"].includes(charset)) throw new SourceAcquisitionError("SOURCE_ENCODING_UNSUPPORTED", attempts);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new SourceAcquisitionError("SOURCE_EMPTY", attempts);
    if (format !== "pdf") {
      try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new SourceAcquisitionError("SOURCE_ENCODING_UNSUPPORTED", attempts); }
    }
    const etag = response.headers.get("etag"), modified = response.headers.get("last-modified");
    return { bytes, rawDigest: createHash("sha256").update(bytes).digest("hex"), format, contentType, acquiredAt: new Date().toISOString(), finalUrl: response.url,
      etag: etag && etag.length <= 1024 ? etag : null, lastModified: modified && modified.length <= 128 && Number.isFinite(Date.parse(modified)) ? modified : null, attempts };
  } catch (error) {
    if (error instanceof SourceAcquisitionError) throw error;
    if (error instanceof ConnectedNetworkError) throw new SourceAcquisitionError(error.code === "AUTHENTICATION" ? "SOURCE_AUTHENTICATION_UNSUPPORTED" : error.code, attempts);
    throw new SourceAcquisitionError("SOURCE_ACQUISITION_FAILED", attempts);
  }
}
