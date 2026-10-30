import { randomUUID } from "node:crypto";

// Controlled API data only; none of these routes contact a provider.
export function communicationsFixture({ json, payload, now }) {
  const connections = [
    { id: "whatsapp-main", phoneNumberId: "main-number", phoneDisplayNumber: "+27 72 000 1111" },
    { id: "whatsapp-sales", phoneNumberId: "sales-number", phoneDisplayNumber: "+27 72 000 2222" },
  ];
  const initialTemplates = [
    { id:"spring", templateName:"spring_offer", category:"MARKETING", language:"en_GB", status:"APPROVED", header:"Spring offer", body:"Hello {{1}}, our spring offer is here. Reply for details.", footer:"Luma Studio", variablesCount:1, buttons:[{type:"QUICK_REPLY",text:"Tell me more"}], connectionId:"whatsapp-main",connectionLabel:"Luma support" },
    { id:"reminder",templateName:"appointment_reminder",category:"UTILITY",language:"en_US",status:"PENDING",body:"Your appointment is tomorrow.",connectionId:"whatsapp-sales",connectionLabel:"Luma sales" },
    { id:"order",templateName:"order_update",category:"UTILITY",language:"en_GB",status:"REJECTED",body:"Your order has been updated.",connectionId:"whatsapp-main",connectionLabel:"Luma support" },
    { id:"welcome",templateName:"welcome_message",category:"AUTHENTICATION",language:"af",status:"DISABLED",body:"Welcome to Luma Studio.",connectionId:"whatsapp-sales",connectionLabel:"Luma sales" },
  ].map(t=>({header:null,footer:null,buttons:[],variablesCount:0,lastSynced:now(),...t}));
  const initialVoice = [{id:"voice-main",provider:"TWILIO",displayName:"Business phone",externalAccountId:"+27215550183"}];
  const initialCalls = [
    {id:"completed",direction:"INBOUND",status:"COMPLETED",conversationCustomerName:"Thandi Mokoena",durationSeconds:204,conversationId:"fixture-inbox",answeredAt:now(),endedAt:now()},
    {id:"outbound",direction:"OUTBOUND",status:"COMPLETED",conversationCustomerName:"Sipho Dlamini",durationSeconds:78},
    {id:"missed",direction:"INBOUND",status:"MISSED",conversationCustomerName:"Aisha Patel",durationSeconds:null},
    {id:"failed",direction:"OUTBOUND",status:"FAILED",conversationCustomerName:null,durationSeconds:null,errorCode:"fixture_rejected",errorMessage:"The destination rejected this controlled call."},
    {id:"live",direction:"OUTBOUND",status:"ACTIVE",conversationCustomerName:"Michael Brown",durationSeconds:null},
  ].map(c=>({provider:"TWILIO",connectionId:"voice-main",conversationId:null,fromPhone:"+27215550183",toPhone:"+27710001111",agentLabel:null,connectionLabel:"Business phone",startedAt:now(),answeredAt:null,endedAt:null,errorCode:null,errorMessage:null,createdAt:now(),updatedAt:now(),...c}));
  let templates, calls, voice, mutations;
  const reset=()=>{templates=structuredClone(initialTemplates);calls=structuredClone(initialCalls);voice=structuredClone(initialVoice);mutations=[];}; reset();
  return async (request,response,url)=>{
    const path=url.pathname;
    if(path==="/__fixture/communications") {if(request.method==="POST") reset(); json(response,200,{templates,calls,voice,mutations});return true;}
    if(path==="/api/whatsapp/connections") {json(response,200,{connections});return true;}
    if(path==="/api/whatsapp/templates") {
      if(request.method==="POST") {const input=await payload(request);mutations.push({path,input});const created={...input,id:randomUUID(),status:"PENDING",buttons:[],variablesCount:(input.body?.match(/\{\{\d+\}\}/g)||[]).length,lastSynced:now(),connectionLabel:connections.find(c=>c.id===input.connectionId)?.phoneDisplayNumber};templates.push(created);json(response,201,created);}
      else json(response,200,{templates:templates.filter(t=>!url.searchParams.get("status")||t.status===url.searchParams.get("status"))});return true;
    }
    if(/^\/api\/whatsapp\/connections\/[^/]+\/templates\/sync$/.test(path)) {const connectionId=path.split("/")[4];mutations.push({path,connectionId});json(response,200,{synced:templates.filter(t=>t.connectionId===connectionId).length});return true;}
    if(path==="/api/calls") {json(response,200,{calls});return true;}
    if(path==="/api/calls/summary") {json(response,200,{days:30,summary:{totalCalls:calls.length,inboundCalls:2,outboundCalls:3,ringingCalls:0,activeCalls:1,completedCalls:2,missedCalls:1,failedCalls:1,rejectedCalls:0,recentCalls:5},trend:[]});return true;}
    if(path==="/api/calls/providers") {json(response,200,{providers:[{provider:"TWILIO",configured:false,browserConfigured:true,requiredEnvironment:[]}]});return true;}
    if(path==="/api/connections") {json(response,200,{connections:voice});return true;}
    if(path==="/api/calls/providers/twilio/connections") {const input=await payload(request);const connection={id:randomUUID(),provider:"TWILIO",displayName:input.displayName,externalAccountId:input.phoneNumber};voice.push(connection);mutations.push({path,input});json(response,201,{connection});return true;}
    if(path==="/api/calls/twilio/browser-token") {mutations.push({path});json(response,200,{token:"controlled-browser-sdk-token"});return true;}
    return false;
  };
}
