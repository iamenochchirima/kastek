import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { EvidenceStore } from "../src/execution/context/evidence";
import { connectedModelView } from "../src/capabilities/connected-tools/connected-model-view";
import type { ConnectedObservation } from "../src/capabilities/connected-tools/connected-executor";
import { modelReceiptOutput, readHistory, searchHistory, toolReceiptPreview } from "../src/execution/context/journal";

const fixture=vi.hoisted(()=>({execution:{task:{id:"",turn_sequence:"1",channel_binding:null},connectedBindings:[{alias:"connected.read",digest:"digest"}],configuration:{productBindings:[]}}}));
vi.mock("../src/execution/lifecycle/execution",()=>({loadExecution:async()=>fixture.execution,assertCurrentAuthority:async()=>{}}));
vi.mock("../src/execution/context/evidence-policy",()=>({assertCurrentEvidence:async()=>{}}));

describe("connected receipt history projection",()=>{
  it("uses the same narrowed receipt for preview, search and read without changing the stored receipt",async()=>{
    const taskId=randomUUID();fixture.execution.task.id=taskId;
    const full:ConnectedObservation={status:"ok",bindingId:"internal-binding",operationId:"internal-operation",content:"Business result",truncated:false,
      evidence:{id:"evidence",label:"internal-label",citation:"[1]",contentDigest:"private-digest"},
      observation:{digest:"internal-digest",acquiredAt:"2026-11-03T00:00:00Z",provenance:{kind:"observed"}}};
    const before=structuredClone(full),row={id:"operation",name:"connected.read",state:"completed",output:full,request:{bindingDigest:"digest"},error_code:null,started_at:new Date(),cursor_time:new Date().toISOString()};
    const pool={query:vi.fn(async()=>({rows:[row]}))} as unknown as Pool;
    const evidence={taskManifest:async()=>({}),validateOperation:vi.fn(async()=>{}),retainOperation:vi.fn(async()=>{})} as unknown as EvidenceStore;
    const expected=connectedModelView(full),preview=toolReceiptPreview(row.id,row.name,expected,JSON.stringify(expected));
    const found=await searchHistory(pool,taskId,{part:"operations",limit:1},evidence,"search");
    const recovered=await readHistory(pool,taskId,{operationId:row.id},evidence,"read");
    expect(JSON.parse(recovered.content).output).toEqual(expected);
    expect(found.results[0]!.digest).toBe(preview.digest);
    expect(recovered.digest).toBe(preview.digest);
    expect(recovered.totalBytes).toBe(preview.totalBytes);
    expect(recovered.content).not.toContain("internal-binding");
    expect(recovered.projectionNotice).toContain("start at offset 0");
    const oldPreview=toolReceiptPreview(row.id,row.name,full,JSON.stringify(expected));
    expect(oldPreview.digest).not.toBe(recovered.digest);
    const oldOffset=await readHistory(pool,taskId,{operationId:row.id,offset:oldPreview.totalBytes},evidence,"read");
    expect(oldOffset.offset).toBe(0);
    expect(oldOffset.digest).toBe(recovered.digest);
    expect(JSON.parse(oldOffset.content).output).toEqual(expected);
    expect(full).toEqual(before);
    expect(evidence.validateOperation).toHaveBeenCalledWith(taskId,row.id);
    expect(evidence.retainOperation).toHaveBeenCalledWith(taskId,row.id);
    expect(()=>modelReceiptOutput({...fixture.execution,connectedBindings:[]} as never,row)).toThrowError(expect.objectContaining({code:"EVIDENCE_INTEGRITY"}));
  });
  it("marks changed builtin views for old previews and leaves unchanged views unmarked",async()=>{
    const taskId=randomUUID();fixture.execution.task.id=taskId;
    const evidence={retainOperation:vi.fn(async()=>{})} as unknown as EvidenceStore;
    const row={id:"operation",name:"agents.discover",state:"completed",output:{specialists:[],nextOffset:null},
      request:{arguments:'{"query":"research"}'},error_code:null};
    const pool={query:vi.fn(async()=>({rows:[row]}))} as unknown as Pool;
    const old=toolReceiptPreview(row.id,row.name,row.output,JSON.stringify(row.output));
    const page=await readHistory(pool,taskId,{operationId:row.id,offset:0},evidence,"read");
    expect(page.digest).not.toBe(old.digest);
    expect(page.projectionNotice).toContain("start at offset 0");
    expect(JSON.parse(page.content).output.discoveryNotice.code).toBe("LITERAL_FILTER_NO_MATCH");
    row.request.arguments="{}";
    const unchanged=await readHistory(pool,taskId,{operationId:row.id,offset:0},evidence,"read");
    expect(unchanged.projectionNotice).toBeUndefined();
    expect(unchanged.digest).toBe(old.digest);
  });
});
