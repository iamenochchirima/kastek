import { createHash,createHmac } from "node:crypto";
import { PlatformError } from "../contracts/contracts";


const sha = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");
const hmac = (key: string | Uint8Array, value: string) => createHmac("sha256", key).update(value).digest();
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
export interface S3PrivateConfig { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; maxBytes?: number }
export interface PrivateObjectStore { put(key: string, content: Uint8Array, contentType: string): Promise<void>; get(key: string): Promise<Uint8Array>; delete(key: string): Promise<void> }
export function privateStoreFromEnvironment(env: NodeJS.ProcessEnv = process.env, maxBytes = 1_048_576): S3PrivateStore | undefined {
  const keys = ["AGENTS_S3_ENDPOINT", "AGENTS_S3_REGION", "AGENTS_S3_BUCKET", "AGENTS_S3_ACCESS_KEY_ID", "AGENTS_S3_SECRET_ACCESS_KEY"] as const;
  if (keys.every(key => !env[key])) return;
  if (keys.some(key => !env[key])) throw new PlatformError("OBJECT_STORE_CONFIGURATION", 503, "Private storage configuration is incomplete");
  return new S3PrivateStore({ endpoint: env.AGENTS_S3_ENDPOINT!, region: env.AGENTS_S3_REGION!, bucket: env.AGENTS_S3_BUCKET!, accessKeyId: env.AGENTS_S3_ACCESS_KEY_ID!, secretAccessKey: env.AGENTS_S3_SECRET_ACCESS_KEY!, maxBytes });
}
export class S3PrivateStore implements PrivateObjectStore {
  readonly maxBytes: number;
  private readonly endpoint: URL;
  constructor(private readonly config: S3PrivateConfig, private readonly fetcher: typeof fetch = fetch) {
    this.endpoint = new URL(config.endpoint);
    if (this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash || this.endpoint.pathname !== "/") throw new PlatformError("OBJECT_STORE_CONFIGURATION", 503, "Private storage endpoint is invalid");
    if (this.endpoint.protocol !== "https:" && !(this.endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(this.endpoint.hostname))) throw new PlatformError("OBJECT_STORE_CONFIGURATION", 503, "Private storage requires HTTPS or local development");
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || !/^[a-z0-9-]{1,32}$/.test(config.region)) throw new PlatformError("OBJECT_STORE_CONFIGURATION", 503, "Private storage location is invalid");
    this.maxBytes = config.maxBytes ?? 1_048_576;
  }
  private async request(method: "GET" | "PUT" | "DELETE", key: string, content?: Uint8Array, contentType?: string): Promise<Uint8Array> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,511}$/.test(key) || key.split("/").some(part => !part || part === "." || part === "..")) throw new PlatformError("ARTIFACT_KEY_INVALID", 400, "Invalid content reference");
    if (content && content.byteLength > this.maxBytes) throw new PlatformError("ARTIFACT_TOO_LARGE", 413, "Content exceeds the storage limit");
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), day = date.slice(0, 8);
    const path = `/${encode(this.config.bucket)}/${key.split("/").map(encode).join("/")}`;
    const payload = sha(content ?? new Uint8Array());
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalHeaders = `host:${this.endpoint.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${date}\n`;
    const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payload].join("\n");
    const scope = `${day}/${this.config.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonicalRequest)}`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, day), this.config.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.endpoint), { method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "x-amz-date": date, "x-amz-content-sha256": payload,
          authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
          ...(contentType ? { "content-type": contentType } : {}) },
        ...(content ? { body: Buffer.from(content) } : {}) });
    } catch { throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable"); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PlatformError(response.status === 404 ? "ARTIFACT_CONTENT_MISSING" : "OBJECT_STORE_UNAVAILABLE", response.status === 404 ? 404 : 503,
        response.status === 404 ? "Content is unavailable" : "Private storage is unavailable");
    }
    if (method !== "GET") { await response.body?.cancel(); return new Uint8Array(); }
    const reader = response.body?.getReader(); if (!reader) throw new PlatformError("ARTIFACT_CONTENT_MISSING", 404, "Content is unavailable");
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > this.maxBytes) { await reader.cancel(); throw new PlatformError("ARTIFACT_TOO_LARGE", 413, "Content exceeds the storage limit"); }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  }
  async put(key: string, content: Uint8Array, contentType: string) { await this.request("PUT", key, content, contentType); }
  get(key: string) { return this.request("GET", key); }
  async delete(key: string) { await this.request("DELETE", key); }
}
