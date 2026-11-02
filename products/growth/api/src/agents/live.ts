import { setTimeout as delay } from "node:timers/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../error.js";
import type { GrowthAgentScope } from "./scope.js";
import type { GrowthAgentObservation } from "@kasitek-labs/contracts";
import type { GrowthAgentClient } from "./client.js";

const terminal = new Set(["completed", "incomplete", "failed", "cancelled", "uncertain", "refused"]);
/** A bounded read-only connection. Every observation rechecks current membership and task authority. */
export async function streamGrowthTask(request: FastifyRequest, reply: FastifyReply, input: {
  taskId: string; cursor?: string; childTaskId?: string; observation?: boolean;
  scope(): Promise<GrowthAgentScope>;
  client: Pick<GrowthAgentClient, "command">;
}) {
  const response = reply.raw, abort = new AbortController();
  const close = () => abort.abort();
  response.once("close", close);
  const active = () => { if (abort.signal.aborted) throw new DOMException("Observer closed", "AbortError"); };
  let initialScope: GrowthAgentScope;
  try { initialScope = await input.scope(); active(); }
  catch (error) { response.off("close", close); if (abort.signal.aborted) return; throw error; }
  const sameScope = async () => {
    const current = await input.scope();
    if (current.tenantId !== initialScope.tenantId || current.actor.issuer !== initialScope.actor.issuer || current.actor.subject !== initialScope.actor.subject)
      throw new ApiError(403, "agent_scope_changed", "Agent access changed");
    return current;
  };
  let cursor = input.cursor;
  const observe = async () => {
    active();
    const auth = await sameScope();
    active();
    if(input.observation) {
      const publicObservation=await input.client.command(auth,"tasks.observe",{taskId:input.taskId,...(input.childTaskId?{childTaskId:input.childTaskId}:{}),...(cursor?{cursor}:{}),limit:100});
      active();
      return {task:{task:publicObservation.task},events:{events:publicObservation.events,nextCursor:publicObservation.nextCursor},publicObservation};
    }
    const task = await input.client.command(auth, "tasks.get", {taskId: input.taskId});
    active();
    const events = await input.client.command(auth, "tasks.events", {taskId: input.taskId, ...(cursor ? {cursor} : {}), limit: 100});
    active();
    return {task, events,publicObservation:undefined as GrowthAgentObservation|undefined};
  };
  let observation;
  try { observation = await observe(); }
  catch (error) { response.off("close", close); if (abort.signal.aborted) return; throw error; }
  reply.hijack();
  response.writeHead(200, {"content-type": "text/event-stream; charset=utf-8", "cache-control": "private, no-store, no-transform", "x-accel-buffering": "no", "x-content-type-options": "nosniff"});
  response.flushHeaders();
  // A non-draining client cannot hold an observer or stale authorization indefinitely.
  const hardLease = setTimeout(() => { abort.abort(); response.destroy(); }, 60000);
  async function write(name: string, data: unknown) {
    if (abort.signal.aborted || response.destroyed) return false;
    if (response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)) return true;
    return new Promise<boolean>(resolve => {
      const drained = () => { cleanup(); resolve(true); };
      const closed = () => { cleanup(); resolve(false); };
      const cleanup = () => { response.off("drain", drained); response.off("close", closed); abort.signal.removeEventListener("abort", closed); };
      response.once("drain", drained); response.once("close", closed); abort.signal.addEventListener("abort", closed, {once: true});
    });
  }
  const expires = Date.now() + 55000;
  try {
    while (!abort.signal.aborted) {
      if(observation.publicObservation) {
        if(!await write("observation",observation.publicObservation))break;
      } else {
        if (!await write("task", observation.task)) break;
        if (!await write("events", observation.events)) break;
      }
      cursor = observation.events.nextCursor ?? cursor;
      const settled = terminal.has(observation.task.task.state);
      // Drain all durable events, including the terminal transition, before closing.
      if ((observation.events.events.length < 100 && settled) || Date.now() >= expires) {
        await write("end", {terminal: settled && observation.events.events.length < 100}); break;
      }
      if (observation.events.events.length < 100) await delay(1000, undefined, {signal: abort.signal});
      if (!abort.signal.aborted) observation = await observe();
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      const status = error instanceof ApiError ? error.status : 503;
      await write("unavailable", {status, message: status === 401 ? "Sign in to continue." : [403,404].includes(status) ? "Agent access changed." : "Live updates interrupted."});
    }
  } finally {
    clearTimeout(hardLease); abort.abort(); response.off("close", close);
    if (!response.destroyed) response.end();
  }
}

/** Same lease/auth/backpressure lifecycle, with a purpose-built root/child transcript projection. */
export function streamGrowthObservation(request:FastifyRequest,reply:FastifyReply,input:{taskId:string;childTaskId?:string;cursor?:string;scope():Promise<GrowthAgentScope>;client:Pick<GrowthAgentClient,"command">}) {
  return streamGrowthTask(request,reply,{...input,observation:true});
}
