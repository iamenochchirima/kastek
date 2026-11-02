import { test, expect, type Page } from "@playwright/test";
const base="/api/organizations/org/channels";
// Controlled HTTP responses exercise the real UI without contacting a provider or model.
async function fixture(page:Page,callback=false,query="",existing=false){
  let connection:Record<string,unknown>|null=existing?{id:"one",kind:"telegram",mode:"bot",name:"Existing support bot",assetId:"123",state:"active",revision:1,credentialRevision:1,metadata:{}}:null;const calls:{path:string;body:Record<string,unknown>|null}[]=[],errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/api/**",async route=>{
    const req=route.request(),path=new URL(req.url()).pathname,body=req.postData()?req.postDataJSON():null;calls.push({path,body});let data:unknown;
    const current=()=>connection??{id:"one",kind:"facebook",mode:"meta",name:"Support page",assetId:null,state:"pending",revision:1,credentialRevision:0,metadata:{}};
    if(path==="/api/session")data={account:{id:"owner",email:"owner@example.test",displayName:"Owner"},organizations:[{id:"org",name:"Workspace",role:"owner"}]};
    else if(path===`${base}/catalogue`)data={channels:["website","whatsapp","telegram","facebook","instagram"].map(kind=>({kind,name:kind==="facebook"?"Messenger":kind[0]!.toUpperCase()+kind.slice(1),assetLabel:"Account",modes:[{id:kind==="telegram"?"bot":"meta",available:true}],restrictions:[]}))};
    else if(path===base)data={connections:connection?[connection]:[],deployments:existing?[{id:"binding",connectionId:"one",agentId:"agent",state:"active"}]:[],websites:[]};
    else if(path.endsWith("/agents/summaries"))data={agents:[{id:"agent",name:"Support"}],nextCursor:null};
    else if(path.endsWith("/agents/outside"))data={agent:{id:"outside",name:"Outside first page",setup:{business:{website:"kasitek.co.za"}}},deployments:[]};
    else if(path===`${base}/telegram/connect`){connection={id:"one",kind:"telegram",mode:"bot",name:body.name,assetId:"123",state:"pending",revision:1,credentialRevision:1,metadata:{}};data={connection,status:"replacement_required",replacementConfirmation:"opaque-reviewed-webhook"};}
    else if(path.endsWith("/telegram/setup")){expect(body.confirmReplacement).toBe("opaque-reviewed-webhook");connection={...connection,state:"active",revision:2};data={connection,status:"active"};}
    else if(path.endsWith("/bind")){expect(body.agentId).toBe("agent");data={deployment:{id:"binding"}};}
    else if(path===`${base}/meta/complete`){expect(body).toEqual({code:"provider-code",state:"owner-state"});connection=current();data={ticket:"private-ticket",connectionId:"one"};}
    else if(path===`${base}/one`)data={connection:current()};
    else if(path===`${base}/meta/assets`)data={assets:[{id:"forbidden",name:"Unavailable page",eligible:false,reasonCode:"MISSING_PERMISSION",metadata:{}},{id:"page",name:"Support page",eligible:true,reasonCode:null,metadata:{}}],nextCursor:null};
    else if(path===`${base}/meta/select`){expect(body).toEqual({ticket:"private-ticket",assetId:"page"});connection={...current(),state:"active",assetId:"page",revision:2};data={connection};}
    else if(path.endsWith("/connections"))data={connections:[],profiles:[],targets:[]};
    else if(path.endsWith("/supported-connections/catalogue"))data={providers:[]};
    else if(path.endsWith("/api-connections")||path.endsWith("/remote-connections"))data={connections:[]};
    else {await route.fulfill({status:404,json:{error:{message:"Fixture route unavailable"}}});return;}
    await route.fulfill({json:data});
  });
  await page.goto(`/app/connections${callback?"?code=provider-code&state=owner-state":query}`);return{calls,errors};
}
for(const width of [1440,768,390])test(`explicit Telegram webhook replacement and binding at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});const f=await fixture(page);
  const channels=page.getByRole("region",{name:"Customer channels"});
  await channels.getByRole("listitem").filter({has:page.getByText("Telegram",{exact:true})}).getByRole("button",{name:"Connect",exact:true}).click();
  const dialog=page.getByRole("dialog");await dialog.getByLabel("Bot token",{exact:true}).fill("123:fixture_secret");await dialog.getByRole("button",{name:"Connect bot",exact:true}).click();
  await expect(dialog.getByRole("button",{name:"Replace existing webhook"})).toBeVisible();expect(f.calls.filter(call=>call.path.endsWith("/telegram/setup"))).toHaveLength(0);
  await dialog.getByRole("button",{name:"Replace existing webhook"}).click();await dialog.getByLabel("Serving agent").selectOption("agent");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath(`telegram-${width}.png`),fullPage:true});
  await dialog.getByRole("button",{name:"Connect agent",exact:true}).click();await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(()=>[...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>value.includes("fixture_secret")))).toBe(false);expect(f.errors).toEqual([]);
});
test("OAuth return exchanges once, strips credentials and requires an eligible asset",async({page})=>{
  const f=await fixture(page,true),dialog=page.getByRole("dialog");await expect(dialog.getByLabel("Channel asset")).toBeVisible();
  await expect(page).toHaveURL(/\/app\/connections$/);expect(f.calls.filter(call=>call.path.endsWith("/meta/complete"))).toHaveLength(1);
  await expect(dialog.getByRole("option",{name:/Unavailable page/})).toHaveAttribute("disabled", "");
  await expect(dialog.getByRole("button",{name:"Use selected asset"})).toBeDisabled();await dialog.getByLabel("Channel asset").selectOption("page");await dialog.getByRole("button",{name:"Use selected asset"}).click();await expect(dialog.getByLabel("Serving agent")).toBeVisible();expect(f.errors).toEqual([]);
});
test("channel Inbox filters, uncertain receipts and conversation drafts remain independent",async({page})=>{
  const reads:string[]=[],writes:unknown[]=[];const now="2026-10-21T12:00:00Z";
  const conversations=["a","b"].map(id=>({id,agentId:"agent",agentName:`Support ${id}`,deploymentId:null,versionId:"version",channel:"telegram",connectionId:"bot",connectionName:"Help bot",externalConversationId:`thread-${id}`,state:"human_owned",assigneeAccountId:"owner",revision:"1",ownershipGeneration:"1",createdAt:now,updatedAt:now}));
  await page.route("**/api/**",async route=>{const request=route.request(),url=new URL(request.url()),path=url.pathname;let data:unknown;
    if(request.method()==="POST")writes.push(request.postDataJSON());
    if(path==="/api/session")data={account:{id:"owner",email:"owner@example.test",displayName:"Owner"},organizations:[{id:"org",name:"Workspace",role:"owner"}]};
    else if(path.endsWith("/channels"))data={connections:[{id:"bot",name:"Help bot",kind:"telegram"}]};
    else if(path.endsWith("/inbox/members"))data={members:[{id:"owner",displayName:"Owner"}]};
    else if(path.endsWith("/agents/summaries"))data={agents:[{id:"agent",name:"Support"}],nextCursor:null};
    else if(path.endsWith("/inbox")){reads.push(url.search);data={conversations,nextCursor:null};}
    else if(/\/inbox\/[ab]$/.test(path))data={conversation:conversations.find(item=>path.endsWith(`/${item.id}`)),messages:[{id:"message",sequence:"1",authorKind:"human",body:"We will help",createdAt:now,channelFacts:{occurredAt:now,replyToProviderMessageId:null,attachments:[{index:0,kind:"document",fileName:"details.pdf"}]},deliveries:[{id:"delivery",segment:0,state:"unknown",reason:"lost_ack"}]}],nextSequence:"1"};
    else {await route.fulfill({status:404,json:{error:{message:"Unexpected Inbox fixture"}}});return;}await route.fulfill({json:data});
  });
  await page.goto("/app/inbox");await page.getByText("Filters", { exact: true }).click();
  await page.getByLabel("Filter Inbox channel").selectOption("telegram");await page.getByLabel("Filter Inbox connection").selectOption("bot");await expect.poll(()=>reads.some(value=>value.includes("channel=telegram")&&value.includes("connectionId=bot"))).toBe(true);
  await page.getByRole("complementary",{name:"Customer conversations"}).getByRole("button",{name:/Support a/}).click();await expect(page.getByLabel("Delivery status")).toContainText("Outcome unknown · Check provider before retrying");await expect(page.getByLabel("Message attachments")).toContainText("details.pdf");await page.getByLabel("Reply to customer").fill("Draft A");
  await page.getByRole("complementary",{name:"Customer conversations"}).getByRole("button",{name:/Support b/}).click();await expect(page.getByLabel("Reply to customer")).toHaveValue("");await page.getByLabel("Reply to customer").fill("Draft B");await page.getByRole("complementary",{name:"Customer conversations"}).getByRole("button",{name:/Support a/}).click();await expect(page.getByLabel("Reply to customer")).toHaveValue("Draft A");expect(writes).toEqual([]);
});


test("guided channel intent selects an agent outside the first page and prefills its website",async({page})=>{
  const f=await fixture(page,false,"?agentId=outside&channel=website&returnTo=%2Fapp%2Fagents%2Foutside%3Fsetup%3Dchannels");
  const dialog=page.getByRole("dialog");
  await expect(dialog.getByLabel("Serving agent")).toHaveValue("outside");
  await expect(dialog.getByLabel("Website domains")).toHaveValue("kasitek.co.za");
  await expect(page.getByRole("link",{name:"Back to agent",exact:true,includeHidden:true})).toHaveAttribute("href","/app/agents/outside?setup=channels");
  await dialog.getByRole("button",{name:"Close",exact:true}).last().click();
  await expect(dialog).toBeHidden();
  expect(f.calls.some(call=>call.body!==null)).toBe(false);
  expect(f.errors).toEqual([]);
});

test("Meta callback restores scoped agent context and retains asset selection",async({page})=>{
  await page.addInitScript(()=>sessionStorage.setItem("agents.channel-setup.org",JSON.stringify({state:"owner-state",expiresAt:Date.now()+60000,agentId:"agent",channel:"facebook",returnTo:"/app/agents/agent?setup=channels"})));
  const f=await fixture(page,true),dialog=page.getByRole("dialog");
  await expect(dialog.getByLabel("Channel asset")).toBeVisible();
  await expect(page).toHaveURL(/agentId=agent/);
  await expect(page).not.toHaveURL(/[?&](code|state)=/);
  await expect(page.getByRole("link",{name:"Back to agent",exact:true,includeHidden:true})).toHaveAttribute("href","/app/agents/agent?setup=channels");
  await dialog.getByLabel("Channel asset").selectOption("page");
  await dialog.getByRole("button",{name:"Use selected asset"}).click();
  await expect(dialog.getByLabel("Serving agent")).toHaveValue("agent");
  expect(f.calls.filter(call=>call.path.endsWith("/meta/complete"))).toHaveLength(1);
  expect(await page.evaluate(()=>sessionStorage.getItem("agents.channel-setup.org"))).toBeNull();
  expect(f.errors).toEqual([]);
});


test("guided manage channel opens the existing serving connection",async({page})=>{
  const f=await fixture(page,false,"?agentId=agent&channel=telegram",true);
  const dialog=page.getByRole("dialog",{name:"Manage Telegram",exact:true});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Serving agent")).toHaveValue("agent");
  await expect(dialog.getByRole("button",{name:"Connect agent",exact:true})).toBeDisabled();
  await expect(dialog.getByLabel("Replacement bot token")).toBeVisible();
  expect(f.calls.some(call=>call.body!==null)).toBe(false);expect(f.errors).toEqual([]);
});
