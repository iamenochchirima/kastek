import type { Pool } from "pg";
import { PlatformError } from "../contracts/contracts";
import { assertCurrentAuthority, loadExecution } from "../execution/lifecycle/execution";
import type { MemoryAssertion, MemoryRecord, MemoryStorePort } from "../contracts/memory";
import { builtinToolEnabled } from "./tool-definitions";
import { fitUtf8 } from "../infrastructure/utf8";
import { validateBuiltinArguments, validateBuiltinResult } from "./tool-contracts";


export interface MemoryEvidencePort {
  recordMemory(taskId: string, operationId: string, memoryId: string, previewBytes?: number): Promise<{ reference: { id: string }; label: string }>;
}
export function memoryPreview(memory: MemoryRecord, includeAssertion = true) {
  const content = fitUtf8(memory.content, 512);
  return { id: memory.id, revision: memory.revision, content, excerpt: content !== memory.content,
    totalBytes: Buffer.byteLength(memory.content, "utf8"), origin: memory.origin, verified: memory.verified, ...(includeAssertion ? { assertion: memory.assertion } : {}),
    updatedAt: memory.updatedAt, expiresAt: memory.expiresAt };
}
const fullMemory = (memory: MemoryRecord, includeAssertion: boolean) => ({ id: memory.id, revision: memory.revision, content: memory.content,
  origin: memory.origin, verified: memory.verified, ...(includeAssertion ? { assertion: memory.assertion } : {}), updatedAt: memory.updatedAt, expiresAt: memory.expiresAt });

/** Product-origin access is checked by the caller before entering the shared tool gateway. */
export async function executeMemoryTool(pool: Pool, store: MemoryStorePort, taskId: string, operationId: string,
  name: "memory.search" | "memory.read" | "memory.propose", input: unknown, evidence?: MemoryEvidencePort): Promise<unknown> {
  const execution = await loadExecution(pool, taskId);
  await assertCurrentAuthority(pool, execution);
  if (!execution.configuration.memory.enabled || execution.task.principal.kind !== "human" || !builtinToolEnabled(execution.configuration, name)) {
    throw new PlatformError("MEMORY_SCOPE_DENIED", 403, "Memory is unavailable");
  }
  const acceptedVersion = execution.toolBindings.find(binding => binding.name === name)?.version;
  const includeAssertion = name === "memory.search" ? !["1", "2"].includes(acceptedVersion ?? "") : name === "memory.read" ? acceptedVersion !== "1" : true;
  const args = validateBuiltinArguments(name, input, acceptedVersion) as { query?: string; offset?: number; memoryId?: string; content?: string; kind?: "semantic" | "episodic"; assertion?: MemoryAssertion };
  const scope = { organizationId: execution.task.organization_id, agentId: execution.agentId, principal: execution.task.principal, taskId };
  const citation = async (memoryId: string, previewBytes?: number) => {
    if (!evidence) return {};
    const passage = await evidence.recordMemory(taskId, operationId, memoryId, previewBytes);
    return { evidence: { evidenceId: passage.reference.id, label: passage.label, citation: `[${passage.label}]` } };
  };
  let result: unknown;
  if (name === "memory.search") {
    const selected = await store.read(scope, args.query, { offset: args.offset, limit: 4 });
    const memories = [];
    for (const memory of selected.memories) memories.push({ ...memoryPreview(memory, includeAssertion), ...await citation(memory.id, 512) });
    result = acceptedVersion === "1" ? { generation: selected.generation, memories: selected.memories.map(memory => ({ id: memory.id, revision: memory.revision, content: fitUtf8(memory.content, 512) })) } :
      { generation: selected.generation, memories, nextOffset: selected.nextOffset };
  } else if (name === "memory.read") {
    const selected = await store.readOne(scope, args.memoryId!);
    result = { generation: selected.generation, memory: { ...fullMemory(selected.memory, includeAssertion), ...await citation(selected.memory.id) } };
  } else {
    const candidate = await store.propose(scope, { operationId, sourceTaskId: taskId, content: args.content!, kind: args.kind!, ...(args.assertion ? { assertion: args.assertion } : {}) });
    result = { candidateId: candidate.id, status: "pending_review" };
  }
  return validateBuiltinResult(name, result, acceptedVersion);
}
