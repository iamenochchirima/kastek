import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import type {OperationsSource} from "@kasitek-labs/contracts";
export const OPERATIONS_AUTHORITY_HEADER="x-kasitek-operations-authority";
export type OperationsServiceScope="signals:read"|"notifications:publish";
export interface OperationsServiceRequest {secret:string;audience:OperationsSource;scope:OperationsServiceScope;environment:string;method:string;path:string;body?:string;now?:number}
export interface OperationsServiceClaims {issuer:"kasitek-operations";subject:"operations-observer"|"operations-notifier";audience:OperationsSource;scope:OperationsServiceScope;environment:string;method:string;path:string;digest:string;issuedAt:number;expiresAt:number;nonce:string}
const hash=(body="")=>createHash("sha256").update(body).digest("hex");
function validate(input:OperationsServiceRequest){
 if(Buffer.byteLength(input.secret)<32||!input.environment||input.environment.length>64||!["growth","agents","agency","analytics"].includes(input.audience))throw Error("Invalid operations service configuration");
 const read=input.scope==="signals:read"&&input.method==="GET"&&input.path==="/internal/operations/signals"&&!input.body;
 const publish=input.scope==="notifications:publish"&&input.audience==="growth"&&input.method==="POST"&&input.path==="/internal/operations/notifications";
 if(!read&&!publish)throw Error("Unsupported operations service authority");
}
export function createOperationsServiceAuthority(input:OperationsServiceRequest):string{
 validate(input);const issuedAt=input.now??Date.now();
 const claims:OperationsServiceClaims={issuer:"kasitek-operations",subject:input.scope==="signals:read"?"operations-observer":"operations-notifier",audience:input.audience,scope:input.scope,environment:input.environment,method:input.method,path:input.path,digest:hash(input.body),issuedAt,expiresAt:issuedAt+30000,nonce:randomUUID()};
 const payload=Buffer.from(JSON.stringify(claims)).toString("base64url");return payload+"."+createHmac("sha256",input.secret).update(payload).digest("base64url");
}
export function verifyOperationsServiceAuthority(token:string,input:OperationsServiceRequest):OperationsServiceClaims{
 validate(input);if(typeof token!=="string"||token.length>4096)throw Error("Invalid operations service authority");
 const [payload,signature,extra]=token.split(".");if(!payload||!signature||extra)throw Error("Invalid operations service authority");
 const expected=createHmac("sha256",input.secret).update(payload).digest(),actual=Buffer.from(signature,"base64url");
 if(actual.length!==expected.length||!timingSafeEqual(expected,actual))throw Error("Invalid operations service authority");
 const c=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")) as OperationsServiceClaims,now=input.now??Date.now();
 if(c.issuer!=="kasitek-operations"||c.subject!==(input.scope==="signals:read"?"operations-observer":"operations-notifier")||c.scope!==input.scope||c.audience!==input.audience||c.environment!==input.environment||c.method!==input.method||c.path!==input.path||c.digest!==hash(input.body)||!Number.isFinite(c.issuedAt)||!Number.isFinite(c.expiresAt)||c.expiresAt<=now||c.issuedAt>now+5000||c.expiresAt-c.issuedAt>30000||c.expiresAt<=c.issuedAt||typeof c.nonce!=="string"||!/^[a-f0-9-]{36}$/.test(c.nonce))throw Error("Invalid operations service authority");
 return c;
}
