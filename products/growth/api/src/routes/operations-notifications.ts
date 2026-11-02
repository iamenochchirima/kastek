import {createHash,randomUUID} from "node:crypto";
import type {FastifyInstance,FastifyRequest} from "fastify";
import type {Pool} from "pg";
import type {OperationsNotification} from "@kasitek-labs/contracts";
import {canonicalJson} from "@kasitek-labs/server-support/json";
import {OPERATIONS_AUTHORITY_HEADER,verifyOperationsServiceAuthority} from "@kasitek-labs/server-support/operations-authority";
export function parseOperationsNotification(body:unknown):OperationsNotification {
 if(!body||typeof body!=='object'||Array.isArray(body))throw Error('Invalid notification');const b=body as OperationsNotification;
 const identifier=(s:unknown)=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(s);
 if(!identifier(b.id)||!identifier(b.incidentId)||!['opened','escalated','assigned','resolved'].includes(b.transition)||!['warning','critical','info'].includes(b.severity)||!Array.isArray(b.recipients)||b.recipients.length<1||b.recipients.length>100||b.recipients.some(r=>!identifier(r))||new Set(b.recipients).size!==b.recipients.length||typeof b.title!=='string'||b.title.length<1||b.title.length>160||typeof b.message!=='string'||b.message.length>500||b.link!==`/operations/incidents/${b.incidentId}`)throw Error('Invalid notification');
 return {id:b.id,incidentId:b.incidentId,transition:b.transition,severity:b.severity,recipients:[...b.recipients].sort(),title:b.title,message:b.message,link:b.link};
}
export async function publishOperationsNotification(pool:Pool,body:OperationsNotification){
 const digest=createHash('sha256').update(canonicalJson(body)).digest('hex'),db=await pool.connect();
 try{await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='2s'");
 const claim=await db.query('INSERT INTO "OperationsNotificationReceipt"(id,digest) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',[body.id,digest]);
 if(!claim.rowCount){const existing=(await db.query('SELECT digest FROM "OperationsNotificationReceipt" WHERE id=$1',[body.id])).rows[0];if(existing.digest!==digest)throw Object.assign(Error('Notification identity conflict'),{statusCode:409});await db.query('COMMIT');return {id:body.id,status:'delivered',duplicate:true};}
 const eligible=(await db.query(`SELECT id FROM "AdminUser" WHERE id=ANY($1::text[]) AND lower(role) IN ('viewer','support','security','operator','admin','superadmin','owner')`,[body.recipients])).rows;
 if(eligible.length!==body.recipients.length)throw Object.assign(Error('Recipient unavailable'),{statusCode:409});
 const eventId=randomUUID();await db.query(`INSERT INTO "NotificationEvent"(id,"scopeType","scopeId","eventType",title,message,severity,"entityType","entityId",payload,"dedupeKey","createdAt") VALUES($1,'ADMIN','global',$2,$3,$4,$5,'operations_incident',$6,$7,$8,now())`,[eventId,'operations.incident.'+body.transition,body.title,body.message,body.severity.toUpperCase(),body.incidentId,JSON.stringify({link:body.link,incidentId:body.incidentId,transition:body.transition}),body.id]);
 for(const recipient of body.recipients)await db.query(`INSERT INTO "Notification"(id,"eventId","recipientType","recipientId",channel,status,"sentAt","createdAt","updatedAt") VALUES($1,$2,'ADMIN',$3,'IN_APP','SENT',now(),now(),now())`,[randomUUID(),eventId,recipient]);
 await db.query('COMMIT');return {id:body.id,status:'delivered',duplicate:false};
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
}
export function registerOperationsNotifications(app:FastifyInstance,pool:Pool,env:NodeJS.ProcessEnv){
 app.register(async scoped=>{
 const raw=new WeakMap<FastifyRequest,string>();scoped.removeContentTypeParser('application/json');scoped.addContentTypeParser('application/json',{parseAs:'string',bodyLimit:32768},(request,body,done)=>{raw.set(request,String(body));try{done(null,JSON.parse(String(body)));}catch{done(Error('Invalid JSON'));}});
 scoped.post('/internal/operations/notifications',{bodyLimit:32768},async(request,reply)=>{
 const token=request.headers[OPERATIONS_AUTHORITY_HEADER],secret=env.OPS_NOTIFICATION_SECRET;
 try{if(!secret||typeof token!=='string')throw Error();verifyOperationsServiceAuthority(token,{secret,audience:'growth',scope:'notifications:publish',method:'POST',path:request.url,body:raw.get(request),environment:env.OPS_ENVIRONMENT??'development'});}catch{return reply.code(403).send({error:'Insufficient notification authority'});}
 let notification;try{notification=parseOperationsNotification(request.body);}catch{return reply.code(400).send({error:'Invalid notification'});}
 return publishOperationsNotification(pool,notification);
 });});
}
