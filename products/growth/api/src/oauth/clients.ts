import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { ApiError } from "../error.js";

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
}

export class OAuthError extends ApiError {
  constructor(code: string, message: string, status = 400) {
    super(status, code, message);
  }
}

export function redirectUri(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new OAuthError("invalid_request", "Invalid redirect URI"); }
  if (value.length > 2048 || url.hash || url.username || url.password ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new OAuthError("invalid_request", "Redirect URI must use HTTPS or loopback HTTP without credentials or a fragment");
  return value;
}

export function clientMetadata(value: unknown, id: string, source: "registration" | "document" = "registration"): OAuthClient {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OAuthError("invalid_client_metadata", "Invalid client metadata");
  const input = value as Record<string, unknown>;
  if (input.client_id !== undefined && input.client_id !== id)
    throw new OAuthError("invalid_client_metadata", "Client identity does not match its metadata URL");
  const method = input.token_endpoint_auth_method;
  if (method !== undefined && (typeof method !== "string" || !method.trim()))
    throw new OAuthError("invalid_client_metadata", "Invalid client authentication method");
  if (source === "document" && input.token_endpoint_auth_methods_supported !== undefined) {
    // CIMD choices describe capabilities; the singular field is only a legacy preference.
    const methods = input.token_endpoint_auth_methods_supported;
    if (!Array.isArray(methods) || !methods.length || methods.some(value => typeof value !== "string" || !value.trim()))
      throw new OAuthError("invalid_client_metadata", "Invalid client authentication choices");
    if (!methods.includes("none"))
      throw new OAuthError("invalid_client_metadata", "Only public clients using PKCE are supported");
  } else if (method !== undefined && method !== "none") {
    throw new OAuthError("invalid_client_metadata", "Only public clients using PKCE are supported");
  }
  if (!Array.isArray(input.redirect_uris) || !input.redirect_uris.length || input.redirect_uris.length > 10 || input.redirect_uris.some(v => typeof v !== "string"))
    throw new OAuthError("invalid_client_metadata", "One to ten redirect URIs are required");
  for (const [key, allowed] of [["grant_types", ["authorization_code", "refresh_token"]], ["response_types", ["code"]]] as const)
    if (input[key] !== undefined && (!Array.isArray(input[key]) || (input[key] as unknown[]).some(v => !allowed.includes(v as never))))
      throw new OAuthError("invalid_client_metadata", "Unsupported client grant or response type");
  const name = input.client_name === undefined ? "MCP client" : input.client_name;
  if (typeof name !== "string" || !name.trim() || name.length > 100)
    throw new OAuthError("invalid_client_metadata", "Invalid client name");
  return { id, name: name.trim(), redirectUris: [...new Set((input.redirect_uris as string[]).map(redirectUri))] };
}

const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [address, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",3]] as const)
  blockedV4.addSubnet(address, prefix, "ipv4");
for (const [address,prefix] of [["::",96],["::ffff:0:0",96],["64:ff9b::",96],["64:ff9b:1::",48],["100::",64],["2001::",23],["2001:db8::",32],["2002::",16],["fc00::",7],["fe80::",10],["ff00::",8]] as const)
  blockedV6.addSubnet(address,prefix,"ipv6");

export function publicMetadataAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blockedV4.check(address,"ipv4") : family === 6 && !blockedV6.check(address,"ipv6");
}

/** Resolve once and pin that address to the TLS request, including its original hostname. */
export async function fetchClientMetadata(id: string): Promise<OAuthClient> {
  let url: URL;
  try { url = new URL(id); } catch { throw new OAuthError("invalid_client", "Unknown client"); }
  if (id.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.hash ||
      (url.port && url.port !== "443") || /(?:^localhost$|\.(?:localhost|local|internal)$)/i.test(url.hostname))
    throw new OAuthError("invalid_client", "Client metadata must use a public HTTPS URL");
  let records;
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  try { records = await Promise.race([
    lookup(url.hostname, { all: true }),
    new Promise<never>((_resolve,reject)=>{ dnsTimer=setTimeout(()=>reject(new Error("DNS deadline exceeded")),2000); }),
  ]); }
  catch { throw new OAuthError("invalid_client", "Client metadata could not be resolved"); }
  finally { if(dnsTimer)clearTimeout(dnsTimer); }
  if (!records.length || records.some(record => !publicMetadataAddress(record.address)))
    throw new OAuthError("invalid_client", "Client metadata address is not public");
  const pinned = records[0]!;
  const body = await new Promise<string>((resolve, reject) => {
    const req = request(url, { method: "GET", family: pinned.family, headers: { accept: "application/json" },
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    }, response => {
      if (response.statusCode !== 200 || !response.headers["content-type"]?.includes("application/json")) {
        response.destroy(); reject(new OAuthError("invalid_client", "Client metadata must return JSON without redirecting")); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 32768) req.destroy(new Error("Metadata is too large"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(new Error("Metadata request timed out")), 5000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => reject(new OAuthError("invalid_client", "Client metadata could not be loaded")));
    req.end();
  });
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new OAuthError("invalid_client_metadata", "Invalid metadata JSON"); }
  if ((value as Record<string, unknown>)?.client_id !== id)
    throw new OAuthError("invalid_client_metadata", "Client metadata must identify its exact URL");
  return clientMetadata(value, id, "document");
}
