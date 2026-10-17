import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import type {PrivateObjectStore} from "../src/platform/artifacts";
import {KnowledgeStore} from "../src/platform/knowledge";
import {textDigest} from "../src/platform/source-contracts";

/** Persistence fixture: extraction is supplied explicitly; parser containment has a separate real-runtime suite. */
export async function publishFixtureSource(pool:Pool,input:{accountId:string;organizationId:string;title:string;content:string;visibility:"public"|"private"},objects?:PrivateObjectStore){
 const bodies=new Map<string,Uint8Array>();
 const storage=objects??{async put(key:string,value:Uint8Array){bodies.set(key,Buffer.from(value));},async get(key:string){const body=bodies.get(key);if(!body)throw Error("Missing private fixture object");return body;},async delete(key:string){bodies.delete(key);}};
 const knowledge=new KnowledgeStore(pool,storage),scope={accountId:input.accountId,organizationId:input.organizationId};
 const text=input.content.normalize("NFC").replace(/\r\n?/g,"\n");
 const job=await knowledge.admitUpload(scope,{operationId:randomUUID(),title:input.title,contentType:"text/plain",content:Buffer.from(text),parserRelease:"fixture-parser-v1"});
 await pool.query("UPDATE agents_platform.ingestion_jobs SET state='extracting' WHERE id=$1",[job.id]);
 const chunks=[];let ordinal=0;
 for(let start=0;start<text.length;){let end=Math.min(text.length,start+1200);if(end<text.length&&/[\uDC00-\uDFFF]/.test(text[end]!))end--;const content=text.slice(start,end);chunks.push({id:randomUUID(),revisionId:job.revisionId,ordinal:ordinal++,start,end,page:1,section:null,text:content,digest:textDigest(content),tokens:Math.min(384,Math.ceil(content.length/4))});start=end;}
 await knowledge.publishExtraction(job.id,{text,chunks,normalizerRelease:"fixture-nfc-v1",acquiredAt:new Date().toISOString()});
 await knowledge.setPolicy(scope,job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"approve",revisionId:job.revisionId});
 if(input.visibility==="public")await knowledge.setPolicy(scope,job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"visibility",visibility:"public"});
 return {id:job.revisionId,sourceId:job.sourceId,title:input.title,content:text,knowledge,storage};
}
