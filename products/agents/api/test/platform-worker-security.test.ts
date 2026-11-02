import { generateKeyPairSync } from "node:crypto";
import { connect, createServer, type ClientHttp2Session } from "node:http2";
import { once } from "node:events";
import { createEndpointHandler, service } from "@restatedev/restate-sdk";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { workerSecurityFromEnvironment } from "../src/composition/worker-security";

function publicIdentityKey(bytes: Buffer): string {
  const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value=BigInt(`0x${bytes.toString("hex")}`), result="";
  while(value>0n) { result=alphabet[Number(value%58n)]+result;value/=58n; }
  for(const byte of bytes) { if(byte!==0) break;result="1"+result; }
  return `publickeyv1_${result}`;
}
function request(client: ClientHttp2Session, path: string, headers: Record<string,string>={}) {
  return new Promise<{status:number;body:string}>((resolve,reject)=>{
    const stream=client.request({":method":"GET",":path":path,accept:"application/vnd.restate.endpointmanifest.v3+json",...headers});
    let status=0,body="";stream.setEncoding("utf8");
    stream.on("response",value=>{status=Number(value[":status"]);});stream.on("data",value=>{body+=value;});
    stream.on("end",()=>resolve({status,body}));stream.on("error",reject);stream.end();
  });
}
describe("pinned Restate SDK request identity over HTTP2",()=>{
  it("accepts matching signatures and rejects unsigned, forged, expired and wrong-path requests before dispatch",async()=>{
    const trusted=generateKeyPairSync("ed25519"), attacker=generateKeyPairSync("ed25519");
    const encoded=publicIdentityKey(trusted.publicKey.export({format:"der",type:"spki"}).subarray(-32));
    let handlerCalls=0;
    const probe=service({name:"IdentityProbe",handlers:{run:async()=>{handlerCalls++;return {ok:true};}}});
    const server=createServer(createEndpointHandler({services:[probe],identityKeys:[encoded],logger:()=>{}}));
    server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();
    if(!address||typeof address==="string") throw new Error("Missing worker address");
    const client=connect(`http://127.0.0.1:${address.port}`);
    const token=async(path:string,key=trusted.privateKey,expiry=Math.floor(Date.now()/1000)+60)=>new SignJWT({aud:path})
      .setProtectedHeader({alg:"EdDSA"}).setIssuedAt().setNotBefore(Math.floor(Date.now()/1000)-7200).setExpirationTime(expiry).sign(key);
    const signed=(jwt:string)=>({"x-restate-signature-scheme":"v1","x-restate-jwt-v1":jwt});
    try {
      expect((await request(client,"/discover")).status).toBe(401);
      expect((await request(client,"/discover",signed("malformed"))).status).toBe(401);
      expect((await request(client,"/discover",signed(await token("/discover",attacker.privateKey)))).status).toBe(401);
      expect((await request(client,"/invoke/IdentityProbe/run",{"content-type":"application/vnd.restate.invocation.v5",...signed(await token("/invoke/IdentityProbe/run",attacker.privateKey))})).status).toBe(401);
      expect((await request(client,"/invoke/IdentityProbe/run",{"content-type":"application/vnd.restate.invocation.v5"})).status).toBe(401);
      expect((await request(client,"/discover",signed(await token("/discover",trusted.privateKey,Math.floor(Date.now()/1000)-3600)))).status).toBe(401);
      expect((await request(client,"/invoke/IdentityProbe/run",signed(await token("/discover")))).status).toBe(401);
      const allowed=await request(client,"/discover",signed(await token("/discover")));
      expect(allowed.status).toBe(200);expect(JSON.parse(allowed.body).services[0].name).toBe("IdentityProbe");
      expect(handlerCalls).toBe(0);
    } finally {client.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
});

describe("worker binding and identity configuration",()=>{
  const key="publickeyv1_2G8dCQhArfvGpzPw5Vx2ALciR4xCLHfS5YaT93XjNxX9";
  it("defaults unsigned development to loopback and requires explicit nonloopback opt-in",()=>{
    expect(workerSecurityFromEnvironment({})).toEqual({host:"127.0.0.1",identityKeys:undefined});
    expect(()=>workerSecurityFromEnvironment({RESTATE_WORKER_HOST:"0.0.0.0"})).toThrow("explicit");
    expect(()=>workerSecurityFromEnvironment({RESTATE_WORKER_HOST:"::"})).toThrow("explicit");
    expect(workerSecurityFromEnvironment({RESTATE_WORKER_HOST:"0.0.0.0",AGENTS_ALLOW_UNSIGNED_WORKER:"1"}).host).toBe("0.0.0.0");
    expect(workerSecurityFromEnvironment({RESTATE_WORKER_HOST:"0.0.0.0",RESTATE_REQUEST_IDENTITY_KEYS:key}).identityKeys).toEqual([key]);
  });
  it("never permits unsigned production and rejects invalid keys or environment",()=>{
    for(const RESTATE_WORKER_HOST of ["127.0.0.1","0.0.0.0"]) expect(()=>workerSecurityFromEnvironment({NODE_ENV:"production",RESTATE_WORKER_HOST,AGENTS_ALLOW_UNSIGNED_WORKER:"1"})).toThrow("require");
    expect(workerSecurityFromEnvironment({NODE_ENV:"production",RESTATE_WORKER_HOST:"0.0.0.0",RESTATE_REQUEST_IDENTITY_KEYS:key}).host).toBe("0.0.0.0");
    expect(()=>workerSecurityFromEnvironment({RESTATE_REQUEST_IDENTITY_KEYS:"invalid"})).toThrow("Invalid");
    expect(()=>workerSecurityFromEnvironment({NODE_ENV:"staging"})).toThrow("Invalid");
  });
});
