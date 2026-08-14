import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { z } from "zod";

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface StdioForwardInput {
  endpoint: string;
  token: string;
  message: unknown;
  fetchImpl?: typeof fetch;
}

export async function forwardStdioMessage(input: StdioForwardInput): Promise<string | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify(input.message),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new Error("mcp_response_too_large");
  if (!response.ok) throw new Error(`mcp_gateway_http_${response.status}`);
  return body.length > 0 ? body : null;
}

export async function runStdioBridge(input: {
  endpoint: string;
  token: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const source = input.input ?? stdin;
  const destination = input.output ?? stdout;
  const reader = createInterface({ input: source, crlfDelay: Infinity });
  for await (const line of reader) {
    if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
      destination.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32011, message: "mcp_request_too_large" } })}\n`);
      continue;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
      z.object({ jsonrpc: z.literal("2.0"), method: z.string().min(1) }).passthrough().parse(message);
    } catch {
      destination.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid_mcp_request" } })}\n`);
      continue;
    }
    try {
      const response = await forwardStdioMessage({ endpoint: input.endpoint, token: input.token, message, fetchImpl: input.fetchImpl });
      if (response) destination.write(`${response}\n`);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "agent_platform_unavailable";
      destination.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: messageText } })}\n`);
    }
  }
}

if (process.argv[1]?.endsWith("stdio.js") || process.argv[1]?.endsWith("stdio.ts")) {
  if (typeof process.loadEnvFile === "function") process.loadEnvFile(".env");
  const endpoint = process.env.MCP_STDIO_URL?.trim() || "http://127.0.0.1:4200/mcp";
  const token = process.env.MCP_STDIO_TOKEN?.trim();
  if (!token) {
    process.stderr.write("MCP_STDIO_TOKEN is required\n");
    process.exitCode = 1;
  } else {
    runStdioBridge({ endpoint, token }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "stdio_bridge_failed"}\n`);
      process.exitCode = 1;
    });
  }
}
