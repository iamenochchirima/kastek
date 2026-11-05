import {describe,expect,it,vi} from "vitest";
import {enquiryArguments} from "../src/capabilities/enquiries/enquiries";
import {defaultBusinessConfiguration} from "../src/contracts/contracts";
import {confirmValidProposal} from "../src/execution/business/confirmation-proposal";
import {builtinArgumentFeedback} from "../src/capabilities/tool-argument-feedback";

describe("confirmation proposal validation",()=>{
 it.each([
  ["booking.reserve",{start:"not a date"},{start:"2026-11-04T09:00:00Z"}],
  ["enquiry.submit",{fields:{email:"bad-email"}},{fields:{email:"customer@example.test"}}],
  ["enquiry.submit",{fields:{phone:"bad-phone"}},{fields:{phone:"+27 11 123 4567"}}],
  ["enquiry.amend",{enquiryId:"not-a-uuid",fields:{name:"Alex"}},{enquiryId:"b4cb584b-6e67-4c1c-b1df-a6c93bce8fd9",fields:{name:"Alex"}}],
 ])("keeps %s invalid inputs out of confirmation and confirms valid inputs",async(name,invalid,valid)=>{
  const confirm=vi.fn(async()=>"awaiting-decision");
  const raw=JSON.stringify(invalid);
  expect(await confirmValidProposal(name,raw,undefined,confirm)).toEqual({valid:false});
  expect(confirm).not.toHaveBeenCalled();
  expect(builtinArgumentFeedback(name,raw,"TOOL_ARGUMENTS_INVALID")?.argumentIssues.length).toBeGreaterThan(0);
  expect(await confirmValidProposal(name,JSON.stringify(valid),undefined,confirm)).toEqual({valid:true,result:"awaiting-decision"});
  expect(confirm).toHaveBeenCalledOnce();
 });
 it("does not hide confirmation failures",async()=>{
  await expect(confirmValidProposal("booking.reserve",JSON.stringify({start:"2026-11-04T09:00:00Z"}),undefined,async()=>{throw new Error("failure");})).rejects.toThrow("failure");
 });
 it("enforces phone format again at the enquiry write boundary",()=>{
  const base=defaultBusinessConfiguration();
  const config={...base,tools:["enquiry.submit"],capabilities:{...base.capabilities,enquiries:{enabled:true,fields:["phone"]}}} as unknown as typeof base;
  expect(()=>enquiryArguments(config,{fields:{phone:"bad-phone"}})).toThrowError(expect.objectContaining({code:"TOOL_ARGUMENTS_INVALID"}));
  expect(enquiryArguments(config,{fields:{phone:"  +27 11 123 4567  "}}).fields.phone).toBe("+27 11 123 4567");
 });

});
