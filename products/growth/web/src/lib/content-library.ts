import { decodeContentResult } from "./content-library-response";
import { apiUrl } from "@/lib/server-api";

export type MediaAsset = {
  id: string;
  kind: "IMAGE" | "VIDEO";
  mimeType: string;
  fileName: string | null;
  displayName: string | null;
  tags: string[];
  defaultAltText: string | null;
  revision: number;
  archivedAt: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  byteSize: number | string;
  processingStatus: string;
  scanStatus: string;
};
export type ContentTemplate = {
  id: string;
  revision: number;
  name: string;
  description?: string | null;
  category?: string | null;
  content: string;
  channels: string[];
  variants: {
    platform: string;
    content: string;
    media?: {
      assetId: string;
      sortOrder?: number;
      altText?: string | null;
      crop?: unknown;
    }[];
  }[];
  fields: {
    key: string;
    label: string;
    required?: boolean;
    defaultValue?: string;
  }[];
  media: { assetId: string; sortOrder?: number; altText?: string | null }[];
  archivedAt?: string | null;
};
export type LibraryPage<T> = {
  pagination: { nextCursor: string | null; limit: number };
} & T;
const pendingWrites = new Map<string, string>();

export async function contentOperation<T>(
  operation: string,
  input: Record<string, unknown> = {},
  requestId?: string,
): Promise<T> {
  const fingerprint = requestId
    ? `${operation}:${JSON.stringify(input)}`
    : undefined;
  if (fingerprint) {
    requestId = pendingWrites.get(fingerprint) || requestId;
    pendingWrites.set(fingerprint, requestId!);
  }
  const complete = (result: T) => {
    if (fingerprint) pendingWrites.delete(fingerprint);
    return result;
  };
  const business = {
    ...input,
    ...(requestId ? { _requestId: requestId } : {}),
  };
  let continuation: string | undefined;
  let chunks = "";
  for (let page = 0; page < 2000; page++) {
    const response = await fetch(apiUrl(`/v1/operations/${operation}`), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...business,
        ...(continuation ? { _continuation: continuation } : {}),
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload.state !== "succeeded")
      throw new Error(
        payload.error?.message ||
          payload.error ||
          payload.message ||
          "The request failed. Please try again.",
      );
    const result = payload.result;
    if (result && typeof result.chunk === "string") {
      chunks += result.chunk;
      continuation = result.continuation;
      if (continuation) continue;
      return complete(decodeContentResult<T>(chunks));
    }
    return complete(result as T);
  }
  throw new Error("The result is too large to load.");
}
export function mediaSource(assetId: string) {
  return apiUrl(`/api/social/media/${encodeURIComponent(assetId)}`);
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The request failed.";
}

export async function uploadLibraryMedia(file: File) {
  const video = file.type.startsWith("video/");
  if (!video && !file.type.startsWith("image/"))
    throw new Error("Choose an image or video.");
  if (file.size > (video ? 512 : 20) * 1024 * 1024)
    throw new Error(
      video
        ? "Videos must be 512 MB or smaller."
        : "Images must be 20 MB or smaller.",
    );
  const url = URL.createObjectURL(file);
  const body = new FormData();
  body.append("file", file);
  try {
    const metadata = await new Promise<{
      width: number;
      height: number;
      durationMs?: number;
    }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Could not read media metadata.")),
        15000,
      );
      if (video) {
        const element = document.createElement("video");
        element.preload = "metadata";
        element.onloadedmetadata = () => {
          clearTimeout(timeout);
          resolve({
            width: element.videoWidth,
            height: element.videoHeight,
            durationMs: Math.round(element.duration * 1000),
          });
        };
        element.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("Could not read video metadata."));
        };
        element.src = url;
      } else {
        const element = new Image();
        element.onload = () => {
          clearTimeout(timeout);
          resolve({
            width: element.naturalWidth,
            height: element.naturalHeight,
          });
        };
        element.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("Could not read image metadata."));
        };
        element.src = url;
      }
    });
    body.append("width", String(metadata.width));
    body.append("height", String(metadata.height));
    if (metadata.durationMs)
      body.append("durationMs", String(metadata.durationMs));
  } finally {
    URL.revokeObjectURL(url);
  }
  const response = await fetch(apiUrl("/api/social/media"), {
    method: "POST",
    credentials: "include",
    body,
  });
  const result = await response.json();
  if (!response.ok || !result.asset)
    throw new Error(result.error || "Upload failed.");
  return result.asset as MediaAsset;
}

export async function getEditablePost(postId: string) {
  const response = await fetch(
    apiUrl(`/api/social/posts/${encodeURIComponent(postId)}`),
    { credentials: "include" },
  );
  const payload = await response.json();
  if (!response.ok || !payload.post)
    throw new Error(payload.error || "Could not load draft.");
  return payload.post as import("@/components/social/social-shared").SocialPost;
}
