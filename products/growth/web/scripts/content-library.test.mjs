import test from "node:test";
import assert from "node:assert/strict";
import { decodeContentResult } from "../src/lib/content-library-response.ts";

test("continuation decodes the operation envelope and returns domain results",()=>{
 const assets=Array.from({length:30},(_,i)=>({id:String(i),displayName:"Media "+"x".repeat(400)}));
 const encoded=JSON.stringify({state:"succeeded",result:{assets,pagination:{nextCursor:null,limit:30}},review:{id:"receipt"}});
 assert.ok(encoded.length>8192);
 const chunks=[];for(let i=0;i<encoded.length;i+=2000)chunks.push(encoded.slice(i,i+2000));
 assert.deepEqual(decodeContentResult(chunks.join("")),{assets,pagination:{nextCursor:null,limit:30}});
});
test("continuation refuses failed or malformed envelopes",()=>{
 assert.throws(()=>decodeContentResult('{"state":"failed","error":{"message":"Permission denied"}}'),/Permission denied/);
 assert.throws(()=>decodeContentResult('{"state":"succeeded"}'),/missing its result/);
 assert.throws(()=>decodeContentResult("broken"),SyntaxError);
});
