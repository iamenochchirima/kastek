import { describe, expect, it } from "vitest";
import { agentConfigurationSchema } from "../src/contracts/contracts";
import { customerSetupSchema, customerConfigurationForSetup } from "../src/product/offerings/customer-setup";

export const sampleSetup = () => customerSetupSchema.parse({
 business:{name:"Example business",website:"example.com",description:"Consultations"},
 responsibilities:["answer-questions","customer-support","bookings","enquiries"],
 channels:["website","whatsapp"],booking:{durationMinutes:30,notes:"Weekday mornings"},
 intake:{fields:["name","email","message"]},
 behaviour:{agentName:"Assistant",language:"English",tone:"friendly",handoffInstructions:"Offer support for complaints"},
});
describe("customer setup",()=>{
 it("compiles context into shared grounded configuration without granting actions",()=>{
  const config=agentConfigurationSchema.parse(customerConfigurationForSetup(sampleSetup()));
  expect(config.instructions).toContain("Example business");
  expect(config.instructions).toContain("Never claim availability");
  expect(config.instructions).toContain("name, email, message");
  expect(config.sourceRevisionIds).toEqual([]);
  expect(config.connectedToolBindingIds).toEqual([]);
  expect(config.capabilities.businessActions.enabled).toBe(false);
  expect(config.capabilities.workflows.enabled).toBe(false);
  expect(config.tools).toEqual(["knowledge.search","knowledge.read","channel.request_handoff"]);
 });
 it("rejects duplicate, unsupported or out-of-bounds settings",()=>{
  for(const extra of [{responsibilities:[]},{responsibilities:["bookings","bookings"]},{channels:["website","website"]},{channels:["unknown"]},{booking:{durationMinutes:0,notes:""}},{business:{name:"",website:"",description:""}}])
   expect(customerSetupSchema.safeParse({...sampleSetup(),...extra}).success).toBe(false);
 });
 it("bounds generated instructions within the shared configuration contract",()=>{
  const setup=sampleSetup();setup.business.description="a\n".repeat(750);setup.business.website="a".repeat(2048);setup.booking!.notes="a".repeat(1000);setup.behaviour.handoffInstructions="a".repeat(1000);
  expect(customerSetupSchema.safeParse(setup).success).toBe(false);
  setup.behaviour.handoffInstructions="a".repeat(100);
  expect(()=>agentConfigurationSchema.parse(customerConfigurationForSetup(customerSetupSchema.parse(setup)))).not.toThrow();
 });
 it("does not add unselected enquiry or booking guidance",()=>{
  const setup=sampleSetup();setup.responsibilities=["answer-questions"];
  const config=customerConfigurationForSetup(setup);
  expect(config.instructions).not.toContain("Appointment preferences");
  expect(config.instructions).not.toContain("Collect enquiry details");
 });
});
