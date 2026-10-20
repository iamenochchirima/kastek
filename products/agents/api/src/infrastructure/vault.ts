import { createCipheriv,createDecipheriv,randomBytes } from "node:crypto";
import { canonicalJson,PlatformError } from "../contracts/contracts";
export interface SecretEnvelope {keyId:string;iv:string;tag:string;ciphertext:string}
const unavailable=()=>new PlatformError("CONNECTION_VAULT_UNAVAILABLE",503,"Connection credentials are unavailable");
export class ConnectionVault {
 private readonly keys=new Map<string,Buffer>();
 constructor(readonly activeKeyId:string,keys:Record<string,string>){
  for(const [id,encoded] of Object.entries(keys)){
   const key=Buffer.from(encoded,"base64");if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id)||key.length!==32||key.toString("base64")!==encoded)throw unavailable();this.keys.set(id,key);
  }
  if(!this.keys.has(activeKeyId))throw unavailable();
 }
 private aad(org:string,id:string,revision:number){return Buffer.from(canonicalJson({organizationId:org,connectionId:id,credentialRevision:revision}));}
 seal(org:string,id:string,revision:number,secret:string,maxBytes=4096):SecretEnvelope{
  if(![4096,65536].includes(maxBytes)||Buffer.byteLength(secret)<16||Buffer.byteLength(secret)>maxBytes)throw new PlatformError("CONNECTION_KEY_INVALID",400,"Connection credentials exceed the supported limits");
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",this.keys.get(this.activeKeyId)!,iv);cipher.setAAD(this.aad(org,id,revision));
  const ciphertext=Buffer.concat([cipher.update(secret,"utf8"),cipher.final()]);return{keyId:this.activeKeyId,iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),ciphertext:ciphertext.toString("base64")};
 }
 open(org:string,id:string,revision:number,envelope:SecretEnvelope):string{
  try{const key=this.keys.get(envelope.keyId);if(!key)throw unavailable();const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(envelope.iv,"base64"));decipher.setAAD(this.aad(org,id,revision));decipher.setAuthTag(Buffer.from(envelope.tag,"base64"));return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,"base64")),decipher.final()]).toString("utf8");}catch{throw unavailable();}
 }
}
export function connectionVaultFromEnvironment(env:NodeJS.ProcessEnv=process.env):ConnectionVault|undefined{
 if(!env.AGENTS_CONNECTION_KEYS&&!env.AGENTS_CONNECTION_ACTIVE_KEY)return;
 try{return new ConnectionVault(env.AGENTS_CONNECTION_ACTIVE_KEY!,JSON.parse(env.AGENTS_CONNECTION_KEYS!));}catch{throw unavailable();}
}
