import { expect,it,vi,afterEach } from "vitest";
import type { Pool } from "pg";
import { readPublicAgentUpdates } from "../src/product/integrations/public-agent-activity";
import { assertCurrentEvidence,taskEvidenceManifest } from "../src/execution/context/evidence-policy";
import { PlatformError } from "../src/contracts/contracts";
vi.mock("../src/execution/context/evidence-policy",async original=>({...await original<typeof import("../src/execution/context/evidence-policy")>(),assertCurrentEvidence:vi.fn(),taskEvidenceManifest:vi.fn()}));
afterEach(()=>vi.clearAllMocks());
function fixture(task:unknown={channel_binding:null,deleted_at:null}) {
 const sql:string[]=[];
 const pool={query:vi.fn(async(query:string)=>{sql.push(query);return {rows:query.includes("SELECT t.channel_binding")?[task].filter(Boolean):Array.from({length:61},(_,index)=>({id:`model:${index}`,text:`Public update ${index}`,completed_at:new Date("2026-11-02T10:00:00Z")}))};})} as unknown as Pool;
 vi.mocked(assertCurrentEvidence).mockResolvedValue(undefined);vi.mocked(taskEvidenceManifest).mockResolvedValue({}as never);
 return {pool,sql};
}
it("selects only durable public preambles, bounded separately from native private reasoning and final output",async()=>{
 const {pool,sql}=fixture();const result=await readPublicAgentUpdates(pool,"task");
 expect(result.updates).toHaveLength(60);expect(result.updatesTruncated).toBe(true);
 expect(result.updates[0]).toEqual({id:"model:59",text:"Public update 59",createdAt:"2026-11-02T10:00:00.000Z"});
 expect(sql[1]).toContain("output->'message'->>'role'='assistant'");
 expect(sql[1]).toContain("kind='model' AND name='model.generate' AND state='completed'");
 expect(sql[1]).toContain("jsonb_array_length(output->'message'->'tool_calls')>0");
 expect(sql[1]).toContain("left(output->'message'->>'content',8192)");expect(sql[1]).not.toMatch(/SELECT \*|reasoning|request|arguments/);
});
it.each([null,{deleted_at:new Date(),channel_binding:null},{deleted_at:null,channel_binding:{deploymentId:"customer"}}])("does not project deleted/missing/customer delivery transcripts",async task=>{
 const {pool,sql}=fixture(task);expect(await readPublicAgentUpdates(pool,"task")).toEqual({updates:[],updatesTruncated:false});expect(sql).toHaveLength(1);expect(assertCurrentEvidence).not.toHaveBeenCalled();
});
it.each([403,404,409,503])("withdraws public updates when current evidence becomes unavailable (%i)",async status=>{
 const {pool,sql}=fixture();vi.mocked(assertCurrentEvidence).mockRejectedValue(new PlatformError("EVIDENCE_UNAVAILABLE",status,"Unavailable"));
 expect(await readPublicAgentUpdates(pool,"task")).toEqual({updates:[],updatesTruncated:false});expect(sql).toHaveLength(1);
});
it("does not disguise database failures as empty public history",async()=>{
 const {pool}=fixture();vi.mocked(assertCurrentEvidence).mockRejectedValue(new Error("database unavailable"));await expect(readPublicAgentUpdates(pool,"task")).rejects.toThrow("database unavailable");
});
