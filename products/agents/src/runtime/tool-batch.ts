import type { ModelToolCall } from "../model/types";
import type { ToolDefinition } from "../tools/types";

export type ToolBatchSegment = {
  kind: "parallel" | "sequential";
  calls: Array<{ call: ModelToolCall; index: number }>;
};

export type DeduplicableToolCall = {
  id: string;
  name: string;
  argumentsHash: string;
};

/**
 * Marks exact duplicate proposals as aliases of their first occurrence. The
 * caller still keeps every proposal so each provider call receives a paired
 * result, but only the canonical operation may cross the capability seam.
 */
export function markDuplicateToolCalls<T extends DeduplicableToolCall>(calls: readonly T[]): Array<T & { deduplicatedFrom?: string }> {
  const firstByKey = new Map<string, string>();
  return calls.map((call) => {
    const key = `${call.name}:${call.argumentsHash}`;
    const canonicalId = firstByKey.get(key);
    if (canonicalId) return { ...call, deduplicatedFrom: canonicalId };
    firstByKey.set(key, call.id);
    return { ...call };
  });
}

/**
 * Read operations are safe to overlap by default. Mutating or approval-gated
 * capabilities are barriers unless a future capability manifest explicitly
 * opts them into parallel execution.
 */
export function isParallelSafeTool(manifest: Omit<ToolDefinition, "handler"> | undefined): boolean {
  if (!manifest || manifest.requiresApproval) return false;
  if (manifest.parallelSafe === true) return true;
  return manifest.riskClass === "read";
}

export function planToolBatch(
  calls: readonly ModelToolCall[],
  getManifest: (name: string) => Omit<ToolDefinition, "handler"> | undefined,
): ToolBatchSegment[] {
  const segments: ToolBatchSegment[] = [];
  let parallel: ToolBatchSegment["calls"] = [];

  const flushParallel = (): void => {
    if (!parallel.length) return;
    segments.push({ kind: "parallel", calls: parallel });
    parallel = [];
  };

  calls.forEach((call, index) => {
    if (isParallelSafeTool(getManifest(call.name))) {
      parallel.push({ call, index });
      return;
    }
    flushParallel();
    segments.push({ kind: "sequential", calls: [{ call, index }] });
  });
  flushParallel();
  return segments;
}

export async function mapBounded<T, R>(
  values: readonly T[],
  worker: (value: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  if (!values.length) return [];
  const width = Math.max(1, Math.min(values.length, Math.trunc(concurrency) || 1));
  const results = new Array<R>(values.length);
  let cursor = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: width }, () => runWorker()));
  return results;
}
