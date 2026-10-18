import {createHash,createHmac,randomBytes,timingSafeEqual} from "node:crypto";
import {z} from "zod";
import {PlatformError,canonicalJson} from "./contracts";

export const pageQuery = z.object({limit:z.coerce.number().int().min(1).max(100).default(30),cursor:z.string().min(1).max(2048).optional()});
export type PageQuery = z.infer<typeof pageQuery>;
export interface ReadPage<T> {items:T[];nextCursor:string|null}
type Position = {snapshot:string;position:string;id:string};
const key=randomBytes(32);
const position=z.strictObject({snapshot:z.iso.datetime(),position:z.string().min(1).max(128),id:z.string().max(40),scope:z.string()});
const digest=(scope:unknown)=>createHash("sha256").update(canonicalJson(scope)).digest("hex");
function invalid():never {throw new PlatformError("INVALID_CURSOR",400,"Refresh this list and try again");}
export function readPageCursor(cursor:string|undefined,scope:unknown):Position {
  if(!cursor)return {snapshot:new Date().toISOString(),position:"",id:""};
  const [payload,signature,...rest]=cursor.split(".");
  if(!payload||!signature||rest.length)invalid();
  const actual=Buffer.from(signature,"base64url"),expected=createHmac("sha256",key).update(payload).digest();
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))invalid();
  let parsed:unknown;try{parsed=JSON.parse(Buffer.from(payload,"base64url").toString());}catch{invalid();}
  const value=position.safeParse(parsed);if(!value.success||value.data.scope!==digest(scope))invalid();
  return value.data;
}
export function nextPageCursor(value:Position,scope:unknown):string {
  const payload=Buffer.from(JSON.stringify({...value,scope:digest(scope)})).toString("base64url");
  return `${payload}.${createHmac("sha256",key).update(payload).digest("base64url")}`;
}
export function finishPage<T>(rows:T[],limit:number,scope:unknown,snapshot:string,getPosition:(row:T)=>{position:string;id:string}):ReadPage<T> {
  const items=rows.slice(0,limit),last=items.at(-1);
  return {items,nextCursor:rows.length>limit&&last?nextPageCursor({snapshot,...getPosition(last)},scope):null};
}
