import { createHash, createHmac } from "node:crypto";

/** Only for owned local acceptance buckets. No production storage endpoint is accepted. */
export async function privateFixtureBucketRequest(config: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }, method: "PUT" | "GET" | "DELETE", query = ""): Promise<Response> {
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(endpoint.hostname) || !/^agents-ingestion-[a-f0-9]+$/.test(config.bucket)) throw new Error("Only owned local ingestion acceptance buckets are allowed");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex"), hmac = (key: string | Uint8Array, value: string) => createHmac("sha256", key).update(value).digest();
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), day = date.slice(0, 8), path = `/${config.bucket}`, payload = hash("");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date", scope = `${day}/us-east-1/s3/aws4_request`;
  const canonical = [method, path, query, `host:${endpoint.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${date}\n`, signedHeaders, payload].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, day), "us-east-1"), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).digest("hex");
  return fetch(`${endpoint.origin}${path}${query ? `?${query}` : ""}`, { method, signal: AbortSignal.timeout(10000),
    headers: { "x-amz-date": date, "x-amz-content-sha256": payload, authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } });
}
