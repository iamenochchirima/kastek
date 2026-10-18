import { test, expect } from "@playwright/test";
const org="11111111-1111-4111-8111-111111111111",taskId="22222222-2222-4222-8222-222222222222",label=`E${"a".repeat(32)}`;
for(const width of [1440,768,390])test(`mock transport: cited passages and revoked access at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));let withdrawn=false;
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname;let body:unknown;
    if(path==="/api/session")body={account:{id:"owner",email:"owner@example.test",displayName:"Owner"},organizations:[{id:org,name:"Research",role:"owner"}]};
    else if(path.endsWith("/evidence"))body=withdrawn?{state:"unavailable",code:"EVIDENCE_UNAVAILABLE",passages:[]}:{state:"available",passages:[{id:"source-evidence",label,title:"Research source",text:"The decisive finding appears on the final page. 🧪",page:3,section:"Findings",contentDigest:"b".repeat(64),acquiredAt:"2026-10-17T10:30:00.000Z"}]};
    else if(path.endsWith(`/tasks/${taskId}`))body={task:{id:taskId,state:"completed",input:"Summarize the source",output:withdrawn?null:`The finding is supported [${label}].`,outputAvailability:withdrawn?"unavailable":"available",conversationId:"conversation",errorCode:null},events:[],operations:[{operationId:"native",name:"opaque-alias",providerOperation:"get_repository",transport:"native_http",state:"completed"},{operationId:"mcp",name:"other-alias",providerOperation:"get_file_contents",transport:"mcp_http",state:"uncertain",errorCode:"CONNECTED_RATE_LIMIT"}]};
    else{await route.fulfill({status:404,json:{error:{message:"Unconfigured fixture route"}}});return;}
    await route.fulfill({json:body});
  });
  await page.goto(`/app/tasks/${taskId}`);await page.getByText("View sources",{exact:true}).click();
  await page.getByText("Research source",{exact:true}).click();
  await expect(page.getByText("The decisive finding appears on the final page. 🧪",{exact:true})).toBeVisible();
  await expect(page.getByText(/Retrieved /)).toBeVisible();await expect(page.getByText("Outcome unknown",{exact:true})).toBeVisible();
  await expect(page.getByText("API",{exact:true})).toBeVisible();await expect(page.getByText("MCP",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath(`citations-${width}.png`),fullPage:true});
  withdrawn=true;const refresh=page.getByRole("button",{name:"Refresh sources",exact:true});await refresh.focus();await expect(refresh).toBeFocused();await page.keyboard.press("Enter");
  await expect(page.getByText("This response is no longer available.",{exact:true})).toBeVisible();await expect(page.getByText(`The finding is supported [${label}].`,{exact:true})).toHaveCount(0);
  await expect(page.getByText("The decisive finding appears on the final page. 🧪",{exact:true})).toHaveCount(0);await page.getByRole("button",{name:"Refresh status",exact:true}).click();await expect(page.getByText("This response is no longer available.",{exact:true})).toBeVisible();await expect(page.getByText(`The finding is supported [${label}].`,{exact:true})).toHaveCount(0);expect(errors).toEqual([]);
});

test("mock transport: recovery cache cannot display stale derived answers before current-policy reads",async({page})=>{
 const deployment="33333333-3333-4333-8333-333333333333",key=`agents.website.${deployment}`,secret="WITHDRAWN_CACHED_ANSWER";
 await page.addInitScript(({key,deployment,secret})=>{sessionStorage.setItem(`agents.visitor.${deployment}`,JSON.stringify("visitor-fixture"));sessionStorage.setItem(key,JSON.stringify([{requestKey:"q1",input:"Owner question",task:{id:"old-task",conversationId:"old-conversation",state:"completed",output:secret,errorCode:null}}]));},{key,deployment,secret});
 let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
 const conversation={id:"old-conversation",state:"automation_active"};
 await page.route("**/api/**",async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith(`/website/${deployment}`)){await route.fulfill({json:{name:"Website assistant"}});return;}await barrier;
  if(path.endsWith("/customer-conversations"))await route.fulfill({json:{conversation}});
  else if(path.endsWith("/messages"))await route.fulfill({json:{conversation,messages:[{id:"visitor",sequence:"1",authorKind:"visitor",body:"Owner question",createdAt:"2026-10-19T00:00:00Z"},{id:"assistant",sequence:"2",authorKind:"assistant",taskId:"old-task",body:"[Response unavailable]",createdAt:"2026-10-19T00:00:01Z"}],nextSequence:"2"}});
  else await route.fulfill({status:404,json:{error:{message:"Unexpected canonical channel endpoint"}}});
 });
 await page.goto(`/chat/${deployment}`);await expect(page.getByText("Owner question",{exact:true})).toHaveCount(0);await expect(page.getByText(secret,{exact:true})).toHaveCount(0);
 release();await expect(page.getByText("Owner question",{exact:true})).toBeVisible();await expect(page.getByText("[Response unavailable]",{exact:true})).toBeVisible();expect(await page.evaluate(key=>sessionStorage.getItem(key),key)).toBeNull();

});
