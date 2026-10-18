import Fastify from "fastify";
import { createHash,timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { canonicalJson,requestDigest } from "../contracts/contracts";
import { transaction } from "../infrastructure/database";
export async function initializeReportReceiver(pool:Pool){await pool.query(`CREATE SCHEMA IF NOT EXISTS report_delivery_receiver;
 CREATE TABLE IF NOT EXISTS report_delivery_receiver.deliveries(resource text NOT NULL,id uuid NOT NULL,payload_digest text NOT NULL,payload jsonb NOT NULL,accepted_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(resource,id));`);}
const payloadSchema=z.strictObject({schema:z.literal("report-delivery-v1"),resource:z.string().min(1).max(120),title:z.string().min(1).max(120),report:z.strictObject({name:z.string().min(1).max(120),contentType:z.enum(["text/plain","text/markdown","application/json"]),digest:z.string().regex(/^[a-f0-9]{64}$/),contentBase64:z.string().max(1_398_104)})});
export function createReportReceiver(options:{pool:Pool;keys:{apiKey:string;resource:string}[];afterAccept?:(id:string)=>Promise<void>}){
 const app=Fastify({logger:false,bodyLimit:1_500_000});
 const authorized=(authorization:unknown,resource:unknown)=>typeof authorization==="string"&&typeof resource==="string"&&options.keys.some(key=>key.resource===resource&&timingSafeEqual(createHash("sha256").update(authorization).digest(),createHash("sha256").update(`Bearer ${key.apiKey}`).digest()));
 const dto=(row:Record<string,any>)=>({id:row.id,payloadDigest:row.payload_digest,acceptedAt:new Date(row.accepted_at).toISOString()});
 app.post("/deliveries",async(request,reply)=>{
  const resource=request.headers["x-report-resource"];if(!authorized(request.headers.authorization,resource))return reply.code(403).send({error:"ACCESS_DENIED"});
  const id=z.uuid().safeParse(request.headers["idempotency-key"]),payload=payloadSchema.safeParse(request.body);if(!id.success||!payload.success||payload.data.resource!==resource)return reply.code(400).send({error:"INVALID_DELIVERY"});
  const bytes=Buffer.from(payload.data.report.contentBase64,"base64"),digest=requestDigest(payload.data);
  if(bytes.length>1_048_576||bytes.toString("base64")!==payload.data.report.contentBase64||createHash("sha256").update(bytes).digest("hex")!==payload.data.report.digest||digest!==request.headers["x-payload-digest"])return reply.code(400).send({error:"INVALID_DELIVERY"});
  try{const content=new TextDecoder("utf-8",{fatal:true}).decode(bytes);if(payload.data.report.contentType==="application/json")JSON.parse(content);}catch{return reply.code(400).send({error:"INVALID_DELIVERY"});}
  const row=await transaction(options.pool,async db=>{
   await db.query(`INSERT INTO report_delivery_receiver.deliveries(resource,id,payload_digest,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[resource,id.data,digest,canonicalJson(payload.data)]);
   return(await db.query("SELECT * FROM report_delivery_receiver.deliveries WHERE resource=$1 AND id=$2",[resource,id.data])).rows[0];
  });
  if(row.payload_digest!==digest)return reply.code(409).send({error:"DELIVERY_IDEMPOTENCY_CONFLICT"});
  await options.afterAccept?.(id.data);return reply.code(200).send(dto(row));
 });
 app.get<{Params:{id:string}}>("/deliveries/:id",async(request,reply)=>{
  const resource=request.headers["x-report-resource"];if(!authorized(request.headers.authorization,resource))return reply.code(403).send({error:"ACCESS_DENIED"});
  const id=z.uuid().safeParse(request.params.id);if(!id.success)return reply.code(404).send({error:"NOT_FOUND"});
  const row=(await options.pool.query("SELECT * FROM report_delivery_receiver.deliveries WHERE resource=$1 AND id=$2",[resource,id.data])).rows[0];return row?dto(row):reply.code(404).send({error:"NOT_FOUND"});
 });return app;
}
if(require.main===module){
 const database=process.env.AGENTS_REPORT_RECEIVER_DATABASE_URL,key=process.env.AGENTS_REPORT_RECEIVER_API_KEY,resource=process.env.AGENTS_REPORT_RECEIVER_RESOURCE;
 if(!database||!key||key.length<16||!resource)throw Error("Receiver configuration is required");
 const pool=new Pool({connectionString:database}),app=createReportReceiver({pool,keys:[{apiKey:key,resource}]});
 void initializeReportReceiver(pool).then(()=>app.listen({host:"127.0.0.1",port:Number(process.env.AGENTS_REPORT_RECEIVER_PORT??19100)})).catch(()=>{process.stderr.write("Report receiver startup failed\n");process.exitCode=1;}).finally(()=>{if(process.exitCode)void pool.end();});
 for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{void app.close().then(()=>pool.end());});
}
