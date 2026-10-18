import {describe,it,expect} from "vitest";
import {createCursorCodec,cursorKeysFromEnvironment} from "../src/infrastructure/read-pages";
const first=Buffer.alloc(32,1).toString("base64url"),second=Buffer.alloc(32,2).toString("base64url");
describe("shared replica cursors",()=>{
 it("survives replica restart, rotates keys and rejects retired keys, scope widening and expiry",()=>{
  let now=Date.now();const position={snapshot:new Date(now).toISOString(),position:"12",id:"id"},scope={tenant:"a",principal:"alice",q:"faq"};
  const replicaA=createCursorCodec({active:"one",keys:{one:first},maxAgeSeconds:60},()=>now);
  const cursor=replicaA.next(position,scope);
  const replicaB=createCursorCodec({active:"two",keys:{one:first,two:second}},()=>now);
  expect(replicaB.read(cursor,scope)).toEqual(position);
  expect(()=>replicaB.read(cursor,{...scope,principal:"bob"})).toThrowError();
  expect(()=>createCursorCodec({active:"two",keys:{two:second}},()=>now).read(cursor,scope)).toThrowError();
  expect(()=>replicaB.read(cursor.slice(0,-2)+"xx",scope)).toThrowError();
  now+=61_000;expect(()=>replicaB.read(cursor,scope)).toThrowError();
 });
 it("has explicit production keys and stable domain-separated development keys",()=>{
  expect(()=>cursorKeysFromEnvironment({NODE_ENV:"production"})).toThrowError();
  const env={NODE_ENV:"development",AGENTS_OIDC_CLIENT_SECRET:"development-only-secret"};
  expect(cursorKeysFromEnvironment(env)).toEqual(cursorKeysFromEnvironment(env));
  expect(()=>createCursorCodec({active:"x",keys:{x:"short"}})).toThrowError();
 });
});
