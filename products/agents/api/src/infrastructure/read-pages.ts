import { createHash,createHmac,timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { PlatformError,canonicalJson } from "../contracts/contracts";

export const pageQuery = z.object({limit:z.coerce.number().int().min(1).max(100).default(30),cursor:z.string().min(1).max(2048).optional()});
export type PageQuery = z.infer<typeof pageQuery>;
export interface ReadPage<T> {items:T[];nextCursor:string|null}
type Position = {snapshot:string;position:string;id:string};
const position=z.strictObject({snapshot:z.iso.datetime(),position:z.string().min(1).max(128),id:z.string().max(40),scope:z.string(),v:z.literal(1),kid:z.string().min(1).max(48),iat:z.number().int(),exp:z.number().int()});
const digest=(scope:unknown)=>createHash("sha256").update(canonicalJson(scope)).digest("hex");
function invalid():never {throw new PlatformError("INVALID_CURSOR",400,"Refresh this list and try again");}
export interface CursorKeys {active:string;keys:Record<string,string>;maxAgeSeconds?:number}
export function cursorKeysFromEnvironment(environment:NodeJS.ProcessEnv=process.env):CursorKeys {
 if(environment.AGENTS_CURSOR_KEYS_JSON){
  let keys:Record<string,string>;try{keys=JSON.parse(environment.AGENTS_CURSOR_KEYS_JSON);}catch{throw Error("Invalid cursor key configuration");}
  return {active:environment.AGENTS_CURSOR_ACTIVE_KEY_ID??"",keys,maxAgeSeconds:Number(environment.AGENTS_CURSOR_MAX_AGE_SECONDS??900)};
 }
 if(environment.NODE_ENV==="production")throw Error("Shared AGENTS_CURSOR_KEYS_JSON required in production");
 const secret=environment.AGENTS_OIDC_CLIENT_SECRET??(environment.NODE_ENV==="test"?"isolated-test-cursor-key-never-use-in-production":undefined);
 if(!secret)throw Error("Cursor signing key configuration required");
 return {active:"development",keys:{development:createHash("sha256").update("agents-read-cursors-v1\0").update(secret).digest("base64url")}};
}
export function createCursorCodec(configuration:CursorKeys,clock:()=>number=Date.now){
 const maxAge=configuration.maxAgeSeconds??900;
 if(!Number.isInteger(maxAge)||maxAge<60||maxAge>86400||!configuration.keys||typeof configuration.keys!=="object"||Array.isArray(configuration.keys)||Object.keys(configuration.keys).length>8)throw Error("Invalid cursor key configuration");
 const keys=new Map<string,Buffer>();
 for(const[id,secret]of Object.entries(configuration.keys)){
  if(!/^[a-zA-Z0-9_-]{1,48}$/.test(id)||typeof secret!=="string"||!/^[a-zA-Z0-9_-]+$/.test(secret))throw Error("Invalid cursor key configuration");
  const bytes=Buffer.from(secret,"base64url");if(bytes.length<32||bytes.length>128)throw Error("Invalid cursor key configuration");keys.set(id,bytes);
 }
 const active=keys.get(configuration.active);if(!active)throw Error("Missing active cursor key");
 return {
 read(cursor:string|undefined,scope:unknown):Position {
  if(!cursor)return {snapshot:new Date(clock()).toISOString(),position:"",id:""};
  if(cursor.length>2048)invalid();
  const[payload,signature,...rest]=cursor.split(".");if(!payload||!signature||rest.length)invalid();
  let parsed:unknown;try{parsed=JSON.parse(Buffer.from(payload,"base64url").toString());}catch{invalid();}
  const result=position.safeParse(parsed);if(!result.success)invalid();const value=result.data,key=keys.get(value.kid);if(!key)invalid();
  const actual=Buffer.from(signature,"base64url"),expected=createHmac("sha256",key).update(payload).digest();
  const now=Math.floor(clock()/1000);
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||value.scope!==digest(scope)||value.iat>now+30||value.exp<=now||value.exp-value.iat>86400||value.exp<=value.iat)invalid();
  return {snapshot:value.snapshot,position:value.position,id:value.id};
 },
 next(value:Position,scope:unknown):string {
  const iat=Math.floor(clock()/1000),payload=Buffer.from(JSON.stringify({...value,scope:digest(scope),v:1,kid:configuration.active,iat,exp:iat+maxAge})).toString("base64url");
  return `${payload}.${createHmac("sha256",active).update(payload).digest("base64url")}`;
 }};
}
export function readPageCursor(cursor:string|undefined,scope:unknown):Position {return createCursorCodec(cursorKeysFromEnvironment()).read(cursor,scope);}
export function nextPageCursor(value:Position,scope:unknown):string {return createCursorCodec(cursorKeysFromEnvironment()).next(value,scope);}
export function finishPage<T>(rows:T[],limit:number,scope:unknown,snapshot:string,getPosition:(row:T)=>{position:string;id:string}):ReadPage<T> {
  const items=rows.slice(0,limit),last=items.at(-1);
  return {items,nextCursor:rows.length>limit&&last?nextPageCursor({snapshot,...getPosition(last)},scope):null};
}
