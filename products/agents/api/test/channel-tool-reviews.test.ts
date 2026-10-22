import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import {channelToolReviewButtons,channelToolReviewDecision,channelToolReviewText} from "../src/product/channels/channel-tool-reviews";
import {sendTelegram} from "../src/adapters/channels/telegram/adapter";
import {sendWhatsapp} from "../src/adapters/channels/whatsapp/adapter";
import {sendMetaMessage} from "../src/adapters/channels/meta/send";
import type {ChannelWebhookEvent} from "../src/contracts/channel-adapters";
import {EvaluationChannelFixtures} from "../src/product/evaluation/channel-fixtures";

describe("native contact confirmation messages",()=>{
 const id=randomUUID(),buttons=channelToolReviewButtons(id),text=channelToolReviewText({email:"customer@example.test",firstName:"Customer"});
 it("shows exact contact fields and uses compact opaque callback references",()=>{
  expect(text).toBe("Save these contact details?\nEmail: customer@example.test\nFirst name: Customer");
  expect(buttons.map(button=>Buffer.byteLength(button.payload))).toEqual([45,45]);expect(JSON.stringify(buttons)).not.toContain("customer@example.test");
  expect(()=>channelToolReviewText({email:"customer@example.test",foreignRecordId:"not-approved"})).toThrow();
 });
 it("accepts native callbacks only, never approval words or arbitrary events",()=>{
  const event={kind:"interaction",interaction:buttons[0]!.payload,echo:false} as ChannelWebhookEvent;
  expect(channelToolReviewDecision(event)).toEqual({id,decision:"approve"});
  expect(channelToolReviewDecision({...event,interaction:JSON.stringify({type:"quick_reply",payload:buttons[1]!.payload})})).toEqual({id,decision:"reject"});
  for(const interaction of ["yes","confirm",JSON.stringify({type:"reaction",payload:buttons[0]!.payload}),"intake:a:invalid"])
   expect(channelToolReviewDecision({...event,interaction})).toBeNull();
  expect(channelToolReviewDecision({...event,echo:true})).toBeNull();
  expect(channelToolReviewDecision({...event,kind:"receipt"})).toBeNull();
 });
 it("sends Telegram inline keyboard with exact payloads",async()=>{
  let body:any;await sendTelegram({assetId:"123",recipientId:"456",text,buttons},{credential:"123:fixture",fetch:async(_url,init)=>{body=JSON.parse(String(init?.body));return Response.json({ok:true,result:{message_id:55}});}});
  expect(body).toMatchObject({chat_id:"456",text,reply_markup:{inline_keyboard:[buttons.map(button=>({text:button.title,callback_data:button.payload}))]}});
 });
 it("sends WhatsApp interactive reply buttons",async()=>{
  let body:any;await sendWhatsapp({assetId:"123",recipientId:"456",text,buttons},{credential:"fixture",mode:"meta",apiVersion:"v23.0",fetch:async(_url,init)=>{body=JSON.parse(String(init?.body));return Response.json({messages:[{id:"wamid.55"}]});}});
  expect(body).toMatchObject({type:"interactive",interactive:{type:"button",body:{text},action:{buttons:buttons.map(button=>({type:"reply",reply:{id:button.payload,title:button.title}}))}}});
 });
 it.each(["facebook","instagram"] as const)("sends %s quick replies and preserves the callback payload",async kind=>{
  let body:any;await sendMetaMessage(kind,{assetId:"123",recipientId:"456",text,buttons},{credential:"fixture",mode:"meta",pageId:"123",apiVersion:"v23.0",fetch:async(_url,init)=>{body=JSON.parse(String(init?.body));return Response.json({recipient_id:"456",message_id:"mid.55"});}});
  expect(body.message).toEqual({text,quick_replies:buttons.map(button=>({content_type:"text",title:button.title,payload:button.payload}))});
 });
 it("fails unsupported combinations before sending any button message",async()=>{
  let sent=0;const fetcher=async()=>{sent++;return Response.json({});};
  await expect(sendTelegram({assetId:"123",recipientId:"456",text,buttons:[{title:"Confirm",payload:"x".repeat(65)}]},{credential:"123:fixture",fetch:fetcher})).rejects.toThrow();
  await expect(sendWhatsapp({assetId:"123",recipientId:"456",text,buttons,template:{name:"not-combinable",language:"en"}},{credential:"fixture",apiVersion:"v23.0",fetch:fetcher})).rejects.toThrow();
  await expect(sendMetaMessage("instagram",{assetId:"123",recipientId:"456",text,buttons,attachments:[{kind:"image",url:"https://example.test/picture"}]},{credential:"fixture",mode:"meta",pageId:"123",apiVersion:"v23.0",fetch:fetcher})).rejects.toThrow();expect(sent).toBe(0);
 });
 it("acknowledges only active owned trial contact callbacks without external transport",async()=>{
  const row={trial_id:randomUUID(),organization_id:randomUUID(),deployment_id:randomUUID(),asset_id:"123",trial_state:"active",expires_at:new Date(Date.now()+60000),connection_state:"active",deployment_state:"active",deployment_version:"v1",version_id:"v1"};
  let participant=true;const query=vi.fn(async(sql:string)=>sql.includes("evaluation_trial_messaging_channels")?{rows:[row],rowCount:1}:{rows:participant?[{}]:[],rowCount:participant?1:0});
  const fixtures=new EvaluationChannelFixtures({query} as any,{} as any,{} as any,{} as any),fetcher=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("No live transport"));
  const event={kind:"interaction",assetId:"123",externalConversationId:"456",senderId:"456",interaction:buttons[0]!.payload,echo:false} as ChannelWebhookEvent;
  try{
   await fixtures.acknowledgeContactReview(randomUUID(),event);expect(query.mock.calls[1]![0]).toContain("t.evaluation_trial_id=$5");expect(fetcher).not.toHaveBeenCalled();
   participant=false;await expect(fixtures.acknowledgeContactReview(randomUUID(),event)).rejects.toMatchObject({code:"EVALUATION_CHANNEL_SCOPE_DENIED"});
   participant=true;row.trial_state="closed";await expect(fixtures.acknowledgeContactReview(randomUUID(),event)).rejects.toMatchObject({code:"EVALUATION_CHANNEL_SCOPE_DENIED"});expect(fetcher).not.toHaveBeenCalled();
  }finally{fetcher.mockRestore();}
 });
});
