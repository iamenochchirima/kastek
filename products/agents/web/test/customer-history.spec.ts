import { test, expect, type Page } from "@playwright/test";
const org="11111111-1111-4111-8111-111111111111", agent="22222222-2222-4222-8222-222222222222", conversation="33333333-3333-4333-8333-333333333333";
const detail={id:conversation,agentId:agent,agentName:"Support agent",deploymentId:"deployment",versionId:"version",channel:"website",state:"human_owned",assigneeAccountId:"owner",revision:"1",ownershipGeneration:"2",createdAt:"2026-10-01T12:00:00Z",updatedAt:"2026-10-01T12:00:00Z"};
function messages(start:number,count:number,withdrawn=false){return Array.from({length:count},(_,index)=>({id:`message-${start+index}`,sequence:String(start+index),authorKind:"assistant",body:withdrawn?"[Response unavailable]":`Canonical response ${start+index}`,createdAt:"2026-10-01T12:00:00Z"}));}
async function mock(page:Page,staff:boolean,second=false){let withdrawn=false,holdNextLatest=false,release:(()=>void)|undefined;const requests:string[]=[];
 await page.route("**/api/**",async route=>{const url=new URL(route.request().url()),path=url.pathname;let json:unknown;
  if(path==="/api/session")json={account:{id:"owner",email:"support@example.test",displayName:"Support"},organizations:[{id:org,name:"Workspace",role:"owner"}]};
  else if(path.endsWith("/members"))json={members:[{id:"owner",displayName:"Support"}]};
  else if(path.endsWith("/agents/summaries"))json={agents:[{id:agent,name:"Support agent"}],nextCursor:null};
  else if(path.endsWith("/inbox"))json={conversations:[detail,...second?[{...detail,id:"other-conversation",agentName:"Other support"}]:[]],nextCursor:null};
  else if(path===`/api/website/deployment`)json={name:"Support agent"};
  else if(path.endsWith("/session"))json={token:"visitor-token"};
  else if(path.endsWith("/customer-conversations"))json={conversation:detail};
  else if(path.endsWith("/inbox/other-conversation"))json={conversation:{...detail,id:"other-conversation"},messages:[{...messages(1,1)[0],body:"Other conversation content"}],nextSequence:"1",earlierBefore:null};
  else if(path.endsWith("/messages")||path.endsWith(`/inbox/${conversation}`)){
   const before=url.searchParams.get("before");requests.push(before??"latest");const old=withdrawn;
   if(!before&&holdNextLatest){holdNextLatest=false;await new Promise<void>(resolve=>{release=resolve;});}
   json={conversation:detail,messages:before?messages(1,5,withdrawn):messages(6,100,old),nextSequence:"105",earlierBefore:before?null:"6"};
  }else {await route.fulfill({status:404,json:{error:{message:"Unexpected history fixture route"}}});return;}
  await route.fulfill({json});
 });
 await page.goto(staff?"/app/inbox":"/chat/deployment");if(staff)await page.getByRole("button",{name:/^Support agent/}).click();
 return {requests,withdraw:()=>{withdrawn=true;},hold:()=>{holdNextLatest=true;},release:()=>release?.(),held:()=>!!release};
}
for(const staff of [true,false])for(const width of [1440,768,390])test(`${staff?"Inbox":"Visitor"} bounded earlier/latest history and policy refresh at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:1000});const fixture=await mock(page,staff);
 await expect(page.getByText("Canonical response 6",{exact:true})).toBeVisible();expect(await page.getByRole("log").locator("article").count()).toBe(100);
 await page.getByRole("button",{name:"Earlier messages",exact:true}).click();await expect(page.getByText("Canonical response 1",{exact:true})).toBeVisible();expect(await page.getByRole("log").locator("article").count()).toBe(5);await expect(page.getByText("Canonical response 105",{exact:true})).toHaveCount(0);await expect(page.getByRole("button",{name:"Earlier messages",exact:true})).toBeDisabled();
 await page.screenshot({path:`.artifacts/customer-history-${staff?"staff":"visitor"}-${width}.png`,fullPage:true});
 fixture.withdraw();await expect(page.getByText("Canonical response 1",{exact:true})).toHaveCount(0);await expect(page.getByText("[Response unavailable]",{exact:true})).toHaveCount(5);expect(fixture.requests.at(-1)).toBe("6");
 await page.getByRole("button",{name:"Latest messages",exact:true}).click();await expect(page.getByText("[Response unavailable]",{exact:true})).toHaveCount(100);await expect(page.getByRole("button",{name:"Latest messages",exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
for(const staff of [true,false])test(`${staff?"Inbox":"Visitor"} rejects a late latest-page response after changing history page`,async({page})=>{
 const fixture=await mock(page,staff);await expect(page.getByText("Canonical response 6",{exact:true})).toBeVisible();fixture.hold();await expect.poll(fixture.held).toBe(true);
 await page.getByRole("button",{name:"Earlier messages",exact:true}).click();await expect(page.getByText("Canonical response 1",{exact:true})).toBeVisible();fixture.release();
 await expect.poll(()=>fixture.requests.filter(value=>value==="6").length).toBeGreaterThan(1);await expect(page.getByText("Canonical response 105",{exact:true})).toHaveCount(0);expect(await page.getByRole("log").locator("article").count()).toBe(5);
});

test("Inbox rejects a delayed response for a different customer conversation",async({page})=>{
 const fixture=await mock(page,true,true);await expect(page.getByText("Canonical response 6",{exact:true})).toBeVisible();fixture.hold();await expect.poll(fixture.held).toBe(true);
 await page.getByRole("button",{name:/Other support/}).click();await expect(page.getByText("Other conversation content",{exact:true})).toBeVisible();fixture.release();
 await expect.poll(()=>fixture.requests.length).toBeGreaterThan(1);await expect(page.getByText("Canonical response 6",{exact:true})).toHaveCount(0);await expect(page.getByText("Other conversation content",{exact:true})).toBeVisible();
});
