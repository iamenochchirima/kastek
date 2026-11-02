import type { GrowthAgentEvent, GrowthAgentTask } from "@kasitek-labs/contracts";
import { apiUrl } from "@/lib/server-api";
import { GrowthAgentRequestError } from "./growth-agents";

type Callbacks = {
  onTask(task: GrowthAgentTask): void;
  onEvents(events: GrowthAgentEvent[], nextCursor: string | null): void;
  onError(error: Error): void;
};
const MAX_FRAME_BYTES = 2097152;
/** Parse transport framing independently of network chunk boundaries, including CRLF. */
export function parseGrowthLiveFrame(frame: string): {event: string; data: unknown} | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.replaceAll("\r\n", "\n").split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? {event, data: JSON.parse(data.join("\n"))} : null;
}
export async function streamGrowthTask(taskId: string, callbacks: Callbacks, signal: AbortSignal, initialCursor?: string): Promise<void> {
  return streamTask(taskId, callbacks, signal, initialCursor);
}
export async function streamGrowthObservation(taskId: string, childTaskId: string, onObservation: (value: import("@kasitek-labs/contracts").GrowthAgentObservation) => void, onError: (error: Error) => void, signal: AbortSignal): Promise<void> {
  return streamTask(taskId, { onTask() {}, onEvents() {}, onError }, signal, undefined, { childTaskId, onObservation });
}
export function assertGrowthObservation(value: import("@kasitek-labs/contracts").GrowthAgentObservation, rootId: string, targetId: string): void {
  if (value.rootTaskId !== rootId || value.task?.id !== targetId || !Array.isArray(value.events) || value.events.some(event => event.taskId !== targetId) || !Array.isArray(value.operations) || value.operations.some(operation => operation.taskId !== targetId) || !(value.nextCursor === null || typeof value.nextCursor === "string")) throw new Error("Live update scope changed.");
}
async function streamTask(taskId: string, callbacks: Callbacks, signal: AbortSignal, initialCursor?: string, observation?: {childTaskId: string; onObservation(value: import("@kasitek-labs/contracts").GrowthAgentObservation): void}): Promise<void> {
  let cursor = initialCursor;
  try {
    while (!signal.aborted) {
      const params = new URLSearchParams({ ...(cursor ? {cursor} : {}), ...(observation ? {childTaskId: observation.childTaskId} : {}) });
      const suffix = params.size ? `?${params}` : "";
      const response = await fetch(apiUrl(`/api/agents/tasks/${encodeURIComponent(taskId)}/${observation ? "activity/live" : "live"}${suffix}`), {signal, credentials: "include", cache: "no-store", headers: {accept: "text/event-stream"}});
      if (!response.ok) throw new GrowthAgentRequestError("Live updates unavailable.", response.status);
      if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) throw new Error("Live updates unavailable.");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "", ended = false, terminal = false;
      try {
        while (!signal.aborted && !ended) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, {stream: true});
          let separator: RegExpExecArray | null;
          while (!signal.aborted && (separator = /\r?\n\r?\n/.exec(buffer))) {
            const source = buffer.slice(0, separator.index);
            if (new TextEncoder().encode(source).byteLength > MAX_FRAME_BYTES) throw new Error("Live update exceeded its size limit.");
            const frame = parseGrowthLiveFrame(source);
            buffer = buffer.slice(separator.index + separator[0].length);
            if (!frame) continue;
            const data = frame.data as {task?: GrowthAgentTask; events?: GrowthAgentEvent[]; nextCursor?: string | null; terminal?: boolean; status?: number};
            if (frame.event === "observation" && observation) {
              const value = frame.data as import("@kasitek-labs/contracts").GrowthAgentObservation;
              assertGrowthObservation(value, taskId, observation.childTaskId);
              cursor = value.nextCursor ?? cursor;
              observation.onObservation(value);
            } else if (frame.event === "task") {
              if (!data?.task || data.task.id !== taskId) throw new Error("Live update scope changed.");
              callbacks.onTask(data.task);
            } else if (frame.event === "events") {
              if (!Array.isArray(data?.events) || data.events.some((event: GrowthAgentEvent) => event.taskId !== taskId) || !(data.nextCursor === null || typeof data.nextCursor === "string")) throw new Error("Live update scope changed.");
              cursor = data.nextCursor ?? cursor;
              callbacks.onEvents(data.events, data.nextCursor ?? null);
            } else if (frame.event === "end") {
              ended = true; terminal = data?.terminal === true;
            } else if (frame.event === "unavailable") {
              throw new GrowthAgentRequestError("Live updates interrupted.", typeof data?.status === "number" ? data.status : 503);
            }
          }
          if (new TextEncoder().encode(buffer).byteLength > MAX_FRAME_BYTES) throw new Error("Live update exceeded its size limit.");
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (signal.aborted || terminal) return;
      if (!ended) throw new Error("Live connection closed before its final observation.");
      // A normal lease rollover reconnects from the last authorized durable cursor.
    }
  } catch (error) {
    if (!signal.aborted) callbacks.onError(error instanceof Error ? error : new Error("Live updates interrupted."));
  }
}
