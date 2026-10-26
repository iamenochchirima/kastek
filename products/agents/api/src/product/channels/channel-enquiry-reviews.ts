import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import {EnquiryStore,type EnquiryFields} from "../../capabilities/enquiries/enquiries";
import {PlatformError,requestDigest} from "../../contracts/contracts";
import type {ChannelSendRequest,ChannelWebhookEvent} from "../../contracts/channel-adapters";
import {assertCurrentAuthority,loadExecution} from "../../execution/lifecycle/execution";
export function enquiryReviewText(fields:EnquiryFields,amendment=false){return [amendment?"Save these updated enquiry details?":"Submit these enquiry details?",...Object.entries(fields).map(([name,value])=>`${name.charAt(0).toUpperCase()+name.slice(1)}: ${value}`)].join("\n");}
export function enquiryReviewButtons(id:string){z.uuid().parse(id);return [{title:"Confirm",payload:`enquiry:a:${id}`},{title:"Decline",payload:`enquiry:r:${id}`}];}
export function enquiryReviewDecision(event:ChannelWebhookEvent):{id:string;decision:"approve"|"reject"}|null{
 if(!["message","interaction"].includes(event.kind)||!event.interaction||event.echo)return null;
 let payload=event.interaction;
 if(payload.startsWith("{")){try{const parsed=JSON.parse(payload);if(!["quick_reply","postback"].includes(parsed.type)||typeof parsed.payload!=="string")return null;payload=parsed.payload;}catch{return null;}}
 const match=/^enquiry:([ar]):([a-f0-9-]{36})$/.exec(payload);if(!match||!z.uuid().safeParse(match[2]).success)return null;
 return{id:match[2]!,decision:match[1]==="a"?"approve":"reject"};
}
export async function assertEnquiryReviewPrompt(db:Pool|PoolClient,request:ChannelSendRequest,conversationId:string){
 if(!request.enquiryReview)return;
 const review=z.strictObject({id:z.uuid(),taskId:z.uuid(),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.enquiryReview);
 const row=(await db.query(`SELECT e.* FROM agents_platform.enquiries e JOIN agents_platform.customer_task_links l ON l.task_id=e.task_id WHERE e.id=$1 AND e.task_id=$2 AND l.conversation_id=$3 AND e.state='pending' AND e.expires_at>now() FOR SHARE OF e,l`,[review.id,review.taskId,conversationId])).rows[0];
 if(!row||row.request_digest!==review.requestDigest||request.text!==enquiryReviewText(row.fields,Boolean(row.amends_enquiry_id))||requestDigest(request.buttons)!==requestDigest(enquiryReviewButtons(review.id)))throw new PlatformError("CHANNEL_REVIEW_UNAVAILABLE",403,"Enquiry confirmation is unavailable");
 await assertCurrentAuthority(db,await loadExecution(db,review.taskId));
}
export class ChannelEnquiryReviews {
 constructor(readonly pool:Pool,readonly enquiries=new EnquiryStore(pool)){}
 async handle(connectionId:string,deploymentId:string,event:ChannelWebhookEvent):Promise<"confirmed"|"rejected"|null>{
  const action=enquiryReviewDecision(event);if(!action)return null;
  const row=(await this.pool.query(`SELECT e.task_id,e.request_digest,t.principal FROM agents_platform.enquiries e
   JOIN agents_platform.tasks t ON t.id=e.task_id JOIN agents_platform.customer_task_links l ON l.task_id=t.id
   JOIN agents_platform.customer_conversations c ON c.id=l.conversation_id JOIN agents_platform.channel_deployments d ON d.id=c.channel_deployment_id
   JOIN agents_platform.channel_connections cc ON cc.id=d.connection_id
   WHERE e.id=$1 AND cc.id=$2 AND d.id=$3 AND cc.asset_id=$4 AND c.external_conversation_id=$5 AND c.external_sender_id=$6
   AND c.state='automation_active' AND c.ownership_generation=l.ownership_generation AND d.state='active' AND cc.state='active'
   AND t.principal->>'kind'='channel_customer' AND t.principal->>'deploymentId'=d.id::text AND t.principal->>'participantId'=c.id::text
   AND EXISTS(SELECT 1 FROM agents_platform.channel_outbound o WHERE o.conversation_id=c.id AND o.connection_id=cc.id
    AND o.request#>>'{enquiryReview,id}'=e.id::text AND o.request#>>'{enquiryReview,requestDigest}'=e.request_digest
    AND o.state IN ('accepted','sent','delivered','read') AND o.provider_message_id IS NOT NULL AND (cc.kind<>'telegram' OR o.provider_message_id=$7))`,[action.id,connectionId,deploymentId,event.assetId,event.externalConversationId,event.senderId,event.providerMessageId])).rows[0];
  if(!row)return "rejected";
  try{await this.enquiries.decide(row.task_id,row.principal,action.id,{decision:action.decision,requestDigest:row.request_digest});return "confirmed";}catch(error){if(error instanceof PlatformError&&error.statusCode<500)return "rejected";throw error;}
 }
}
