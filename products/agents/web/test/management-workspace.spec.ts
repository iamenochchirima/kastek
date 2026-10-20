import { test, expect } from "@playwright/test";
const org="11111111-1111-4111-8111-111111111111", otherOrg="33333333-3333-4333-8333-333333333333",taskId="22222222-2222-4222-8222-222222222222";
const session={account:{id:"owner",email:"owner@example.test",displayName:"Owner"},organizations:[{id:org,name:"Research",role:"owner"},{id:otherOrg,name:"Studio",role:"owner"}]};
for(const width of [1440,768,390])test(`mock transport: management and settings at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});const errors:string[]=[];page.on("pageerror",cause=>errors.push(cause.message));
 await page.route("**/api/**",async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==="/api/session"){await route.fulfill({json:session});return;}
  if(path.endsWith("/knowledge/sources")){await route.fulfill({json:{sources:[{id:"source",title:"Research notes",state:"active",visibility:"private",generation:1,canApprove:true,revisions:[{id:"revision",revision:1,state:"approved",acquiredAt:"2026-10-18T12:00:00Z"}]}],imports:[]}});return;}
  if(path.endsWith("/api-connections")){await route.fulfill({json:{connections:[]}});return;}
  if(path.endsWith("/remote-connections")){await route.fulfill({json:{connections:[]}});return;}
  if(path.endsWith("/connectors")){await route.fulfill({json:{connectors:[]}});return;}
  if(path.endsWith("/connections")){await route.fulfill({json:{connections:[],targets:[],profiles:[{id:"public-repository-read-v1",label:"Public repositories",allowedTransports:["native_http"]}]}});return;}
  if(path.endsWith("/automations")){await route.fulfill({json:{automations:[]}});return;}
  if(path.endsWith("/agents")){await route.fulfill({json:{agents:[]}});return;}
  await route.fulfill({status:404,json:{error:{message:"Unconfigured fixture route"}}});
 });
 await page.goto("/app/settings");await expect(page.getByRole("heading",{name:"Settings",exact:true})).toBeVisible();await expect(page.getByRole("region",{name:"Account",exact:true}).getByText("owner@example.test",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Dark",exact:true}).click();await expect(page.locator("html")).toHaveClass(/dark/);await page.getByRole("button",{name:"Light",exact:true}).click();await expect(page.locator("html")).not.toHaveClass(/dark/);await page.getByRole("button",{name:"System",exact:true}).click();await page.emulateMedia({colorScheme:"dark"});await expect(page.locator("html")).toHaveClass(/dark/);await page.emulateMedia({colorScheme:"light"});await expect(page.locator("html")).not.toHaveClass(/dark/);
 await page.getByRole("button",{name:"Create workspace",exact:true}).click();await expect(page.getByRole("dialog")).toBeVisible();await page.keyboard.press("Escape");
 await page.goto("/app/knowledge");await expect(page.getByRole("heading",{name:"Research notes",exact:true})).toBeVisible();await page.getByRole("button",{name:"Add source",exact:true}).click();await expect(page.getByRole("dialog").getByLabel("Title",{exact:true})).toBeVisible();await page.keyboard.press("Escape");
 await page.goto("/app/connections");await page.getByRole("button",{name:"Add connection",exact:true}).click();await expect(page.getByRole("dialog").getByText("Approved repositories",{exact:true})).toBeVisible();await expect(page.getByRole("dialog").getByLabel("API key",{exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:test.info().outputPath(`connections-${width}.png`),fullPage:true});await page.keyboard.press("Escape");
 await page.goto("/app/automations");await expect(page.getByRole("heading",{name:"Automations",exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
});
test("mock transport: task events page without duplicates and policy denial clears task content",async({page})=>{
 let denied=false,requests=0;
 await page.route("**/api/**",async route=>{
  const url=new URL(route.request().url()),path=url.pathname;
  if(path==="/api/session"){await route.fulfill({json:session});return;}
  if(path.endsWith("/events")){requests++;expect(url.searchParams.get("cursor")).toBe("opaque-cursor");await route.fulfill({json:{events:[{sequence:"2",kind:"task.completed",createdAt:"2026-10-18T12:01:00Z"}],nextCursor:null}});return;}
  if(path.endsWith(`/tasks/${taskId}`)){
   if(denied){await route.fulfill({status:403,json:{error:{message:"Access removed"}}});return;}
   await route.fulfill({json:{task:{id:taskId,state:"completed",input:"Private request",output:"Private derived response",errorCode:null,conversationId:"conversation"},events:[{sequence:"1",kind:"task.accepted",createdAt:"2026-10-18T12:00:00Z"}],eventsNextCursor:"opaque-cursor",operations:[]}});return;
  }
  await route.fulfill({status:404,json:{error:{message:"Not found"}}});
 });
 await page.goto(`/app/tasks/${taskId}`);await expect(page.getByText("Private derived response",{exact:true})).toBeVisible();await page.getByText("Event history",{exact:true}).click();await page.getByRole("button",{name:"Load more events",exact:true}).click();await expect(page.getByText("task completed",{exact:true})).toBeVisible();await expect(page.getByText("task accepted",{exact:true})).toHaveCount(1);expect(requests).toBe(1);
 denied=true;await page.getByRole("button",{name:"Refresh status",exact:true}).click();await expect(page.getByRole("alert")).toContainText("Access removed");await expect(page.getByText("Private derived response",{exact:true})).toHaveCount(0);await expect(page.getByText("Private request",{exact:true})).toHaveCount(0);await expect(page.getByText("task accepted",{exact:true})).toHaveCount(0);
});
