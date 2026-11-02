import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { EXECUTOR_METADATA_ID, encodeExecutorValue, executorSignature, type ExecutorOwner, type ExecutorRequest, type ExecutorRoute } from "../../contracts/executor";
import { ExecutorOwners } from "../../infrastructure/executor-owners";

export function executorRoutes(environment: NodeJS.ProcessEnv = process.env): ExecutorRoute[] | undefined {
  if (!environment.AGENTS_EXECUTOR_ROUTES) return;
  const routes = z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/), url: z.url(), key: z.string().min(32).max(1024) })).min(1).max(32).parse(JSON.parse(environment.AGENTS_EXECUTOR_ROUTES));
  if (new Set(routes.map(route => route.id)).size !== routes.length) throw new Error("Executor route IDs must be unique");
  for (const route of routes) { const url = new URL(route.url); if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Executor routes require HTTPS or explicit local HTTP"); }
  return routes;
}
export class ExecutorClient {
  readonly owners: ExecutorOwners;
  constructor(readonly pool: Pool, readonly routes: ExecutorRoute[], readonly defaultId: string) {
    this.owners = new ExecutorOwners(pool); if (!routes.some(route => route.id === defaultId)) throw new Error("Default executor route is unavailable");
  }
  async call(owner: Pick<ExecutorOwner, "executor_id" | "generation" | "resource_kind" | "allocation_id">, command: ExecutorRequest["command"], payload: unknown, commandId: string = randomUUID()): Promise<any> {
    const route = this.routes.find(route => route.id === owner.executor_id);
    if (!route) throw new PlatformError("EXECUTOR_ROUTE_UNAVAILABLE", 503, "Original executor is unavailable");
    const body: ExecutorRequest = { schemaVersion: "1", executorId: route.id, resourceKind: owner.resource_kind, allocationId: owner.allocation_id,
      generation: owner.generation, commandId, command, issuedAt: Date.now(), payload: encodeExecutorValue(payload) };
    let response: Response;
    try { response = await fetch(`${route.url.replace(/\/$/, "")}/v1/resources/commands`, { method: "POST", redirect: "error", headers: { "content-type": "application/json", "x-executor-signature": executorSignature(body, route.key) }, body: JSON.stringify(body), signal: AbortSignal.timeout(command === "analyze" ? 240_000 : 35_000) }); }
    catch { throw new PlatformError("EXECUTOR_COMMAND_UNCERTAIN", 503, "Executor command outcome is uncertain"); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 20_000_000) { await reader.cancel(); throw new PlatformError("EXECUTOR_RESPONSE_LIMIT", 502, "Executor response exceeds its limit"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    let value: any;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new PlatformError("EXECUTOR_COMMAND_UNCERTAIN", 502, "Executor response is invalid"); }
    if (!response.ok) throw new PlatformError(value.error?.code ?? "EXECUTOR_COMMAND_UNCERTAIN", response.status, "Executor command could not complete");
    return value.result;
  }
  metadata(kind: ExecutorOwner["resource_kind"], command: "available" | "profile", payload: unknown = null) {
    return this.call({ executor_id: this.defaultId, generation: "0", resource_kind: kind, allocation_id: EXECUTOR_METADATA_ID }, command, payload);
  }
  async owner(kind: ExecutorOwner["resource_kind"], id: string): Promise<ExecutorOwner> {
    const row = await this.owners.get(kind, id); if (!row) throw new PlatformError("EXECUTOR_OWNER_UNKNOWN", 503, "Original executor ownership is unknown"); return row;
  }
  async claim(kind: ExecutorOwner["resource_kind"], id: string, payload: unknown, deadline: Date) { return this.owners.claim(kind, id, this.defaultId, requestDigest(payload), deadline); }
  async transfer(kind: ExecutorOwner["resource_kind"], id: string, destination: string) {
    if (!this.routes.some(route => route.id === destination)) throw new PlatformError("EXECUTOR_ROUTE_UNAVAILABLE", 503, "Destination executor is unavailable");
    const owner = await this.owner(kind, id), proof = await this.call(owner, "quiesce", null, `quiesce:${id}`);
    return this.owners.transfer(owner, destination, z.string().regex(/^[a-f0-9]{64}$/).parse(proof.quiescenceReceipt));
  }
}
