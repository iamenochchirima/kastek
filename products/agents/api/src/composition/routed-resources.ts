import type { Pool } from "pg";
import { PlatformError } from "../contracts/contracts";
import { decodeExecutorValue, encodeExecutorValue } from "../contracts/executor";
import { sandboxAllocationId, type SandboxInput, type SandboxManager, type SandboxScope } from "../capabilities/sandbox/sandbox";
import type { DocumentAllocation, DocumentRuntime } from "../platform/knowledge";
import { ExecutorClient } from "../adapters/executors/executor-client";

export type SandboxBackend = Pick<SandboxManager, "available" | "analyze" | "status" | "finalize" | "destroy" | "reap">;
export type DocumentBackend = Pick<DocumentRuntime, "available" | "profile" | "start" | "status" | "result" | "destroy">;
export function routedSandbox(client: ExecutorClient): SandboxBackend {
  return {
    async available() { try { return await client.metadata("sandbox", "available") === true; } catch { return false; } },
    async analyze(scope: SandboxScope, input: SandboxInput) {
      const id = sandboxAllocationId(scope.taskId, input.operationId), existing = await client.owners.get("sandbox", id);
      if (!existing && (await client.pool.query("SELECT id FROM agents_platform.sandbox_allocations WHERE task_id=$1 AND operation_id=$2", [scope.taskId, input.operationId])).rowCount) throw new PlatformError("EXECUTOR_OWNER_UNKNOWN", 503, "Original sandbox executor is unknown");
      const stable = encodeExecutorValue({ scope: { organizationId: scope.organizationId, taskId: scope.taskId, rootTaskId: scope.rootTaskId }, input });
      const owner = await client.claim("sandbox", id, stable, scope.deadlineAt);
      const cached=(await client.pool.query("SELECT c.id,c.export_receipt FROM agents_platform.sandbox_commands c WHERE c.allocation_id=$1",[id])).rows[0];
      if(cached?.export_receipt)return {...cached.export_receipt,allocationId:id,commandId:cached.id,exports:[]};
      const payload = encodeExecutorValue({ scope: { ...scope, deadlineAt: owner.lease_expires_at }, input });
      return decodeExecutorValue(await client.call(owner, "analyze", payload, `analyze:${id}`));
    },
    async status(scope, id) { return decodeExecutorValue(await client.call(await client.owner("sandbox", id), "status", encodeExecutorValue({ scope }))); },
    async finalize(scope, id, artifactRefs = []) { await client.call(await client.owner("sandbox", id), "finalize", encodeExecutorValue({ scope, artifactRefs }), `finalize:${id}`); },
    async destroy(scope, id) { const result=await client.call(await client.owner("sandbox", id), "destroy", encodeExecutorValue({ scope }), `destroy:${id}`);if(result.state!=="destroyed")throw new PlatformError("SANDBOX_CLEANUP_PENDING",503,"Sandbox cleanup is pending");await client.pool.query("UPDATE agents_platform.sandbox_allocations SET state='destroyed',updated_at=now() WHERE id=$1 AND organization_id=$2 AND root_task_id=$3 AND task_id=$4",[id,scope.organizationId,scope.rootTaskId,scope.taskId]); },
    async reap() {
      const rows = (await client.pool.query(`SELECT a.* FROM agents_platform.sandbox_allocations a JOIN agents_platform.tasks root ON root.id=a.root_task_id JOIN agents_platform.tasks owner ON owner.id=a.task_id
        WHERE a.state<>'destroyed' AND (a.lease_expires_at<=now() OR root.state IN ('completed','incomplete','refused','failed','cancelled','uncertain','cancel_requested') OR owner.state IN ('completed','incomplete','refused','failed','cancelled','uncertain','cancel_requested')) ORDER BY a.created_at LIMIT 100`)).rows;
      let count = 0, pending = false;
      for (const row of rows) try { await this.destroy({ organizationId: row.organization_id, taskId: row.task_id, rootTaskId: row.root_task_id, deadlineAt: new Date(row.lease_expires_at) }, row.id); count++; } catch { pending = true; }
      // Admission may die after the durable owner claim but before its native allocation exists.
      // Only the recorded host may confirm the absent physical unit and release that slot.
      const orphans = (await client.pool.query(`SELECT o.* FROM agents_platform.resource_executor_owners o
        LEFT JOIN agents_platform.sandbox_allocations a ON a.id=o.allocation_id
        WHERE o.resource_kind='sandbox' AND a.id IS NULL AND NOT o.quiescent AND o.lease_expires_at<=now()
        ORDER BY o.created_at LIMIT 100`)).rows;
      for (const owner of orphans) try {
        const result = await client.call(owner, "destroy", null, `destroy:${owner.allocation_id}`);
        if (result.state !== "destroyed") throw new PlatformError("SANDBOX_CLEANUP_PENDING", 503, "Sandbox cleanup is pending");
        count++;
      } catch { pending = true; }
      if (pending) throw new PlatformError("SANDBOX_CLEANUP_PENDING", 503, "Sandbox cleanup is pending"); return count;
    },
  };
}
export function routedDocuments(client: ExecutorClient): DocumentBackend {
  return {
    async available(release) { try { return await client.metadata("document", "available", { release }) === true; } catch { return false; } },
    async profile(release) { return client.metadata("document", "profile", { release }); },
    async start(request: DocumentAllocation, signal?: AbortSignal) {
      const stored = (await client.pool.query(`SELECT lease_expires_at FROM agents_platform.document_allocations WHERE id=$1 UNION ALL SELECT lease_expires_at FROM agents_platform.query_embedding_allocations WHERE id=$1`, [request.allocationId])).rows[0];
      if (!stored) throw new PlatformError("DOCUMENT_ALLOCATION_REQUIRED", 403, "Document allocation is unavailable");
      const payload = encodeExecutorValue(request), owner = await client.claim("document", request.allocationId, payload, new Date(stored.lease_expires_at));
      const cancel = () => client.call(owner, "destroy", null, `destroy:${request.allocationId}`);
      if (signal?.aborted) { await cancel(); throw new PlatformError("DOCUMENT_CANCELLED", 409, "Document processing was cancelled"); }
      let cleanup: Promise<unknown> | undefined;
      const abort = () => { cleanup = cancel().catch(() => undefined); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await client.call(owner, "start", payload, `start:${request.allocationId}`);
        if (signal?.aborted) { await cleanup; throw new PlatformError("DOCUMENT_CANCELLED", 409, "Document processing was cancelled"); }
        return result;
      } finally { signal?.removeEventListener("abort", abort); }
    },
    async status(id) { return client.call(await client.owner("document", id), "status", null); },
    async result(id) { return decodeExecutorValue(await client.call(await client.owner("document", id), "result", null)); },
    async destroy(id) { return client.call(await client.owner("document", id), "destroy", null, `destroy:${id}`); },
  };
}
export function routedExecutor(pool: Pool, routes: ConstructorParameters<typeof ExecutorClient>[1], defaultId: string) {
  const client = new ExecutorClient(pool, routes, defaultId); return { client, sandbox: routedSandbox(client), documents: routedDocuments(client) };
}
