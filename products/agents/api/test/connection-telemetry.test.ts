import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Meter } from "@opentelemetry/api";
import { afterEach,expect,it,vi } from "vitest";
import { PlatformError } from "../src/contracts/contracts";
import {captureConnectionAuthority,connectionControlEventSchema,observeConnectionControl,subscribeConnectionTelemetry} from "../src/observability/connection-telemetry";
import {createConnectionControlMetrics} from "../src/observability/metrics";

afterEach(()=>vi.restoreAllMocks());
it("projects captured authority and failures without provider bodies, credentials or task identities",async()=>{
  const output=vi.spyOn(console,"info").mockImplementation(()=>{}),query=vi.fn(()=>{throw Error("Telemetry must not acquire a database connection");}),pool={query} as unknown as Pool;
  const organizationId=randomUUID(),connectionId=randomUUID(),error=new PlatformError("HOSTILE_PROVIDER_ERROR",502,"Bearer private-token https://private.provider/customer-text");
  await expect(observeConnectionControl(pool,"mcp","discover",{organizationId,connectionId},async()=>{
    captureConnectionAuthority({id:connectionId,organization_id:organizationId,generation:4,policy_revision:3});throw error;
  })).rejects.toBe(error);
  const event=connectionControlEventSchema.parse(JSON.parse(output.mock.calls[0]![0] as string));
  expect(event).toMatchObject({organizationId,connectionId,authorizationGeneration:4,policyRevision:3,outcome:"failed",failureClass:"provider"});
  expect(JSON.stringify(event)).not.toMatch(/private|Bearer|customer-text|taskId|errorMessage|scope/);expect(query).not.toHaveBeenCalled();
});
it("settles immediately when exporters fail or never settle, with no metadata database lookup",async()=>{
  vi.spyOn(console,"info").mockImplementation(()=>{throw Error("Broken logger");});
  const query=vi.fn(()=>new Promise(()=>{})),pool={query} as unknown as Pool;
  const stop=subscribeConnectionTelemetry(()=>{throw Error("Exporter failed");}),rejected=subscribeConnectionTelemetry(async()=>{throw Error("Async exporter failed");}),pending=subscribeConnectionTelemetry(()=>new Promise<void>(()=>{}));
  try{expect(await observeConnectionControl(pool,"native_api","rotate",{},async()=>({generation:7,id:randomUUID(),secret:"private"}))).toMatchObject({generation:7});expect(query).not.toHaveBeenCalled();}
  finally{stop();rejected();pending();}
});
it("keeps concurrent authority captures separate and metrics labels bounded",async()=>{
  const output=vi.spyOn(console,"info").mockImplementation(()=>{}),record=vi.fn(),add=vi.fn(),pool={} as Pool;
  const stop=createConnectionControlMetrics({createHistogram:()=>({record}),createCounter:()=>({add})} as unknown as Meter);
  const ids=[randomUUID(),randomUUID()];
  try{
    await Promise.all(ids.map((id,index)=>observeConnectionControl(pool,"mcp","refresh",{},async()=>{
      captureConnectionAuthority({id,generation:index+1});await Promise.resolve();return {privateText:"Never logged"};
    })));
    expect(output.mock.calls.map(call=>JSON.parse(call[0] as string))).toEqual(expect.arrayContaining(ids.map((id,index)=>expect.objectContaining({connectionId:id,authorizationGeneration:index+1}))));
    expect(add).toHaveBeenCalledTimes(2);expect(record).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[0]![1]).toEqual({provider:"mcp",flow:"refresh",outcome:"completed"});
    expect(JSON.stringify(record.mock.calls)).not.toContain(ids[0]);
  }finally{stop();}
});
