import { test, expect, type Page } from "@playwright/test";
async function navigate(page:Page,deployment:string){await page.evaluate(path=>{window.history.pushState({},"",path);window.dispatchEvent(new PopStateEvent("popstate"));},`/chat/${deployment}`);}
test("visitor route changes isolate pending input, initialization tokens and late acknowledgements",async({page})=>{
 const posts:{deployment:string;requestKey:string;body:string;authorization:string}[]=[],channelReads:{deployment:string;authorization:string}[]=[];
 let releaseOld:(()=>void)|undefined, releaseSecond:(()=>void)|undefined, oldAttempts=0,newAttempts=0;
 await page.route("**/api/**",async route=>{
  const url=new URL(route.request().url()),match=url.pathname.match(/^\/api\/website\/(first|second)(.*)$/);
  if(!match){await route.fulfill({status:404,json:{error:{message:"Unexpected visitor fixture route"}}});return;}
  const deployment=match[1]!,suffix=match[2]!,authorization=route.request().headers().authorization??"";
  if(!suffix){if(deployment==="second")await new Promise<void>(resolve=>{releaseSecond=resolve;});await route.fulfill({json:{name:deployment==="first"?"First private support":"Second support"}});return;}
  if(suffix==="/session"){await route.fulfill({json:{token:`token-${deployment}`}});return;}
  channelReads.push({deployment,authorization});
  const conversation={id:`conversation-${deployment}`,state:"automation_active",channel:"website",versionId:`version-${deployment}`,createdAt:"2026-10-01T12:00:00Z",updatedAt:"2026-10-01T12:00:00Z"};
  if(suffix==="/customer-conversations"){await route.fulfill({json:{conversation}});return;}
  if(suffix.endsWith("/messages")&&route.request().method()==="GET"){await route.fulfill({json:{conversation,messages:[],nextSequence:"0",latestSequence:"0",earlierBefore:null}});return;}
  if(suffix.endsWith("/messages")){
   const input=route.request().postDataJSON() as {requestKey:string;body:string};posts.push({deployment,...input,authorization});
   if(deployment==="first"){oldAttempts++;if(oldAttempts===1){await route.abort("failed");return;}await new Promise<void>(resolve=>{releaseOld=resolve;});}
   else {newAttempts++;if(newAttempts===1){await route.abort("failed");return;}}
   await route.fulfill({status:201,json:{conversation,message:{id:`message-${deployment}`,...input},replayed:false}});return;
  }
  await route.fulfill({status:404,json:{error:{message:"Unexpected visitor fixture route"}}});
 });
 await page.goto("/chat/first");await expect(page.getByRole("heading",{name:"First private support",exact:true})).toBeVisible();
 await page.getByRole("textbox",{name:"Message",exact:true}).fill("Private first-session request");await page.getByRole("button",{name:"Send message",exact:true}).click();await expect(page.getByRole("button",{name:"Retry message",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Retry message",exact:true}).click();await expect.poll(()=>!!releaseOld).toBe(true);
 await navigate(page,"second");await expect.poll(()=>!!releaseSecond).toBe(true);
 await expect(page.getByRole("heading",{name:"First private support",exact:true})).toHaveCount(0);await expect(page.getByRole("textbox",{name:"Message",exact:true})).toHaveCount(0);expect(channelReads.filter(read=>read.deployment==="second")).toEqual([]);
 releaseSecond!();await expect(page.getByRole("heading",{name:"Second support",exact:true})).toBeVisible();await expect(page.getByRole("textbox",{name:"Message",exact:true})).toHaveValue("");await expect(page.getByRole("button",{name:"Send message",exact:true})).toBeDisabled();
 await page.getByRole("textbox",{name:"Message",exact:true}).fill("Independent second-session request");await page.getByRole("button",{name:"Send message",exact:true}).click();await expect(page.getByRole("button",{name:"Retry message",exact:true})).toBeVisible();
 const oldAck=page.waitForResponse(response=>new URL(response.url()).pathname.includes("/website/first/")&&response.request().method()==="POST"&&response.status()===201);releaseOld!();await oldAck;
 await expect(page.getByRole("textbox",{name:"Message",exact:true})).toHaveValue("Independent second-session request");await expect(page.getByRole("button",{name:"Retry message",exact:true})).toBeEnabled();
 const pending=await page.evaluate(()=>JSON.parse(sessionStorage.getItem("agents.customer.pending.second.token-second")??"null"));expect(pending.body).toBe("Independent second-session request");
 await page.getByRole("button",{name:"Retry message",exact:true}).click();await expect(page.getByRole("textbox",{name:"Message",exact:true})).toHaveValue("");
 const oldPosts=posts.filter(post=>post.deployment==="first"),newPosts=posts.filter(post=>post.deployment==="second");expect(oldPosts).toHaveLength(2);expect(oldPosts[0]?.requestKey).toBe(oldPosts[1]?.requestKey);expect(newPosts).toHaveLength(2);expect(newPosts[0]?.requestKey).toBe(newPosts[1]?.requestKey);expect(newPosts.every(post=>post.body==="Independent second-session request"&&post.authorization==="Bearer token-second")).toBe(true);expect(channelReads.filter(read=>read.deployment==="second").every(read=>read.authorization==="Bearer token-second")).toBe(true);
});
