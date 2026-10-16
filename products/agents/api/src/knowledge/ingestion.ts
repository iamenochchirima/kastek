export interface BoundedFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

export interface FetchedKnowledgeDocument {
  url: string;
  contentType: string;
  text: string;
  bytes: number;
}

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;

function validateUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Knowledge URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Knowledge URL must use http or https");
  }
  if (url.username || url.password) throw new Error("Knowledge URL may not include credentials");
  return url;
}

export async function fetchBoundedKnowledgeDocument(
  value: string,
  options: BoundedFetchOptions = {},
  fetcher: typeof fetch = fetch,
): Promise<FetchedKnowledgeDocument> {
  const url = validateUrl(value);
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? DEFAULT_MAX_BYTES, 10_000_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetcher(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`Knowledge fetch failed with HTTP ${response.status}`);
    const contentType = (response.headers.get("content-type") ?? "text/plain").split(";", 1)[0]!.trim().toLowerCase();
    if (!(contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/xml")) {
      throw new Error(`Unsupported knowledge content type: ${contentType}`);
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && Number(declaredLength) > maxBytes) throw new Error("Knowledge document exceeds the byte limit");
    if (!response.body) throw new Error("Knowledge response has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Knowledge document exceeds the byte limit");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { url: url.toString(), contentType, text: new TextDecoder().decode(bytes), bytes: total };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Knowledge fetch timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function chunkKnowledgeText(text: string, maxCharacters = 4_000): string[] {
  const limit = Math.max(256, Math.min(maxCharacters, 20_000));
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
    } else if (current.length + paragraph.length + 2 <= limit) {
      current += `\n\n${paragraph}`;
    } else {
      chunks.push(current.slice(0, limit));
      current = paragraph;
    }
    while (current.length > limit) {
      chunks.push(current.slice(0, limit));
      current = current.slice(limit).trimStart();
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
