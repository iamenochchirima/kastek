import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import type {ToolReviewStore} from "../../capabilities/reviews/tool-reviews";
import {customerContactIntakeSchema} from "../../capabilities/connected-tools/customer-native-policy";
import {PlatformError,requestDigest} from "../../contracts/contracts";
import type {ChannelSendRequest,ChannelWebhookEvent} from "../../contracts/channel-adapters";
import {assertCurrentAuthority,loadExecution} from "../../execution/lifecycle/execution";

export function channelToolReviewText(input:unknown):string {
 const fields=customerContactIntakeSchema.parse(input);
 return ["Save these contact details?",`Email: ${fields.email}`,...(fields.firstName?[`First name: ${fields.firstName}`]:[]),...(fields.lastName?[`Last name: ${fields.lastName}`]:[])].join("\n");
}
export function channelToolReviewButtons(id:string){z.uuid().parse(id);return[{title:"Confirm",payload:`intake:a:${id}`},{title:"Decline",payload:`intake:r:${id}`}];}
export function channelToolReviewDecision(event:ChannelWebhookEvent):{id:string;decision:"approve"|"reject"}|null {
 if(!["message","interaction"].includes(event.kind))return null;
 let payload=event.interaction;
 if(!payload||event.echo)return null;
 if(payload.startsWith("{")){try{const parsed=JSON.parse(payload);if(!["quick_reply","postback"].includes(parsed.type)||typeof parsed.payload!=="string")return null;payload=parsed.payload;}catch{return null;}}
 if(typeof payload!=="string")return null;
 const match=/^intake:([ar]):([a-f0-9-]{36})$/.exec(payload);if(!match||!z.uuid().safeParse(match[2]).success)return null;
 return{id:match[2]!,decision:match[1]==="a"?"approve":"reject"};
}
const unavailable=()=>new PlatformError("CHANNEL_REVIEW_UNAVAILABLE",403,"Contact confirmation is unavailable");
export async function assertChannelToolReviewPrompt(db:Pool|PoolClient,request:ChannelSendRequest,conversationId:string):Promise<void> {
 if(!request.toolReview)return;
 const review=z.strictObject({id:z.uuid(),taskId:z.uuid(),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.toolReview);
 const row=(await db.query(`SELECT r.*,t.channel_binding FROM agents_platform.tool_invocation_reviews r JOIN agents_platform.tasks t ON t.id=r.task_id
  JOIN agents_platform.customer_task_links l ON l.task_id=t.id WHERE r.id=$1 AND r.task_id=$2 AND l.conversation_id=$3
  AND r.state='pending' AND r.expires_at>now() FOR SHARE OF r,t,l`,[review.id,review.taskId,conversationId])).rows[0];
 if(!row||row.request_digest!==review.requestDigest||row.request_digest!==requestDigest({bindingDigest:row.binding_digest,arguments:row.arguments})||request.text!==channelToolReviewText(row.arguments)||requestDigest(request.buttons)!==requestDigest(channelToolReviewButtons(review.id)))throw unavailable();
 await assertCurrentAuthority(db,await loadExecution(db,review.taskId));
}
export class ChannelToolReviews {
 constructor(readonly pool:Pool,readonly reviews:ToolReviewStore){}
 async handle(connectionId:string,deploymentId:string,event:ChannelWebhookEvent):Promise<"confirmed"|"rejected"|null>{
  const action=channelToolReviewDecision(event);if(!action)return null;
  const row=(await this.pool.query(`SELECT r.task_id,r.request_digest,t.principal FROM agents_platform.tool_invocation_reviews r
   JOIN agents_platform.tasks t ON t.id=r.task_id JOIN agents_platform.customer_task_links l ON l.task_id=t.id
   JOIN agents_platform.customer_conversations c ON c.id=l.conversation_id
   JOIN agents_platform.channel_deployments d ON d.id=c.channel_deployment_id
   JOIN agents_platform.channel_connections cc ON cc.id=d.connection_id
   WHERE r.id=$1 AND cc.id=$2 AND d.id=$3 AND cc.asset_id=$4 AND c.external_conversation_id=$5 AND c.external_sender_id=$6
   AND c.state='automation_active' AND c.ownership_generation=l.ownership_generation AND d.state='active' AND cc.state='active'
   AND t.principal->>'kind'='channel_customer' AND t.principal->>'deploymentId'=d.id::text AND t.principal->>'participantId'=c.id::text
   AND EXISTS(SELECT 1 FROM agents_platform.channel_outbound o WHERE o.conversation_id=c.id AND o.connection_id=cc.id
     AND o.request#>>'{toolReview,id}'=r.id::text AND o.request#>>'{toolReview,requestDigest}'=r.request_digest
     AND o.state IN ('accepted','sent','delivered','read') AND o.provider_message_id IS NOT NULL
     AND (cc.kind<>'telegram' OR o.provider_message_id=$7))`,[action.id,connectionId,deploymentId,event.assetId,event.externalConversationId,event.senderId,event.providerMessageId])).rows[0];
  if(!row)return "rejected";
  try{await this.reviews.decideForPrincipal(row.task_id,row.principal,action.id,{decision:action.decision,requestDigest:row.request_digest});return"confirmed";}
  catch(error){if(error instanceof PlatformError&&error.statusCode<500)return"rejected";throw error;}
 }
}
