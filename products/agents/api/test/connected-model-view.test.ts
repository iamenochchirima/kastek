import { describe, expect, it } from "vitest";
import { connectedModelView } from "../src/platform/connected-model-view";
import type { ConnectedObservation } from "../src/platform/connected-executor";
const files = Array.from({length:20}, (_,index)=>({fileId:`00000000-0000-4000-8000-${String(index).padStart(12,"0")}`,path:`source-${index}.md`,bytes:100}));
function receipt(content=JSON.stringify({files,nextOffset:20,hasMore:true}),handles:unknown={files:files.map(({fileId})=>({fileId}))}):ConnectedObservation{return {
  status:"ok",bindingId:"binding",operationId:"tool:task:0:0",content,truncated:false,
  evidence:{id:"00000000-0000-4000-8000-000000000001",label:`E${"a".repeat(32)}`,citation:`[E${"a".repeat(32)}]`,contentDigest:"a".repeat(64)},handles,
  observation:{digest:"b".repeat(64),acquiredAt:"2026-10-18T10:00:00Z",provenance:{kind:"commit_snapshot",commitSha:"c".repeat(40)}}
};}
describe("connected model view",()=>{
 it("omits duplicate named handles and internal receipt metadata without changing source text or the receipt",()=>{
  const full=receipt(),before=JSON.stringify(full),view=connectedModelView(full);
  expect(view.content).toBe(full.content);expect(view).not.toHaveProperty("handles");
  expect(view.evidence).toEqual({id:full.evidence.id,citation:full.evidence.citation});expect(view.observation).toEqual({acquiredAt:full.observation.acquiredAt,provenance:full.observation.provenance});
  expect(JSON.stringify(view).length).toBeLessThan(before.length-1000);expect(JSON.stringify(full)).toBe(before);
  expect(JSON.parse(view.content).files).toEqual(files);
 });
 it.each(["plain text",JSON.stringify({differentKey:files}),JSON.stringify({files:[{fileId:"different"}]})])("keeps structured handles absent from exact parsed content",content=>{
  const full=receipt(content);expect(connectedModelView(full).handles).toEqual(full.handles);
 });
 it("retains tool-error content, evidence and timestamped provenance unchanged",()=>{
  const full={...receipt("No public documentation exists",undefined),handles:undefined,status:"tool_error" as const,truncated:true,observation:{digest:"x",acquiredAt:"2026-10-18T10:00:00Z",provenance:{kind:"timestamped_observation",provider:"deepwiki"}}};
  const view=connectedModelView(full);expect(view.status).toBe("tool_error");expect(view.content).toBe(full.content);expect(view.truncated).toBe(true);expect(view.observation.provenance).toEqual(full.observation.provenance);
 });
});
