import {test,expect,type Page} from "@playwright/test";
const org="11111111-1111-4111-8111-111111111111",agent="22222222-2222-4222-8222-222222222222",version="33333333-3333-4333-8333-333333333333";
const session={account:{id:"review-owner",email:"review@example.test",displayName:"Review"},organizations:[{id:org,name:"Review",role:"owner"}]};
const configuration={executionKind:"business",instructions:"Answer clearly",model:{provider:"openrouter",model:"nvidia/nemotron-3-super-120b-a12b:free",maxInputBytes:16384,maxOutputTokens:1024,maxDurationSeconds:120},sourceRevisionIds:[],connectedToolBindingIds:[],retrievalProfile:{kind:"lexical-v1"},capabilities:Object.fromEntries(["delegation","sandbox","businessActions","workflows","schedules"].map(key=>[key,{enabled:false}]))};
const summary={id:agent,name:"Review agent",latestVersion:{id:version,number:1,draftRevision:1,executionKind:"business"},hasUnpublishedChanges:false,draftRevision:1,updatedAt:"2026-10-18T12:00:00Z"};
const task=(id:string,name:string,state="completed")=>({id,agentId:agent,agentName:name,versionId:version,versionNumber:1,conversationId:"conversation",state,createdAt:"2026-10-18T12:00:00Z",updatedAt:"2026-10-18T12:00:00Z",canControl:true,reviewOnly:false});
async function common(page:Page){await page.route("**/api/**",async route=>{const path=new URL(route.request().url()).pathname;let json:unknown;
 if(path==="/api/session")json=session;
 else if(path.endsWith("/agents/summaries"))json={agents:[summary],nextCursor:null};
 else if(path.endsWith(`/agents/${agent}`))json={agent:{id:agent,name:summary.name,draft:configuration,draftRevision:1},versions:[{id:version,number:1,configuration}],deployments:[]};
 else if(path.endsWith("/knowledge/sources"))json={sources:[],imports:[]};
 else if(path.endsWith("/skills"))json={skills:[]};
 else if(path.endsWith("/tool-bindings"))json={bindings:[]};
 else if(path.endsWith("/connections"))json={connections:[],targets:[]};
 else if(path.endsWith("/conversations"))json={conversations:[],nextCursor:null};
 else {await route.fulfill({status:404,json:{error:{message:"Unconfigured review fixture"}}});return;}
 await route.fulfill({json});});}

test("review regression: a delayed task page cannot cross a changed state filter",async({page})=>{
 await common(page);let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let requested!:()=>void;const started=new Promise<void>(resolve=>{requested=resolve;});
 await page.route("**/api/organizations/*/tasks?*",async route=>{const url=new URL(route.request().url());if(url.searchParams.has("cursor")){requested();await held;await route.fulfill({json:{tasks:[task("old-page","Old filter task")],nextCursor:null}});return;}if(url.searchParams.get("state")==="completed"){await route.fulfill({json:{tasks:[task("new-page","Completed filter task")],nextCursor:null}});return;}await route.fulfill({json:{tasks:[task("first-page","Initial task")],nextCursor:"cursor"}});});
 await page.goto("/app/tasks");await page.getByRole("button",{name:"Load more tasks",exact:true}).click();await started;await page.getByLabel("Filter by status").selectOption("completed");await expect(page.getByRole("link",{name:"Completed filter task",exact:true})).toBeVisible();const response=page.waitForResponse(response=>new URL(response.url()).searchParams.has("cursor"));release();await response;await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 await expect(page.getByRole("link",{name:"Old filter task",exact:true})).toHaveCount(0);
});

test("review regression: queued label uses the accepted API state",async({page})=>{
 await common(page);let requested="";
 await page.route("**/api/organizations/*/tasks?*",async route=>{requested=new URL(route.request().url()).searchParams.get("state")??"";await route.fulfill({json:{tasks:[],nextCursor:null}});});
 await page.goto("/app/tasks");await expect(page.getByText("No tasks yet",{exact:true})).toBeVisible();
 const values=await page.getByLabel("Filter by status").locator("option").evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value));expect(values).toContain("accepted");expect(values).not.toContain("queued");await page.getByLabel("Filter by status").selectOption("accepted");await expect.poll(()=>requested).toBe("accepted");
});

test("review regression: unknown admission remains recoverable after New chat",async({page})=>{
 await common(page);const keys:string[]=[];
 await page.route("**/api/organizations/*/tasks",async route=>{if(route.request().method()==="POST"){keys.push(route.request().postDataJSON().requestKey);await route.abort("failed");return;}await route.fallback();});
 await page.goto(`/app/agents/${agent}`);await page.getByRole("textbox",{name:"Message",exact:true}).fill("Keep this request recoverable");await page.getByRole("button",{name:"Send message",exact:true}).click();await expect(page.getByRole("button",{name:"Retry request",exact:true})).toBeVisible();
 const newChat=page.getByRole("button",{name:"New chat",exact:true});
 if(await newChat.isDisabled())return;
 await newChat.click();await expect(page.getByRole("button",{name:"Retry request",exact:true})).toBeVisible();await page.getByRole("button",{name:"Retry request",exact:true}).click();await expect.poll(()=>keys.length).toBe(2);expect(keys[1]).toBe(keys[0]);
});


test("review regression: a conversation cannot render beneath another agent",async({page})=>{
 await common(page);const conversation="44444444-4444-4444-8444-444444444444",foreignAgent="55555555-5555-4555-8555-555555555555";
 await page.route("**/api/organizations/*/conversations/*",async route=>{await route.fulfill({json:{tasks:[{id:"foreign-task",input:"Other agent private input",requestKey:"foreign-key",state:"completed",output:"Other agent derived response",errorCode:null,conversationId:conversation,versionId:version}],nextCursor:null,conversation:{id:conversation,agentId:foreignAgent,versionId:version,versionNumber:1,latestTaskId:"foreign-task",latestTurnSequence:"1"}}});});
 await page.goto(`/app/agents/${agent}/conversations/${conversation}`);await expect(page.getByRole("alert")).toBeVisible();await expect(page.getByText("Other agent private input",{exact:true})).toHaveCount(0);await expect(page.getByText("Other agent derived response",{exact:true})).toHaveCount(0);await expect(page.getByRole("button",{name:"Send message",exact:true})).toBeDisabled();
});

test("review regression: focus refresh removes withdrawn output from earlier turns",async({page})=>{
 await common(page);const conversation="44444444-4444-4444-8444-444444444444";let withdrawn=false;
 const turns=()=>[1,2].map(index=>({id:`turn-${index}`,input:`Question ${index}`,requestKey:`key-${index}`,state:"completed",output:withdrawn?null:`Derived answer ${index}`,outputAvailability:withdrawn?"unavailable":"available",errorCode:null,conversationId:conversation,versionId:version}));
 await page.route("**/api/organizations/*/conversations/*",async route=>{await route.fulfill({json:{tasks:turns(),nextCursor:null,conversation:{id:conversation,agentId:agent,versionId:version,versionNumber:1,latestTaskId:"turn-2",latestTurnSequence:"2"}}});});
 await page.route("**/api/organizations/*/tasks/**",async route=>{const id=new URL(route.request().url()).pathname.split("/").at(-1);await route.fulfill({json:{task:turns().find(turn=>turn.id===id),events:[],operations:[],artifacts:[],actions:[]}});});
 await page.goto(`/app/agents/${agent}/conversations/${conversation}`);await expect(page.getByText("Derived answer 1",{exact:true})).toBeVisible();await expect(page.getByText("Derived answer 2",{exact:true})).toBeVisible();withdrawn=true;await page.evaluate(()=>window.dispatchEvent(new Event("focus")));await expect(page.getByText("Derived answer 1",{exact:true})).toHaveCount(0);await expect(page.getByText("Derived answer 2",{exact:true})).toHaveCount(0);await expect(page.getByText("This response is no longer available.",{exact:true})).toHaveCount(2);
});

test("review regression: earlier turn artifacts hydrate after conversation reload",async({page})=>{
 await common(page);const conversation="44444444-4444-4444-8444-444444444444";
 const turns=[1,2].map(index=>({id:`report-turn-${index}`,input:`Report question ${index}`,requestKey:`report-key-${index}`,state:"completed",output:`Report answer ${index}`,errorCode:null,conversationId:conversation,versionId:version}));
 await page.route("**/api/organizations/*/conversations/*",async route=>{await route.fulfill({json:{tasks:turns,nextCursor:null,conversation:{id:conversation,agentId:agent,versionId:version,versionNumber:1,latestTaskId:turns[1].id,latestTurnSequence:"2"}}});});
 await page.route("**/api/organizations/*/tasks/**",async route=>{const id=new URL(route.request().url()).pathname.split("/").at(-1);await route.fulfill({json:{task:turns.find(turn=>turn.id===id),events:[],operations:[],actions:[],canDownloadArtifacts:true,artifacts:id===turns[0].id?[{id:"earlier-report",taskId:id,name:"Earlier research report.md",contentType:"text/markdown",bytes:180,downloadPath:`/api/organizations/${org}/tasks/${id}/artifacts/earlier-report`}]:[]}});});
 await page.goto(`/app/agents/${agent}/conversations/${conversation}`);await expect(page.getByRole("link",{name:"Earlier research report.md",exact:true})).toBeVisible();await page.reload();await expect(page.getByRole("link",{name:"Earlier research report.md",exact:true})).toBeVisible();
});

test("review regression: unavailable evidence clears the cached derived task response",async({page})=>{
 await common(page);let withdrawn=false;const taskId="policy-task";
 await page.route("**/api/organizations/*/tasks/**",async route=>{const path=new URL(route.request().url()).pathname;
  if(path.endsWith("/evidence")){await route.fulfill({json:withdrawn?{state:"unavailable",passages:[]}:{state:"available",passages:[{id:"source",label:"E1",title:"Approved source",text:"Private evidence passage",page:null,section:null,acquiredAt:"2026-10-18T12:00:00Z",contentDigest:"fixture"}]}});return;}
  await route.fulfill({json:{task:{id:taskId,input:"Question",state:"completed",output:withdrawn?null:"Derived from evidence [E1]",outputAvailability:withdrawn?"unavailable":"available",errorCode:null,conversationId:"conversation"},events:[],operations:[],artifacts:[],actions:[]}});
 });
 await page.goto(`/app/tasks/${taskId}`);await expect(page.getByText("Derived from evidence [E1]",{exact:true})).toBeVisible();await page.getByText("View sources",{exact:true}).click();await expect(page.getByText("Private evidence passage",{exact:true})).toHaveCount(1);withdrawn=true;await page.getByRole("button",{name:"Refresh sources",exact:true}).click();await expect(page.getByText("Derived from evidence [E1]",{exact:true})).toHaveCount(0);await expect(page.getByText("Private evidence passage",{exact:true})).toHaveCount(0);
});

test("review regression: denied report decision removes the private preview",async({page})=>{
 await common(page);let denied=false;const taskId="review-task",action={id:"action",reviewId:"review",reviewerAccountId:session.account.id,taskId,rootTaskId:taskId,connectionId:"connection",connectionRevision:1,destination:{label:"Local destination",resource:"local"},artifactId:"artifact",title:"Private report",payloadDigest:"digest",reviewDigest:"review-digest",state:"pending_review",expiresAt:"2099-01-01T00:00:00Z",preview:{name:"report.md",contentType:"text/markdown",content:"Private exact preview"},citedPassages:[]};
 await page.route("**/api/organizations/*/tasks/**",async route=>{if(new URL(route.request().url()).pathname.endsWith("/tool-reviews")){await route.fulfill({json:{reviews:[]}});return;}if(route.request().method()==="POST"){denied=true;await route.fulfill({status:403,json:{error:{message:"Access removed",code:"ACCESS_DENIED"}}});return;}if(denied){await route.fulfill({status:403,json:{error:{message:"Access removed",code:"ACCESS_DENIED"}}});return;}await route.fulfill({json:{task:{id:taskId,input:"Private research request",state:"waiting_review",output:"Research done",errorCode:null,conversationId:"conversation"},events:[],operations:[],artifacts:[],actions:[action]}});});
 await page.goto(`/app/tasks/${taskId}`);await expect(page.getByText("Private exact preview",{exact:true})).toBeVisible();await page.getByRole("button",{name:"Approve delivery",exact:true}).click();await expect(page.getByText("Private exact preview",{exact:true})).toHaveCount(0);await expect(page.getByText("Private research request",{exact:true})).toHaveCount(0);
});
