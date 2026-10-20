import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { executeNativeApiOperation, type NativeApiOperationRuntime } from "../src/adapters/providers/native-api";
import { importOpenApiDocument } from "../src/adapters/providers/openapi";
import { createNativeApiCapabilityCatalog, executeGenericNativeApi, nativeApiAdapterManifest } from "../src/capabilities/connected-tools/generic-connected-runtime";
import { createBinding, ExecutableAdapterRegistry } from "../src/contracts/capability-catalog";
import { requestDigest } from "../src/contracts/contracts";

const servers: Server[] = [];
async function fixture(options: { status?: number; binary?: boolean; reflect?: boolean; oversized?: boolean; redirect?: boolean; invalidJson?: boolean; deepJson?: boolean; invalidUtf8?: boolean; escapedReflection?:boolean } = {}) {
  const received: { method?: string; url?: string; authorization?: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    received.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    if (options.redirect) { response.writeHead(307, { location: "/elsewhere" }).end(); return; }
    response.statusCode = options.status ?? 200; response.setHeader("content-type", options.binary ? "image/png" : "application/json"); response.setHeader("etag", '"fixture-1"');
    if (options.binary) { response.end(Buffer.from([0, 255, 1, 127])); return; }
    if (options.escapedReflection) { response.end('{"echo":"\\u0063ontrolled-native-token"}'); return; }
    if (options.invalidUtf8) { response.end(Buffer.from([0xff,0xfe,0x00])); return; }
    if (options.invalidJson) { response.end("not JSON"); return; }
    if (options.deepJson) { response.end("[".repeat(30) + "0" + "]".repeat(30)); return; }
    response.end(JSON.stringify({ result: options.reflect ? request.headers.authorization : options.oversized ? "x".repeat(1048577) : "done", status: response.statusCode }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, serverUrl = origin + "/api";
  const source = { openapi: "3.0.4", info: { title: "Controlled API", version: "1" }, servers: [{ url: serverUrl }],
    components: { securitySchemes: { provider: { type: "http", scheme: "bearer" } } }, security: [{ provider: [] }],
    paths: { "/records/{id}": { post: { operationId: "applyRecord", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["title"], properties: {
        title: { type: "string", maxLength: 40000 }, date: { type: "string", format: "date", nullable: true }, count: { type: "number", format: "int32", minimum: 0 } } } } } }, responses: { "200": { description: "Result" } } } } } };
  const imported = importOpenApiDocument(source, { serverUrl, testLoopback: true });
  const operation: NativeApiOperationRuntime = { operationId: randomUUID(), template: imported.operations[0]!.template!, serverOrigin: origin,
    importDigest: requestDigest(imported), policyRevision: 1, credentialReferences: { provider: "vault:provider" },
    credentials: { "vault:provider": { type: "bearer", token: "controlled-native-token" } }, effectPolicy: "exact_review" };
  return { received, operation, imported, source, origin, runtimeOptions: { deadlineAt: Date.now() + 5000, testLoopback: true } };
}
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const args = { path: { id: "one" }, body: { title: "Approved", date: null, count: 3 } };
describe("bounded native API operation adapter", () => {
  it("sends exact structured inputs and preserves typed JSON and original bytes", async () => {
    const f=await fixture();let admissions=0;
    const result=await executeNativeApiOperation(f.operation,args,{...f.runtimeOptions,beforeAttempt:async()=>{admissions++;}});
    expect(admissions).toBe(1);expect(f.received).toEqual([{method:"POST",url:"/api/records/one",authorization:"Bearer controlled-native-token",body:'{"title":"Approved","date":null,"count":3}'}]);
    expect(result.structuredContent).toEqual({result:"done",status:200});expect(result.rawResult.headers.etag).toBe('"fixture-1"');
    expect(result.rawResult.body).toEqual({encoding:"utf8",data:'{"result":"done","status":200}'});expect(JSON.stringify(result)).not.toContain("controlled-native-token");
    expect(result.effect).toBe("unknown");expect(result.reviewRequired).toBe(true);
  });
  it.each([429,502,503,504])("preserves provider error %s without retry",async status=>{
    const f=await fixture({status}),result=await executeNativeApiOperation(f.operation,args,f.runtimeOptions);
    expect(result.status).toBe(status);expect(result.isError).toBe(true);expect(result.structuredContent).toEqual({result:"done",status});expect(f.received).toHaveLength(1);expect(result.attempts).toHaveLength(1);
  });
  it("preserves binary response bytes without treating them as text",async()=>{
    const f=await fixture({binary:true}),result=await executeNativeApiOperation(f.operation,args,f.runtimeOptions);
    expect(result.rawResult.body).toEqual({encoding:"base64",data:Buffer.from([0,255,1,127]).toString("base64")});expect(result.content[0]).toMatchObject({type:"binary",mimeType:"image/png"});expect(result.text).toContain("4 bytes");
  });
  it("denies admission, changed destinations, path injection and oversized bodies before send",async()=>{
    const f=await fixture();
    await expect(executeNativeApiOperation(f.operation,args,{...f.runtimeOptions,beforeAttempt:async()=>{throw Error("Denied");}})).rejects.toThrow("Denied");
    await expect(executeNativeApiOperation({...f.operation,serverOrigin:"https://other.example.com"},args,f.runtimeOptions)).rejects.toMatchObject({code:"API_TEMPLATE_INVALID"});
    await expect(executeNativeApiOperation(f.operation,{path:{id:"../escape"},body:{title:"Good"}},f.runtimeOptions)).rejects.toMatchObject({code:"OPENAPI_INPUT_INVALID"});
    await expect(executeNativeApiOperation(f.operation,{path:{id:"one"},body:{title:"x".repeat(32769)}},f.runtimeOptions)).rejects.toMatchObject({code:"API_REQUEST_LIMIT"});expect(f.received).toHaveLength(0);
  });
  it("rejects redirects, secret reflection, oversized responses and malformed JSON",async()=>{
    for(const [options,code]of [[{redirect:true},"DESTINATION_DENIED"],[{reflect:true},"API_CREDENTIAL_REFLECTION"],[{oversized:true},"RESPONSE_LIMIT"],[{invalidJson:true},"API_RESPONSE_INVALID"],[{deepJson:true},"API_RESPONSE_LIMIT"]]as const){
      const f=await fixture(options);await expect(executeNativeApiOperation(f.operation,args,f.runtimeOptions)).rejects.toMatchObject({code});expect(f.received).toHaveLength(1);
    }
  });
  it("rejects escaped credential reflection in plain JSON before private capture",async()=>{
    const f=await fixture({escapedReflection:true});let captured=0;
    await expect(executeNativeApiOperation(f.operation,args,{...f.runtimeOptions,onResponse:async()=>{captured++;}})).rejects.toMatchObject({code:"API_CREDENTIAL_REFLECTION"});expect(captured).toBe(0);expect(f.received).toHaveLength(1);
  });
  it("retains invalid UTF-8 as exact private bytes before rejecting the response",async()=>{
    const f=await fixture({invalidUtf8:true});const captured:unknown[]=[];
    await expect(executeNativeApiOperation(f.operation,args,{...f.runtimeOptions,onResponse:async response=>{captured.push(response.body);}})).rejects.toMatchObject({code:"API_RESPONSE_INVALID"});
    expect(captured).toMatchObject([{body:{encoding:"base64",data:Buffer.from([0xff,0xfe,0x00]).toString("base64")}}]);expect(f.received).toHaveLength(1);
  });
  it("registers actual executable bindings with exact schema, import and template pins",async()=>{
    const f=await fixture(),ids={id:randomUUID(),organizationId:randomUUID(),connectionId:randomUUID(),revision:1};
    const registry=new ExecutableAdapterRegistry<typeof executeNativeApiOperation>(),adapter=registry.register(nativeApiAdapterManifest(),executeNativeApiOperation);
    const catalog=createNativeApiCapabilityCatalog(f.imported,ids);expect(catalog.adapter).toEqual(adapter);expect(catalog.tools[0]!.nativeApi).toEqual({templateDigest:f.operation.template.digest,importDigest:requestDigest(f.imported)});
    const binding=createBinding({schemaVersion:1,id:randomUUID(),organizationId:ids.organizationId,catalog:{id:catalog.id,revision:1,digest:catalog.digest},definition:catalog.tools[0]!,adapter,
      transport:"native_http",protocolVersion:null,connection:{id:ids.connectionId,profileId:"custom-api-v1",policyRevision:1},resources:[{kind:"api.origin",id:f.origin}],
      policy:{effect:"reviewed_write",disclosure:"exact_reviewed_payload",retry:"status_only",approval:"exact_single_use",cancel:"reconcile_claimed"},
      limits:{timeoutMs:30000,maxPhysicalAttempts:1,maxPhysicalRequests:1,maxResponseBytes:1048576,maxModelResultBytes:8192}},catalog);
    expect(registry.resolve(binding)).toBe(executeNativeApiOperation);expect((await executeGenericNativeApi(binding,f.operation,args,f.runtimeOptions)).status).toBe(200);
    await expect(executeGenericNativeApi(binding,{...f.operation,importDigest:"f".repeat(64)},args,f.runtimeOptions)).rejects.toMatchObject({code:"API_OPERATION_CHANGED"});expect(f.received).toHaveLength(1);
  });
  it("excludes unconfigured native OAuth operations from executable catalogues",async()=>{
    const f=await fixture(),source={...f.source,components:{securitySchemes:{provider:{type:"oauth2",flows:{authorizationCode:{authorizationUrl:"https://provider.example.com/auth",tokenUrl:"https://provider.example.com/token",scopes:{}}}}}}};
    const imported=importOpenApiDocument(source,{serverUrl:f.origin+"/api",testLoopback:true});expect(imported.operations[0]!.compatible).toBe(true);
    expect(createNativeApiCapabilityCatalog(imported,{id:randomUUID(),organizationId:randomUUID(),connectionId:randomUUID(),revision:1}).tools).toEqual([]);
  });
});
