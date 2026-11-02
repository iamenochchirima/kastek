import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe,expect,it } from "vitest";
import { recordOrchestrationLifecycle,type OrchestrationLifecycleInput } from "../src/observability/orchestration-lifecycle";

function fixture(){
  const writes:unknown[][]=[];
  const db={async query(_sql:string,args:unknown[]){writes.push(args);return{rows:[{outbox_id:randomUUID(),source_sequence:"1"}]};}} as unknown as PoolClient;
  const input:OrchestrationLifecycleInput={organizationId:randomUUID(),key:`root:${randomUUID()}`,action:"revision",outcome:"pending",revision:2,specialistTasks:3,occurredAt:"2026-10-31T09:00:00.000Z"};
  return{db,writes,input};
}
describe("aggregate orchestration lifecycle producer",()=>{
  it("exports only bounded aggregate facts and standard organization scope",async()=>{
    const f=fixture();await recordOrchestrationLifecycle(f.db,f.input);
    expect(f.writes).toHaveLength(2);const event=f.writes[1]!,envelope=JSON.parse(event[11] as string);
    expect(event[6]).toBe("agent.orchestration.lifecycle@1");expect(event[9]).toBe(f.input.organizationId);
    expect(envelope.data).toEqual({action:"revision",outcome:"pending",revision:2,specialist_tasks:3,occurred_at:f.input.occurredAt});
    expect(JSON.stringify(envelope)).not.toContain(f.input.key);expect(event[5]).toMatch(/^orchestration:[a-f0-9]{64}$/);
  });
  it("records more than the former 64 specialists without imposing a work limit",async()=>{
    const f=fixture();await recordOrchestrationLifecycle(f.db,{...f.input,specialistTasks:70});
    expect(JSON.parse(f.writes[1]![11] as string).data.specialist_tasks).toBe(70);
  });
  it("uses stable record identity and payload for exact persisted-event retries",async()=>{
    const f=fixture();await recordOrchestrationLifecycle(f.db,f.input);await recordOrchestrationLifecycle(f.db,f.input);
    expect(f.writes[1]![5]).toBe(f.writes[3]![5]);expect(f.writes[1]![12]).toBe(f.writes[3]![12]);
    await recordOrchestrationLifecycle(f.db,{...f.input,revision:3});expect(f.writes[5]![5]).not.toBe(f.writes[1]![5]);
  });
  it("rejects private fields, arbitrary outcomes and out-of-policy counts before any write",async()=>{
    const f=fixture();for(const input of [{...f.input,objective:"Private plan"},{...f.input,outcome:"optimistic"},{...f.input,specialistTasks:Number.MAX_SAFE_INTEGER+1},{...f.input,occurredAt:"not a date"}]){
      await expect(recordOrchestrationLifecycle(f.db,input as OrchestrationLifecycleInput)).rejects.toThrow();
    }expect(f.writes).toEqual([]);
  });
});
