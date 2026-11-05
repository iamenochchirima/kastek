import { setTimeout as delay } from "node:timers/promises";
import { parseNativeResponsePolicy, nativePhysicalRequestLimit, readResponsePointer, projectNativeResponse } from "./native-response-policy";
import type { RequestArguments, RequestTemplate, ResolvedOpenApiCredential } from "./openapi";
import { compileOpenApiRequest, injectOpenApiCredentials } from "./openapi";
import { requestDigest, PlatformError } from "../../contracts/contracts";
import { createBoundedFetch, type NetworkAttempt } from "../../infrastructure/connected-network";
import { credentialReflectionVariants } from "../../capabilities/connected-tools/credential-reflection";

export const NATIVE_API_RELEASE = "native-api-v2";
export const NATIVE_API_LIMITS = Object.freeze({ requestBytes: 32768, responseBytes: 1048576, responseDepth: 24, responseNodes: 20000, wallMs: 30000 });
export interface NativeApiOperationRuntime {
  authorizationGeneration?:number; operationId: string; template: RequestTemplate; serverOrigin: string; importDigest: string; policyRevision: number;
  credentialReferences: Record<string, string>; credentials: Record<string, ResolvedOpenApiCredential>;
  effectPolicy: "exact_review" | "owner_reviewed_read";
}
export interface NativeApiOptions {
  deadlineAt: number; signal?: AbortSignal; testLoopback?: boolean;
  beforeAttempt?(attempt: NetworkAttempt): Promise<void>; onAttempt?(attempt: NetworkAttempt): Promise<void>;
  onResponse?(response:{body:unknown;digest:string;observedAt:string}):Promise<void>;
}
export interface NativeApiObservation {
  status: number; isError: boolean; contentType: string; text: string; structuredContent?: unknown;
  content: { type: "text" | "binary"; text?: string; mimeType?: string; digest: string }[];
  rawResult: { status: number; headers: Record<string, string>; body: { encoding: "utf8" | "base64"; data: string }; bodyDigest: string };
  resultDigest: string; acquiredAt: string; effect: "unknown"; reviewRequired: true; attempts: NetworkAttempt[];
}
function fail(code: string, message: string): never { throw new PlatformError(code, 400, message); }
function boundedJson(value: unknown): void {
  const pending = [{ value, depth: 0 }]; let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > NATIVE_API_LIMITS.responseNodes || item.depth > NATIVE_API_LIMITS.responseDepth) fail("API_RESPONSE_LIMIT", "Provider JSON exceeds structural limits");
    if (item.value && typeof item.value === "object") for (const [key, child] of Object.entries(item.value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) fail("API_RESPONSE_INVALID", "Provider JSON contains unsafe property names");
      pending.push({ value: child, depth: item.depth + 1 });
    }
  }
}

function privateCredentialValues(operation:NativeApiOperationRuntime):string[]{
  return Object.values(operation.credentials).flatMap(value=>value.type==="api_key"?[value.value]:value.type==="basic"?[value.password,Buffer.from(`${value.username}:${value.password}`).toString("base64")]:[value.token]).flatMap(credentialReflectionVariants);
}
function rejectDecodedCredentialReflection(value:unknown,secrets:readonly string[]):void{
  const pending:unknown[]=[value];
  while(pending.length){const current=pending.pop();
    if(typeof current==="string"&&secrets.some(secret=>current.includes(secret)))fail("API_CREDENTIAL_REFLECTION","Provider response reflected private credentials");
    if(current&&typeof current==="object")for(const [key,child]of Object.entries(current)){
      if(secrets.some(secret=>key.includes(secret)))fail("API_CREDENTIAL_REFLECTION","Provider response reflected private credentials");pending.push(child);
    }
  }
}

/** The caller must supply a persisted authorized template and current vault-resolved credentials. */
async function executeNativeApiRequest(operation: NativeApiOperationRuntime, args: RequestArguments, options: NativeApiOptions): Promise<NativeApiObservation> {
  if (operation.template.serverOrigin !== operation.serverOrigin || operation.template.effect !== "unknown" || !operation.template.reviewRequired) fail("API_TEMPLATE_INVALID", "Operation does not match its fixed server");
  const compiled = compileOpenApiRequest(operation.template, args, operation.credentialReferences);
  const request = injectOpenApiCredentials(compiled, operation.credentials);
  if (Buffer.byteLength(request.body ?? "") > NATIVE_API_LIMITS.requestBytes) fail("API_REQUEST_LIMIT", "Request body exceeds the provider request limit");
  const secrets=privateCredentialValues(operation);
  const attempts: NetworkAttempt[] = [];
  const deadlineAt = Math.min(options.deadlineAt, Date.now() + NATIVE_API_LIMITS.wallMs);
  let admitted = false;
  const fetcher = createBoundedFetch({ authorizeUrl: url => url.href === request.url && url.origin === operation.serverOrigin,
    headers: request.headers, maxRequestBytes: NATIVE_API_LIMITS.requestBytes, maxResponseBytes: NATIVE_API_LIMITS.responseBytes,
    deadlineAt, maxAttempts: 1, maxRequests: 1, signal: options.signal, testLoopback: options.testLoopback,
    returnProviderErrorResponses: true,
    beforeAttempt: async () => {
      if (admitted) fail("API_ATTEMPT_LIMIT", "This native invocation cannot be repeated"); admitted = true;
      await options.beforeAttempt?.({ attempt: 1, status: null, requestBytes: Buffer.byteLength(request.body ?? ""), responseBytes: 0, elapsedMs: 0, outcome: "in_flight" });
    }, onAttempt: async attempt => { attempts.push(attempt); await options.onAttempt?.(attempt); } });
  const response = await fetcher(request.url, { method: request.method, body: request.body, redirect: "error" });
  const bytes = Buffer.from(await response.arrayBuffer()), headers: Record<string, string> = {};
  for (const name of ["content-type", "etag", "last-modified", "retry-after", "request-id", "x-request-id"]) {
    const value = response.headers.get(name); if (value !== null) headers[name] = value.slice(0, 4096);
  }
  const reflection = Buffer.concat([bytes, Buffer.from(JSON.stringify(headers))]);
  if (secrets.some(secret => reflection.includes(Buffer.from(secret)))) fail("API_CREDENTIAL_REFLECTION", "Provider response reflected private credentials");
  const contentType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
  const json = contentType === "application/json" || contentType.endsWith("+json"), textual = json || contentType.startsWith("text/") || !bytes.length;
  const bodyDigest = requestDigest({ encoding: "base64", data: bytes.toString("base64") });
  let rawText:string|undefined;
  if(textual){try{rawText=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{/* Preserve invalid text as exact private bytes before reporting the protocol error. */}}
  let structuredContent:unknown,invalidJson=false;
  if(json&&rawText?.trim()){
    try{structuredContent=JSON.parse(rawText);}catch{invalidJson=true;}
    if(!invalidJson){boundedJson(structuredContent);rejectDecodedCredentialReflection(structuredContent,secrets);}
  }
  const original={status:response.status,headers,body:{encoding:rawText!==undefined?"utf8" as const:"base64" as const,data:rawText??bytes.toString("base64")},bodyDigest};
  await options.onResponse?.({body:original,digest:requestDigest(original),observedAt:new Date().toISOString()});
  let text="";
  if(textual){
    if(rawText===undefined)return fail("API_RESPONSE_INVALID","Text provider response is not valid UTF-8");
    text=rawText;if(invalidJson)return fail("API_RESPONSE_INVALID","Provider did not return valid JSON");
  }else text=`Provider returned ${contentType} (${bytes.length} bytes). The complete response is in the private operation receipt.`;
  const rawResult = { status: response.status, headers, body: { encoding: textual ? "utf8" as const : "base64" as const,
    data: textual ? new TextDecoder().decode(bytes) : bytes.toString("base64") }, bodyDigest };
  return { status: response.status, isError: !response.ok, contentType, text,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    content: [{ type: textual ? "text" : "binary", ...(textual ? { text } : { mimeType: contentType }), digest: bodyDigest }],
    rawResult, resultDigest: requestDigest(rawResult), acquiredAt: new Date().toISOString(), effect: "unknown", reviewRequired: true, attempts };
}


/** Responses can narrow data and page a declared cursor; they cannot choose a destination or authorize a read. */
export async function executeNativeApiOperation(operation:NativeApiOperationRuntime,args:RequestArguments,options:NativeApiOptions):Promise<NativeApiObservation>{
  const policy=parseNativeResponsePolicy(operation.template.responsePolicy,operation.template.method,operation.template.parameters);
  if(!policy)return executeNativeApiRequest(operation,args,options);
  const maximum=nativePhysicalRequestLimit(policy);
  if(maximum>1&&(operation.effectPolicy!=="owner_reviewed_read"||operation.template.method!=="GET"))
    throw new PlatformError("API_READ_AUTHORIZATION_REQUIRED",403,"Automatic pages and retries require explicit owner authorization of this GET as a read");
  const deadlineAt=Math.min(options.deadlineAt,Date.now()+NATIVE_API_LIMITS.wallMs),attempts:NetworkAttempt[]=[],pages:NativeApiObservation["rawResult"][]=[],items:unknown[]=[],seen=new Set<string>();
  let physical=0,bytes=0,last:NativeApiObservation|undefined,cursor: string|undefined,hasMore=false;
  for(let page=0;page<(policy.pagination?.maxPages??1);page++){
    const input=cursor===undefined?args:{...args,query:{...args.query,[policy.pagination!.cursorParameter]:cursor}};
    for(let retry=0;retry<(policy.retry?.maxAttempts??1);retry++){
      if(Date.now()>=deadlineAt)throw new PlatformError("API_READ_DEADLINE",409,"The API read exceeded its original operation deadline");
      if(physical>=maximum)throw new PlatformError("API_ATTEMPT_LIMIT",409,"The API read reached its physical request limit");
      last=await executeNativeApiRequest(operation,input,{...options,deadlineAt,
        beforeAttempt:async attempt=>{physical++;await options.beforeAttempt?.({...attempt,attempt:physical});},
        onAttempt:async attempt=>{const receipt={...attempt,attempt:physical};attempts.push(receipt);await options.onAttempt?.(receipt);}});
      const size=Buffer.byteLength(JSON.stringify(last.rawResult));bytes+=size;
      if(bytes>NATIVE_API_LIMITS.responseBytes)throw new PlatformError("API_RESPONSE_LIMIT",413,"Combined API response pages exceed their private receipt limit");
      pages.push(last.rawResult);
      if(![429,502,503,504].includes(last.status)||retry+1>=(policy.retry?.maxAttempts??1))break;
      const header=last.rawResult.headers["retry-after"];
      const waiting=header?(/^\d+$/.test(header)?Number(header)*1000:Date.parse(header)-Date.now()):Math.min(200*(retry+1),policy.retry!.maxDelayMs);
      if(!Number.isFinite(waiting)||waiting<0||waiting>policy.retry!.maxDelayMs||Date.now()+waiting>=deadlineAt)break;
      await delay(waiting,undefined,{signal:options.signal});
    }
    if(!last||last.isError)break;
    if((policy.pagination||policy.projection)&&last.structuredContent===undefined)throw new PlatformError("API_RESPONSE_PROJECTION_INVALID",502,"Configured response handling requires a JSON provider response");
    if(!policy.pagination)break;
    const values=readResponsePointer(last.structuredContent,policy.pagination.itemsPointer);
    if(!Array.isArray(values))throw new PlatformError("API_PAGINATION_INVALID",502,"The declared pagination field must contain an array");
    for(const value of values)items.push(projectNativeResponse(value,policy));
    const next=readResponsePointer(last.structuredContent,policy.pagination.nextCursorPointer);
    if(next===undefined||next===null||next===""){cursor=undefined;hasMore=false;break;}
    if(typeof next!=="string"||Buffer.byteLength(next)>2048||/[\x00-\x1f\x7f]/.test(next)||seen.has(next)||next===args.query?.[policy.pagination.cursorParameter])
      throw new PlatformError("API_PAGINATION_INVALID",502,"The provider returned an invalid or repeated cursor");
    cursor=next;seen.add(next);hasMore=true;
  }
  if(!last)throw new PlatformError("API_RESPONSE_INVALID",502,"The API read returned no response");
  const rawResult=pages.length===1?pages[0]!:{status:last.status,headers:last.rawResult.headers,body:{encoding:"utf8" as const,data:JSON.stringify({pages})},bodyDigest:requestDigest(pages)};
  if(Buffer.byteLength(JSON.stringify(rawResult))>2097152)throw new PlatformError("API_RESPONSE_LIMIT",413,"Combined private receipt exceeds its storage limit");
  if(!policy.pagination&&!policy.projection&&!last.isError)return {...last,rawResult,resultDigest:requestDigest(rawResult),attempts};
  const value=last.isError?{error:{status:last.status},...(policy.pagination?{items}:{}),complete:false}
    :policy.pagination?{items,pageCount:pages.filter(page=>page.status>=200&&page.status<300).length,complete:!hasMore,...(hasMore?{nextCursor:cursor}:{})}
      :projectNativeResponse(last.structuredContent,policy);
  boundedJson(value);
  rejectDecodedCredentialReflection(value,privateCredentialValues(operation));
  const text=JSON.stringify(value);
  if(Buffer.byteLength(text)>NATIVE_API_LIMITS.responseBytes)throw new PlatformError("API_RESPONSE_LIMIT",413,"Projected API response exceeds its byte limit");
  return {...last,text,structuredContent:value,content:[{type:"text",text,digest:requestDigest(value)}],rawResult,resultDigest:requestDigest(rawResult),attempts};
}
