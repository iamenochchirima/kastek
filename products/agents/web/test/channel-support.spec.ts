import { test, expect, type Page } from "@playwright/test";
test.setTimeout(20000);
test.use({launchOptions:{channel:"chromium-headless-shell"}});
const base="/api/organizations/org/inbox/conversation";
async function fixture(page:Page,assigned=true,lost=false,mediaLost=false){
  const calls:{path:string;body:any}[]=[],errors:string[]=[];let granted=false,consentRevision=0,replyLost=lost;
  const conversation={id:"conversation",agentId:"agent",agentName:"Support",deploymentId:null,versionId:"version",channel:"whatsapp",state:"human_owned",assigneeAccountId:assigned?"owner":"other",revision:"7",ownershipGeneration:"1",createdAt:"2026-10-21T10:00:00Z",updatedAt:"2026-10-21T10:00:00Z"};
  const messages=[{id:"visitor",sequence:"1",authorKind:"visitor",body:"Yes, send my appointment updates",createdAt:conversation.createdAt,channelFacts:{attachments:[{kind:"document",fileName:"appointment.pdf",index:0}]}},{id:"reply",sequence:"2",authorKind:"human",body:"Previous reply",createdAt:conversation.createdAt,deliveries:[{id:"unknown",segment:0,state:"unknown",reason:null}]}];
  page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/api/**",async route=>{
    const req=route.request(),path=new URL(req.url()).pathname,body=req.postData()?req.postDataJSON():null;calls.push({path,body});let data:unknown;
    if(path==="/api/session")data={account:{id:"owner",displayName:"Owner",email:"owner@example.test"},organizations:[{id:"org",name:"Workspace",role:"owner"}]};
    else if(path==="/api/organizations/org/channels")data={connections:[],deployments:[],websites:[]};
    else if(path.endsWith("/agents/summaries"))data={agents:[{id:"agent",name:"Support"}],nextCursor:null};
    else if(path.endsWith("/inbox/members"))data={members:[{id:"owner",displayName:"Owner"},{id:"other",displayName:"Other"}]};
    else if(path.endsWith("/inbox"))data={conversations:[conversation],nextCursor:null};
    else if(path===base)data={conversation,messages,nextSequence:"2",earlierBefore:null};
    else if(path.endsWith("/whatsapp/templates"))data={templates:[{id:"approved",name:"appointment_update",language:"en_US",category:"UTILITY",status:"APPROVED",supported:true,components:[{type:"HEADER",format:"TEXT",text:"Hello {{1}}"},{type:"BODY",text:"Your booking is {{1}} at {{2}}."},{type:"FOOTER",text:"Contact support for changes."}]},{id:"unsupported",name:"unsupported_media",language:"en_US",category:"UTILITY",status:"APPROVED",supported:false,components:[]}],nextCursor:null};
    else if(path.endsWith("/whatsapp/consent")){if(body){expect(body.expectedRevision).toBe("7");expect(body.evidence).toEqual({kind:"customer_message",messageId:"visitor"});granted=body.granted;consentRevision++;}data={revision:consentRevision,granted,categories:granted?["UTILITY"]:[]};}
    else if(path.endsWith("/media-reply")){if(mediaLost){mediaLost=false;conversation.revision="8";await route.fulfill({status:502,json:{error:{message:"Media acknowledgement lost"}}});return;}data={conversation};}
    else if(path.endsWith("/whatsapp/template-reply")){if(replyLost){replyLost=false;await route.fulfill({status:502,json:{error:{message:"Acknowledgement lost"}}});return;}data={conversation};}
    else if(path.endsWith("/deliveries/unknown/continue"))data={deliveryId:"unknown",state:"unknown",decision:"continue_without_resending"};
    else {await route.fulfill({status:404,json:{error:{message:"Fixture route unavailable"}}});return;}
    await route.fulfill({json:data});
  });
  await page.goto("/app/inbox");await page.getByRole("button",{name:/Support.*WhatsApp/}).click();await expect(page.getByRole("region",{name:"Channel support"})).toBeVisible();
  return{calls,errors};
}
async function choose(page:Page){await page.getByText("WhatsApp template reply",{exact:true}).click();await page.getByLabel("Approved template").selectOption("approved");await page.getByLabel("Header value 1").fill("Ada <img src=x>");await page.getByLabel("Body value 1").fill("confirmed");await page.getByLabel("Body value 2").fill("09:00");}
async function optIn(page:Page){await page.getByText("Customer opt-in",{exact:true}).click();await expect(page.getByLabel("Customer decision")).toHaveValue("");await expect(page.getByLabel("Utility",{exact:true})).not.toBeChecked();await page.getByLabel("Customer decision").selectOption("yes");await page.getByLabel("Utility",{exact:true}).check();await page.getByLabel("Customer message",{exact:true}).selectOption("visitor");await page.getByRole("button",{name:"Record decision"}).click();await expect(page.getByText("Recorded for utility.",{exact:true})).toBeVisible();}
test("exact template preview requires explicit evidenced consent and sends only declared parameters",async({page})=>{
  const f=await fixture(page);await choose(page);await expect(page.getByRole("button",{name:"Send template"})).toBeDisabled();
  await expect(page.getByLabel("Template preview")).toHaveText("Hello Ada <img src=x>\n\nYour booking is confirmed at 09:00.\n\nContact support for changes.");expect(await page.locator("img").count()).toBe(0);
  await optIn(page);await page.getByRole("button",{name:"Send template"}).click();const sent=f.calls.find(call=>call.path.endsWith("/template-reply"))!;
  expect(sent.body).toMatchObject({expectedRevision:"7",templateId:"approved",parameters:{header:["Ada <img src=x>"],body:["confirmed","09:00"]}});expect(Object.keys(sent.body).sort()).toEqual(["commandId","expectedRevision","parameters","templateId"]);expect(f.errors).toEqual([]);
});
test("unknown recovery requires explicit confirmation and never resends; attachments are secure links",async({page})=>{
  const f=await fixture(page);await page.getByText("Attachments",{exact:true}).click();const link=page.getByRole("link",{name:"appointment.pdf"});await expect(link).toHaveAttribute("href",`${base}/messages/visitor/attachments/0`);await expect(link).toHaveAttribute("target","_blank");
  await page.getByRole("button",{name:"Review unknown delivery"}).click();expect(f.calls.some(call=>call.path.endsWith("/continue"))).toBe(false);await page.getByRole("button",{name:"Cancel",exact:true}).click();expect(f.calls.some(call=>call.path.endsWith("/continue"))).toBe(false);
  await page.getByRole("button",{name:"Review unknown delivery"}).click();await page.getByRole("button",{name:"Continue without resending"}).click();await expect(page.getByText("Later messages can continue. This message remains unknown.",{exact:true})).toBeVisible();
  expect(f.calls.find(call=>call.path.endsWith("/continue"))!.body).toEqual({expectedRevision:"7",decision:"continue_without_resending"});expect(f.calls.some(call=>call.path.includes("resend"))).toBe(false);
});
test("unassigned operators cannot record consent, recover or send",async({page})=>{
  const f=await fixture(page,false);await page.getByText("Customer opt-in",{exact:true}).click();await expect(page.getByLabel("Customer decision")).toBeDisabled();await expect(page.getByRole("button",{name:"Review unknown delivery"})).toHaveCount(0);
  await page.getByText("WhatsApp template reply",{exact:true}).click();await page.getByLabel("Approved template").selectOption("approved");await expect(page.getByRole("button",{name:"Send template"})).toBeDisabled();expect(f.calls.filter(call=>call.body)).toHaveLength(0);
});
test("lost template acknowledgement retains original command on explicit retry",async({page})=>{
  await page.setViewportSize({width:390,height:844});const f=await fixture(page,true,true);await choose(page);await optIn(page);await page.getByRole("button",{name:"Send template"}).click();await expect(page.getByRole("alert").filter({hasText:"Acknowledgement lost"})).toBeVisible();await page.reload();await page.getByRole("button",{name:/Support.*WhatsApp/}).click();await page.getByText("WhatsApp template reply",{exact:true}).click();await expect(page.getByLabel("Header value 1")).toHaveValue("Ada <img src=x>");expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:test.info().outputPath("channel-support-mobile.png"),fullPage:true});await page.getByRole("button",{name:"Send template"}).click();
  await expect.poll(()=>f.calls.filter(call=>call.path.endsWith("/template-reply")).length).toBe(2);const sent=f.calls.filter(call=>call.path.endsWith("/template-reply"));expect(sent[0]!.body).toEqual(sent[1]!.body);
});

test("canonical media reply preserves source, nonce and original revision across lost acknowledgement reload",async({page})=>{
  const f=await fixture(page,true,false,true);await page.getByText("Attachments",{exact:true}).click();
  await page.getByRole("button",{name:"Reply with attachment",exact:true}).click();await expect(page.getByRole("alert").filter({hasText:"Media acknowledgement lost"})).toBeVisible();
  const first=f.calls.find(call=>call.path.endsWith("/media-reply"))!;expect(first.body).toMatchObject({sourceMessageId:"visitor",index:0,expectedRevision:"7"});expect(Object.keys(first.body).sort()).toEqual(["commandId","expectedRevision","index","sourceMessageId"]);
  expect(await page.evaluate(()=>sessionStorage.getItem("agents.channel-media.owner.org.conversation"))).not.toBeNull();
  await page.reload();await page.getByRole("button",{name:/Support.*WhatsApp/}).click();await page.getByText("Attachments",{exact:true}).click();
  await expect(page.getByText("An attachment reply awaits acknowledgement. Retry the same attachment to check its outcome.",{exact:true})).toBeVisible();
  expect(f.calls.filter(call=>call.path.endsWith("/media-reply"))).toHaveLength(1);
  await page.getByRole("button",{name:"Reply with attachment",exact:true}).click();await expect.poll(()=>f.calls.filter(call=>call.path.endsWith("/media-reply")).length).toBe(2);
  const retries=f.calls.filter(call=>call.path.endsWith("/media-reply"));expect(retries[1]!.body).toEqual(first.body);
  await expect.poll(()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem("agents.channel-media.owner.org.conversation")??"null"))).toBeNull();expect(f.errors).toEqual([]);
});
