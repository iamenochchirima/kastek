import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { NetworkAttempt } from "./connected-network";

export const MCP_ADAPTER_RELEASE = "mcp-read-v1-sdk2.3.1";
export const MCP_ADAPTER_LIMITS = Object.freeze({ tools: 100, catalogBytes: 262144, schemaBytes: 32768, schemaDepth: 12, schemaNodes: 1024, resultBytes: 262144, argumentsBytes: 8192, textBytes: 8192, wallMs: 30000, cpuSeconds: 3, heapMiB: 64, addressBytes: 2147483648 });
export interface McpEndpoint { endpoint: string; authorization: string; protocolVersion?: "2026-07-28" | "2025-11-25"; headers?: Record<string, string>; deadlineAt: number; testLoopback?: boolean }
export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; schemaDigest: string }
export interface McpProcessMetrics { peakRssBytes: number; cpuMs: number }
export interface McpCatalog { metrics?: McpProcessMetrics; protocolVersion: string; tools: McpTool[]; attempts: NetworkAttempt[] }
export interface McpObservation { metrics?: McpProcessMetrics; protocolVersion: string; isError: boolean; text: string; structuredContent?: unknown; rawResult: Record<string, unknown>; resultDigest: string; truncated: boolean; attempts: NetworkAttempt[] }
export type McpJob = { kind: "discover"; endpoint: McpEndpoint } | { kind: "call"; endpoint: McpEndpoint; tool: McpTool; arguments: Record<string, unknown> };
export class McpAdapterError extends Error {
  constructor(public readonly code: string, public readonly attempts: NetworkAttempt[] = []) { super(code); }
}
async function isolated<T>(job: McpJob, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new McpAdapterError("CANCELLED");
  const remaining = Math.min(MCP_ADAPTER_LIMITS.wallMs, job.endpoint.deadlineAt - Date.now());
  if (remaining <= 0) throw new McpAdapterError("DEADLINE");
  if (!existsSync("/usr/bin/prlimit")) throw new McpAdapterError("ADAPTER_ISOLATION_UNAVAILABLE");
  const serialized = JSON.stringify(job);
  if (Buffer.byteLength(serialized) > 524288) throw new McpAdapterError("REQUEST_LIMIT");
  const source = join(__dirname, "adapter-process.ts"), compiled = join(__dirname, "adapter-process.js");
  const entry = existsSync(compiled) ? [compiled] : ["--import", require.resolve("tsx"), source];
  return new Promise<T>((resolve, reject) => {
    // prlimit and the V8 heap bound apply before the SDK or an untrusted schema is loaded.
    const child = spawn("/usr/bin/prlimit", [`--cpu=${MCP_ADAPTER_LIMITS.cpuSeconds}:${MCP_ADAPTER_LIMITS.cpuSeconds}`, `--as=${MCP_ADAPTER_LIMITS.addressBytes}`, process.execPath,
      "--jitless", `--max-old-space-size=${MCP_ADAPTER_LIMITS.heapMiB}`, "--max-semi-space-size=4", "--disable-proto=throw", ...entry], {
      stdio: ["pipe", "pipe", "pipe"], env: { LANG: "C.UTF-8", TZ: "UTC" },
    });
    const attempts = new Map<number, NetworkAttempt>();
    const decoder = new StringDecoder("utf8");
    let pending = "", result: { ok: boolean; code?: string; attempts?: NetworkAttempt[]; value?: T } | undefined;
    let bytes = 0, stderrBytes = 0, failure: string | undefined;
    const terminate = (code: string) => { failure ??= code; child.kill("SIGKILL"); };
    const timer = setTimeout(() => terminate("DEADLINE"), remaining);
    const cancel = () => terminate("CANCELLED"); signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length; if (bytes > 600000) { terminate("ADAPTER_OUTPUT_LIMIT"); return; }
      pending += decoder.write(chunk);
      for (;;) {
        const end = pending.indexOf("\n"); if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.event === "attempt" && Number.isInteger(frame.value?.attempt) && frame.value.attempt >= 1 && frame.value.attempt <= 7) attempts.set(frame.value.attempt, frame.value);
          else if (typeof frame.ok === "boolean") result = frame;
          else terminate("ADAPTER_OUTPUT_INVALID");
        } catch { terminate("ADAPTER_OUTPUT_INVALID"); }
      }
    });
    // Never forward stderr: library errors can include credentials, headers, or remote bodies.
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8192) terminate("ADAPTER_DIAGNOSTIC_LIMIT"); });
    child.stdin.on("error", () => { /* The exit handler reports an exhausted or terminated child. */ });
    child.once("error", () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new McpAdapterError("ADAPTER_ISOLATION_UNAVAILABLE")); });
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      if (failure || code !== 0) { reject(new McpAdapterError(failure ?? "ADAPTER_RESOURCE_LIMIT", [...attempts.values()])); return; }
      try { if (!result) throw Error(); if (!result.ok) reject(new McpAdapterError(typeof result.code === "string" && /^[A-Z0-9_]{1,80}$/.test(result.code) ? result.code : "MCP_PROTOCOL", result.attempts ?? [...attempts.values()])); else resolve(result.value as T); }
      catch { reject(new McpAdapterError("ADAPTER_OUTPUT_INVALID")); }
    });
    child.stdin.end(serialized);
  });
}
export function discoverMcpCatalog(endpoint: McpEndpoint, signal?: AbortSignal): Promise<McpCatalog> { return isolated({ kind: "discover", endpoint }, signal); }
export function callMcpTool(endpoint: McpEndpoint, tool: McpTool, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<McpObservation> { return isolated({ kind: "call", endpoint, tool, arguments: arguments_ }, signal); }
