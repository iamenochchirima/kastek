import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { TelegramSetupService } from "../src/product/channels/telegram-setup";
import type { ChannelConnection } from "../src/contracts/channel-connections";
import type { ChannelStore } from "../src/product/channels/channel-store";
import { PlatformError } from "../src/contracts/contracts";
const scope = { organizationId: "org", accountId: "owner" };
const callback = "https://agents.example.com/hooks/telegram/bot";
function fixture() {
  let row = { id: "bot", kind: "telegram", mode: "bot", name: "Support", state: "pending", revision: 1, metadata: {}, assetId: null } as ChannelConnection;
  let credentials: Record<string,string> = {}, owner = true, url = "", lostAck = false, expired = false;
  let claim: { id: string; state: string } | undefined;
  const calls: {method:string; body:Record<string,unknown>}[] = [];
  let barrier: (()=>Promise<void>) | undefined;
  const query = async (sql: string, values: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO agents_platform.channel_setup_claims")) {
      if (claim && claim.state !== "complete") return { rows:[], rowCount:0 };
      claim = { id: String(values[2]), state: "started" }; expired = false; return { rows:[{claim_id:claim.id}], rowCount:1 };
    }
    if (sql.includes("AS remaining_ms FROM agents_platform.channel_setup_claims")) return { rows:[{remaining_ms:100}], rowCount: claim?.id === values[2] && claim.state === "started" && !expired ? 1 : 0 };
    if (sql.includes("SELECT claim_id,state")) return { rows: claim ? [{claim_id:claim.id,state:claim.state,expired}] : [], rowCount:claim?1:0 };
    if (sql.includes("UPDATE agents_platform.channel_setup_claims")) { if (claim?.id === values[2]) claim.state = String(values[3] ?? "complete"); return {rows:[],rowCount:1}; }
    throw new Error("Unexpected SQL");
  };
  const pool = { query, connect: async()=>({query,release(){}}) } as unknown as Pool;
  const auth = () => { if (!owner) throw new PlatformError("ACCESS_DENIED",403,"Owner required"); };
  const store = { pool,
    async create(_scope: unknown, input: any) { auth(); credentials = {...input.credentials}; row = {...row,...input}; delete (row as any).credentials; return structuredClone(row); },
    async get(){ return structuredClone(row); },
    async resolveSetupCredential(_scope:unknown,_id:string,rev:number) { auth(); if(rev!==row.revision) throw new PlatformError("CHANNEL_CONNECTION_CHANGED",409,"Changed"); return {...credentials}; },
    async update(_scope:unknown,_id:string,input:any) { auth(); if(input.expectedRevision!==row.revision) throw new PlatformError("CHANNEL_CONNECTION_CHANGED",409,"Changed");
      if(input.credentials) credentials={...input.credentials}; const {credentials:_,expectedRevision:__,...rest}=input; row={...row,...rest,revision:row.revision+1}; return structuredClone(row); },
    async disconnect(_scope:unknown,_id:string,rev:number){auth(); expect(rev).toBe(row.revision); row={...row,state:"disconnected",revision:row.revision+1};credentials={}; return structuredClone(row);},
  } as unknown as ChannelStore;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const method = String(input).split("/").at(-1)!; const body=JSON.parse(String(init?.body)); calls.push({method,body});
    expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (barrier) await barrier(); let result: unknown;
    if(method==="getMe") result={id:123,is_bot:true,first_name:"Support",username:"support_bot"};
    else if(method==="getWebhookInfo") result={url};
    else if(method==="setWebhook") {url=body.url;if(lostAck)throw new Error(`secret ${credentials.botToken}`);result=true;}
    else if(method==="deleteWebhook"){url="";result=true;} else throw new Error("Unexpected method");
    return Response.json({ok:true,result});
  };
  const service = new TelegramSetupService(store,{fetch,callbackUrl:()=>callback,timeoutMs:100});
  return { service, calls, store, fetch, get row(){return row;},get credentials(){return credentials;},get claim(){return claim;},set owner(v:boolean){owner=v;},set url(v:string){url=v;},set lostAck(v:boolean){lostAck=v;},set expired(v:boolean){expired=v;},set barrier(v:(()=>Promise<void>)|undefined){barrier=v;} };
}
const input={name:"Support",botToken:"123:private_key"};
describe("Telegram owner onboarding",()=>{
  it("activates only after acknowledged setup and verification; returns no secrets",async()=>{
    const f=fixture(), result=await f.service.connect(scope,input); expect(result.status).toBe("active"); expect(result.connection.assetId).toBe("123");
    expect(f.calls.map(c=>c.method)).toEqual(["getMe","getWebhookInfo","setWebhook","getWebhookInfo"]);
    expect(f.credentials.webhookSecret).toMatch(/^[a-f0-9]{64}$/);expect(f.credentials.verifiedWebhookUrl).toBe(callback);
    expect(JSON.stringify(result)).not.toContain("private_key");expect(JSON.stringify(result)).not.toContain(f.credentials.webhookSecret);
    expect(f.calls[2]!.body).toEqual({url:callback,secret_token:f.credentials.webhookSecret,allowed_updates:["message","callback_query"]});expect(f.claim?.state).toBe("complete");
  });
  it("rejects nonowners before traffic",async()=>{const f=fixture();f.owner=false;await expect(f.service.connect(scope,input)).rejects.toMatchObject({code:"ACCESS_DENIED"});expect(f.calls).toHaveLength(0);});
  it("binds foreign webhook confirmation to observed URL and revision",async()=>{
    const f=fixture();f.url="https://other.example.com/private";const result=await f.service.connect(scope,input);
    expect(result.status).toBe("replacement_required");expect(f.calls.some(c=>c.method==="setWebhook")).toBe(false);f.url="https://different.example.com/private";
    const stale=await f.service.setup(scope,"bot",{expectedRevision:f.row.revision,confirmReplacement:result.replacementConfirmation});expect(stale.status).toBe("replacement_required");expect(stale.replacementConfirmation).not.toBe(result.replacementConfirmation);
    expect((await f.service.setup(scope,"bot",{expectedRevision:f.row.revision,confirmReplacement:stale.replacementConfirmation})).status).toBe("active");
  });
  it("retains lost ack until explicit expired-claim health and confirmed retry",async()=>{
    const f=fixture();f.lostAck=true;expect((await f.service.connect(scope,input)).status).toBe("needs_attention");expect(f.claim?.state).toBe("uncertain");expect(f.credentials.verifiedWebhookUrl).toBeUndefined();
    await expect(f.service.setup(scope,"bot",{expectedRevision:f.row.revision})).rejects.toMatchObject({code:"TELEGRAM_SETUP_RECONCILIATION_REQUIRED"});
    await expect(f.service.health(scope,"bot",f.row.revision)).rejects.toMatchObject({code:"TELEGRAM_SETUP_IN_PROGRESS"});
    f.expired=true;expect((await f.service.health(scope,"bot",f.row.revision)).status).toBe("needs_attention");expect(f.claim?.state).toBe("complete");f.lostAck=false;
    const confirm=await f.service.setup(scope,"bot",{expectedRevision:f.row.revision});expect(confirm.status).toBe("replacement_required");
    expect((await f.service.setup(scope,"bot",{expectedRevision:f.row.revision,confirmReplacement:confirm.replacementConfirmation})).status).toBe("active");
  });
  it("rejects overlapping setup through shared persisted claim",async()=>{
    const f=fixture();let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
    f.barrier=async()=>{entered();await wait;};const first=f.service.connect(scope,input);await ready;
    await expect(f.service.setup(scope,"bot",{expectedRevision:f.row.revision})).rejects.toMatchObject({code:"TELEGRAM_SETUP_RECONCILIATION_REQUIRED"});release();await first;expect(f.calls.filter(c=>c.method==="setWebhook")).toHaveLength(1);
  });
  it("deletes owned webhook without dropping updates and verifies removal",async()=>{const f=fixture();await f.service.connect(scope,input);expect((await f.service.disconnect(scope,"bot",f.row.revision)).status).toBe("disconnected");expect(f.calls.find(c=>c.method==="deleteWebhook")!.body).toEqual({});expect(f.credentials).toEqual({});});
  it("never deletes foreign webhook",async()=>{const f=fixture();await f.service.connect(scope,input);f.url="https://foreign.example.com/hook";expect((await f.service.disconnect(scope,"bot",f.row.revision)).status).toBe("needs_attention");expect(f.calls.some(c=>c.method==="deleteWebhook")).toBe(false);});
  it("fences stale revisions before any provider request",async()=>{
    const f=fixture();await f.service.connect(scope,input);const count=f.calls.length;
    await expect(f.service.setup(scope,"bot",{expectedRevision:1})).rejects.toMatchObject({code:"CHANNEL_CONNECTION_CHANGED"});expect(f.calls).toHaveLength(count);
  });
  it("checks owner authority again for existing setup, health and disconnect",async()=>{
    const f=fixture();await f.service.connect(scope,input);f.owner=false;const count=f.calls.length;
    await expect(f.service.setup(scope,"bot",{expectedRevision:f.row.revision})).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(f.service.health(scope,"bot",f.row.revision)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(f.service.disconnect(scope,"bot",f.row.revision)).rejects.toMatchObject({code:"ACCESS_DENIED"});expect(f.calls).toHaveLength(count);
  });
  it("does not generate a physical setup operation after the claim deadline",async()=>{
    const f=fixture();f.barrier=async()=>{f.expired=true;};expect((await f.service.connect(scope,input)).status).toBe("needs_attention");
    expect(f.calls.map(c=>c.method)).toEqual(["getMe"]);expect(f.claim?.state).toBe("uncertain");
  });
  it("health verifies acknowledged owned setup without changing its revision",async()=>{
    const f=fixture();const result=await f.service.connect(scope,input);expect((await f.service.health(scope,"bot",f.row.revision)).status).toBe("active");expect(f.row.revision).toBe(result.connection.revision);
  });
  it("rotates write-only credentials and requires confirmation before replacing the existing webhook",async()=>{
    const f=fixture();await f.service.connect(scope,input);const oldSecret=f.credentials.webhookSecret;
    const rotated=await f.service.rotate(scope,"bot",{expectedRevision:f.row.revision,botToken:"123:replacement_key"});expect(rotated.status).toBe("replacement_required");
    expect(f.credentials.botToken).toBe("123:replacement_key");expect(f.credentials.webhookSecret).not.toBe(oldSecret);expect(f.row.state).toBe("pending");
  });
  it.each(["http://example.com/hook","https://127.0.0.1/hook","https://[::1]/hook","https://localhost/hook","https://x.local/hook","https://user:pass@example.com/hook","https://example.com/hook?key=value"])("rejects unsafe callback %s",async url=>{const f=fixture(),s=new TelegramSetupService(f.store,{fetch:f.fetch,callbackUrl:()=>url});await expect(s.connect(scope,input)).rejects.toMatchObject({code:"TELEGRAM_CALLBACK_INVALID"});expect(f.calls).toHaveLength(0);});
});
