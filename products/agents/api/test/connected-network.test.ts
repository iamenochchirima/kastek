import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createBoundedFetch, publicAddress, type NetworkAttempt } from "../src/infrastructure/connected-network";
const servers: Server[] = [];
async function server(handler: Parameters<typeof createServer>[0]) { const value = createServer(handler); servers.push(value); await new Promise<void>(resolve => value.listen(0, "127.0.0.1", resolve)); const address = value.address(); if (!address || typeof address === "string") throw Error(); return `http://127.0.0.1:${address.port}`; }
afterEach(async () => { for (const value of servers.splice(0)) { value.closeAllConnections(); await new Promise<void>(resolve => value.close(() => resolve())); } });
describe("trusted connected network", () => {
  it("rejects private, mapped, transition and special-purpose destinations", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2002:7f00:1::", "64:ff9b::7f00:1"]) expect(publicAddress(address), address).toBe(false);
    expect(publicAddress("1.1.1.1")).toBe(true); expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("pins an authorized loopback fixture, applies trusted headers and records actual bytes", async () => {
    const receipts: NetworkAttempt[] = [];
    const url = await server((request, response) => { expect(request.headers.authorization).toBe("Bearer trusted"); expect(request.headers["x-model-header"]).toBeUndefined(); response.end("verified"); });
    const fetch = createBoundedFetch({ authorizeUrl: value => value.href === `${url}/read`, headers: { authorization: "Bearer trusted" }, maxRequestBytes: 16, maxResponseBytes: 32, deadlineAt: Date.now()+2000, testLoopback: true, onAttempt: attempt => receipts.push(attempt) });
    expect(await (await fetch(`${url}/read`, { headers: { authorization: "model-secret", "x-model-header": "deny" } })).text()).toBe("verified"); expect(receipts[0]?.responseBytes).toBe(8);
    await expect(fetch(`${url}/read?private-memory=secret`)).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
  });
  it("denies production loopback and any redirect outside the exact approved URL", async () => {
    const url = await server((_request, response) => { response.writeHead(302, { location: "/forbidden?secret=1" }).end(); });
    const policy = { authorizeUrl: (value: URL) => value.href === `${url}/read`, maxRequestBytes: 16, maxResponseBytes: 32, deadlineAt: Date.now()+2000 };
    await expect(createBoundedFetch(policy)(`${url}/read`)).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
    await expect(createBoundedFetch({ ...policy, testLoopback: true })(`${url}/read`)).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
  });
  it("honors redirect:error on the same approved endpoint without a second physical send", async()=>{
    let calls=0,claims=0;const receipts:NetworkAttempt[]=[];
    const url=await server((_request,response)=>{calls++;response.writeHead(307,{location:"/read"}).end();});
    const read=createBoundedFetch({authorizeUrl:value=>value.href===`${url}/read`,maxRequestBytes:16,maxResponseBytes:32,deadlineAt:Date.now()+2000,testLoopback:true,beforeAttempt:()=>{claims++;},onAttempt:receipt=>{receipts.push(receipt);}});
    await expect(read(`${url}/read`,{redirect:"error"})).rejects.toMatchObject({code:"DESTINATION_DENIED"});
    expect(calls).toBe(1);expect(claims).toBe(1);expect(receipts).toHaveLength(1);expect(receipts[0]?.status).toBe(307);
  });
  it("caps declared and streamed responses and rejects compressed expansion", async () => {
    const url = await server((request, response) => { if (request.url === "/compressed") response.writeHead(200, { "content-encoding": "gzip" }); response.end("x".repeat(128)); });
    const fetch = createBoundedFetch({ authorizeUrl: () => true, maxRequestBytes: 16, maxResponseBytes: 32, deadlineAt: Date.now()+2000, testLoopback: true });
    await expect(fetch(url)).rejects.toMatchObject({ code: "RESPONSE_LIMIT" });
    await expect(fetch(`${url}/compressed`)).rejects.toMatchObject({ code: "ENCODING_DENIED" });
    await expect(fetch(url, { method: "POST", body: "x".repeat(17) })).rejects.toMatchObject({ code: "REQUEST_LIMIT" });
  });
  it("bounds safe retry attempts and never sleeps beyond the logical deadline", async () => {
    let calls = 0;
    const url = await server((_request, response) => { calls++; response.writeHead(429, { "retry-after": calls < 3 ? "0" : "60" }).end(); });
    const receipts: NetworkAttempt[] = [];
    const fetch = createBoundedFetch({ authorizeUrl: () => true, maxRequestBytes: 16, maxResponseBytes: 32, deadlineAt: Date.now()+2000, testLoopback: true, maxAttempts: 3, onAttempt: attempt => receipts.push(attempt) });
    await expect(fetch(url)).rejects.toMatchObject({ code: "RATE_LIMIT", retryAfterMs: 60000 }); expect(calls).toBe(3); expect(receipts).toHaveLength(3);
  });
  it("classifies an exhausted GitHub-style 403 without retrying before its reset or original deadline",async()=>{
    let calls=0,claims=0;const receipts:NetworkAttempt[]=[],reset=Math.ceil(Date.now()/1000)+60;
    const url=await server((_request,response)=>{calls++;response.writeHead(403,{"x-ratelimit-remaining":"0","x-ratelimit-reset":String(reset),"retry-after":"0"}).end("quota exhausted");});
    const started=Date.now(),read=createBoundedFetch({authorizeUrl:()=>true,maxRequestBytes:0,maxResponseBytes:128,deadlineAt:started+1000,testLoopback:true,maxAttempts:3,beforeAttempt:()=>{claims++;},onAttempt:receipt=>{receipts.push(receipt);}});
    await expect(read(url)).rejects.toMatchObject({code:"RATE_LIMIT",retryAfterMs:expect.any(Number)});expect(Date.now()-started).toBeLessThan(1000);expect(calls).toBe(1);expect(claims).toBe(1);expect(receipts).toHaveLength(1);expect(receipts[0]?.status).toBe(403);
  });
  it("uses declared secondary retry timing within the existing physical attempt bound",async()=>{
    let calls=0;const receipts:NetworkAttempt[]=[];
    const url=await server((_request,response)=>{calls++;if(calls===1)response.writeHead(403,{"retry-after":"0"}).end();else response.end("ready");});
    const read=createBoundedFetch({authorizeUrl:()=>true,maxRequestBytes:0,maxResponseBytes:128,deadlineAt:Date.now()+1000,testLoopback:true,maxAttempts:2,onAttempt:receipt=>{receipts.push(receipt);}});
    expect(await(await read(url)).text()).toBe("ready");expect(calls).toBe(2);expect(receipts.map(receipt=>receipt.status)).toEqual([403,200]);
  });
  it.each([
    {status:401,headers:{"x-ratelimit-remaining":"0","x-ratelimit-reset":"9999999999","retry-after":"0"}},
    {status:403,headers:{}},
    {status:403,headers:{"x-ratelimit-remaining":"1","x-ratelimit-reset":"9999999999"}},
    {status:403,headers:{"retry-after":"not-a-date"}},
  ])("keeps unproven quota responses and 401 as authentication failures",async({status,headers})=>{
    let calls=0;const url=await server((_request,response)=>{calls++;response.writeHead(status,headers).end();});
    const read=createBoundedFetch({authorizeUrl:()=>true,maxRequestBytes:0,maxResponseBytes:128,deadlineAt:Date.now()+1000,testLoopback:true,maxAttempts:3});
    await expect(read(url)).rejects.toMatchObject({code:"AUTHENTICATION"});expect(calls).toBe(1);
  });
  it.each([
    {"x-ratelimit-remaining":"0"},
    {"retry-after":new Date(Date.now()+120000).toUTCString()},
    {"x-ratelimit-remaining":"0","x-ratelimit-reset":"1","retry-after":"60"},
  ])("fails explicitly when a proven 403 has no safe retry before the deadline",async headers=>{
    let calls=0;const url=await server((_request,response)=>{calls++;response.writeHead(403,headers).end();});
    const read=createBoundedFetch({authorizeUrl:()=>true,maxRequestBytes:0,maxResponseBytes:128,deadlineAt:Date.now()+1000,testLoopback:true,maxAttempts:3});
    await expect(read(url)).rejects.toMatchObject({code:"RATE_LIMIT"});expect(calls).toBe(1);
  });
  it("cancels an actual hanging request without waiting for the full deadline", async () => {
    const url = await server(() => undefined), abort = new AbortController();
    const fetch = createBoundedFetch({ authorizeUrl: () => true, maxRequestBytes: 16, maxResponseBytes: 32, deadlineAt: Date.now()+5000, testLoopback: true, signal: abort.signal });
    const pending = fetch(url); setTimeout(() => abort.abort(), 30);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
