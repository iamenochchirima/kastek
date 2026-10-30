import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const proof=fileURLToPath(new URL("../../../../.audit/growth-templates-calls/after/",import.meta.url));
const stateURL="http://127.0.0.1:4311/__fixture/communications";
test.beforeEach(async({request,context})=>{
  await mkdir(proof,{recursive:true});await request.post(stateURL);
  await context.addCookies([{name:"kasitek_active_org",value:"growth-fixture-one",domain:"127.0.0.1",path:"/"}]);
});
async function noOverflow(page:Page){await expect.poll(()=>page.evaluate(()=>Math.max(document.body.scrollWidth,document.documentElement.scrollWidth)-innerWidth)).toBeLessThanOrEqual(1);}
for(const scenario of [{width:1440,height:1000,theme:"light"},{width:1280,height:900,theme:"dark"},{width:768,height:1000,theme:"light"},{width:390,height:844,theme:"light"},{width:360,height:844,theme:"dark"}] as const) test(`Templates and Calls ${scenario.width} ${scenario.theme}`,async({page})=>{
  await page.setViewportSize(scenario);await page.emulateMedia({colorScheme:scenario.theme,reducedMotion:"reduce"});
  await page.addInitScript(t=>localStorage.setItem("kasitek-theme",t),scenario.theme);
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("/templates");await expect(page.getByRole("heading",{name:"Templates",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Preview spring_offer",exact:true}).filter({visible:true}).click();
  await noOverflow(page);await page.screenshot({path:`${proof}/templates-${scenario.width}-${scenario.theme}.png`,fullPage:true});
  if(scenario.width<1280){await page.keyboard.press("Escape");await expect(page.getByRole("button",{name:"Preview spring_offer",exact:true}).filter({visible:true})).toBeFocused();}
  await page.getByRole("button",{name:"New template",exact:true}).click();await expect(page.getByRole("dialog",{name:"Create template",exact:true})).toBeVisible();
  await noOverflow(page);await page.screenshot({path:`${proof}/create-${scenario.width}-${scenario.theme}.png`,fullPage:true});await page.keyboard.press("Escape");
  await page.goto("/calls");await expect(page.getByRole("heading",{name:"Calls",exact:true})).toBeVisible();
  const row=page.getByRole("button",{name:"Thandi Mokoena",exact:true});await row.click();
  await expect(page.getByRole("link",{name:"Open conversation",exact:true})).toHaveAttribute("href","/inbox?conversation=fixture-inbox");
  await noOverflow(page);await page.screenshot({path:`${proof}/calls-${scenario.width}-${scenario.theme}.png`,fullPage:true});
  if(scenario.width<1280){await page.keyboard.press("Escape");await expect(row).toBeFocused();}
  await page.getByRole("button",{name:"New call",exact:true}).click();await expect(page.getByRole("dialog",{name:"New call",exact:true})).toBeVisible();await noOverflow(page);
  expect(errors).toEqual([]);
});

test("template account scope, validation, failed submission and persisted review",async({page,request})=>{
 await page.goto("/templates?create=1");const dialog=page.getByRole("dialog",{name:"Create template",exact:true});await expect(dialog).toBeVisible();
 await dialog.getByRole("button",{name:"Submit template",exact:true}).click();await expect(dialog.getByText("Enter a template name",{exact:true})).toBeVisible();
 await dialog.getByRole("textbox",{name:"Template name",exact:true}).fill("controlled_template");await dialog.getByRole("textbox",{name:"Body",exact:true}).fill("Hello from the controlled fixture.");
 await dialog.getByRole("combobox",{name:"Connection",exact:true}).click();await page.getByRole("option",{name:"+27 72 000 2222",exact:true}).click();
 await page.route("**/api/whatsapp/templates",async route=>{if(route.request().method()==="POST")await route.fulfill({status:503,json:{error:"Controlled submission failed"}});else await route.continue();});
 await dialog.getByRole("button",{name:"Submit template",exact:true}).click();await expect(dialog.getByRole("alert")).toContainText("Controlled submission failed");await expect(dialog.getByRole("textbox",{name:"Body",exact:true})).toHaveValue("Hello from the controlled fixture.");
 await page.unroute("**/api/whatsapp/templates");await dialog.getByRole("button",{name:"Submit template",exact:true}).click();await expect(dialog).toBeHidden();await page.reload();
 const state=await(await request.get(stateURL)).json();expect(state.templates.find((t:{templateName:string})=>t.templateName==="controlled_template")).toMatchObject({status:"PENDING",connectionId:"whatsapp-sales"});
 await page.getByRole("combobox",{name:"Sync account",exact:true}).click();await page.getByRole("option",{name:"+27 72 000 2222",exact:true}).click();await page.getByRole("button",{name:"Sync templates",exact:true}).click();
 await expect.poll(async()=> (await(await request.get(stateURL)).json()).mutations.some((m:{connectionId:string})=>m.connectionId==="whatsapp-sales")).toBe(true);
 await page.getByRole("textbox",{name:"Search templates",exact:true}).fill("no-match");await expect(page.getByRole("heading",{name:"No matching templates",exact:true})).toBeVisible();
});

test("calls retain records during partial failure and filter real statuses",async({page})=>{
 await page.route("**/api/calls/summary",r=>r.fulfill({status:503,json:{error:"Controlled reporting outage"}}));
 await page.goto("/calls");await expect(page.getByRole("button",{name:"Thandi Mokoena",exact:true})).toBeVisible();await expect(page.getByRole("alert")).toContainText("Could not load");
 await page.getByRole("button",{name:/^Missed/}).click();await expect(page.getByRole("button",{name:"Aisha Patel",exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Thandi Mokoena",exact:true})).toHaveCount(0);
 await page.getByRole("textbox",{name:"Search calls",exact:true}).fill("no-match");await expect(page.getByText("No matching calls",{exact:true})).toBeVisible();
});

const sdk=`class Events { events={};on(n,f){(this.events[n]??=[]).push(f);return this;}emit(n,e){for(const f of this.events[n]||[])f(e);}removeAllListeners(){this.events={};}};class Call extends Events{disconnect(){window.__voice.disconnected++;this.emit('disconnect');}};export class Device extends Events{constructor(){super();window.__voice.device=this;}async connect(options){window.__voice.params=options.params;const call=new Call();window.__voice.call=call;return new Promise(resolve=>{window.__voice.resolve=()=>resolve(call);if(window.__voice.mode==='accept')setTimeout(()=>{resolve(call);setTimeout(()=>call.emit('accept'),20)},20);});}destroy(){window.__voice.destroyed++;}}`;
async function controlledVoice(page:Page,mode:string){
 await page.addInitScript(mode=>{Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:async()=>{if(mode==="denied")throw new DOMException("Denied","NotAllowedError");return{getTracks:()=>[{stop(){}}]};}}});Object.assign(window,{__voice:{mode,destroyed:0,disconnected:0}});},mode);
 await page.route(/.*(?:twilio|voice-sdk)[^/]*\.js(?:\?.*)?$/,r=>r.fulfill({contentType:"application/javascript",body:sdk}));
 await page.goto("/calls");await page.getByRole("button",{name:"New call",exact:true}).click();await page.getByRole("button",{name:/^Business phone/}).filter({visible:true}).last().click();await page.getByRole("textbox",{name:"Phone number",exact:true}).fill("+27710001111");await page.getByRole("button",{name:"Call",exact:true}).click();
}
test("microphone denial is recoverable without contacting token endpoint",async({page,request})=>{await controlledVoice(page,"denied");await expect(page.getByRole("alert")).toContainText(/microphone|Denied/i);expect((await(await request.get(stateURL)).json()).mutations).toHaveLength(0);});
test("pending connect cancellation disposes late SDK completion",async({page})=>{
 page.on("pageerror",error=>console.log("Browser error:",error.message));await controlledVoice(page,"pending");await expect.poll(()=>page.evaluate(()=>Boolean((window as unknown as {__voice:{resolve?:unknown}}).__voice.resolve))).toBe(true);
 await page.getByRole("button",{name:"Cancel call",exact:true}).filter({visible:true}).last().click();
 await expect(page.getByRole("status").filter({hasText:"Call ended"})).toBeVisible();
 await page.evaluate(()=>{(window as unknown as {__voice:{resolve:()=>void}}).__voice.resolve();});
 await expect(page.getByRole("status").filter({hasText:"Call ended"})).toBeVisible();await expect.poll(()=>page.evaluate(()=>(window as unknown as {__voice:{destroyed:number}}).__voice.destroyed)).toBeGreaterThan(0);
});
test("accepted call can be minimized and explicitly ended",async({page})=>{
 await controlledVoice(page,"accept");await expect(page.getByRole("status").filter({hasText:"Active call"}).last()).toBeVisible();
 await page.getByRole("button",{name:"Minimize",exact:true}).click();await expect(page.getByRole("button",{name:"Show call",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"End call",exact:true}).click();await expect(page.getByRole("dialog",{name:"End call?",exact:true})).toBeVisible();await page.getByRole("button",{name:"End call",exact:true}).last().click();
 await expect.poll(()=>page.evaluate(()=>(window as unknown as {__voice:{disconnected:number}}).__voice.disconnected)).toBeGreaterThan(0);
});

test("token failure retains the destination and permits retry",async({page})=>{
 await page.route("**/api/calls/twilio/browser-token",r=>r.fulfill({status:503,json:{error:"Controlled token unavailable"}}));
 await controlledVoice(page,"pending");await expect(page.getByRole("alert")).toContainText("Controlled token unavailable");await expect(page.getByRole("textbox",{name:"Phone number",exact:true})).toHaveValue("+27710001111");await expect(page.getByRole("button",{name:"Call",exact:true})).toBeEnabled();
});
test("device error disposes resources and exposes recoverable failure",async({page})=>{
 await controlledVoice(page,"pending");await expect.poll(()=>page.evaluate(()=>Boolean((window as unknown as {__voice:{device?:unknown}}).__voice.device))).toBe(true);
 await page.evaluate(()=>(window as unknown as {__voice:{device:{emit:(name:string,event:{message:string})=>void}}}).__voice.device.emit("error",{message:"Controlled device failure"}));
 await expect(page.getByRole("alert")).toContainText("Controlled device failure");await expect(page.getByRole("button",{name:"Call",exact:true})).toBeEnabled();await expect.poll(()=>page.evaluate(()=>(window as unknown as {__voice:{destroyed:number}}).__voice.destroyed)).toBeGreaterThan(0);
});
test("template outage and permission denial remain distinct from empty data",async({page})=>{
 await page.route("**/api/whatsapp/templates",r=>r.fulfill({status:503,json:{error:"Controlled outage"}}));await page.goto("/templates");await expect(page.getByRole("alert")).toContainText("Templates unavailable");await expect(page.getByRole("heading",{name:"No templates yet",exact:true})).toHaveCount(0);await page.screenshot({path:`${proof}/templates-error.png`,fullPage:true});
 await page.unroute("**/api/whatsapp/templates");await page.route("**/api/whatsapp/templates",r=>r.fulfill({status:403,json:{error:"Forbidden"}}));await page.getByRole("button",{name:"Retry templates",exact:true}).click();await expect(page.getByRole("alert")).toContainText("access denied");await page.screenshot({path:`${proof}/templates-permission.png`,fullPage:true});
});
test("empty and unavailable calls retain an honest provider state",async({page})=>{
 await page.route("**/api/calls",r=>r.fulfill({json:{calls:[]}}));await page.route("**/api/calls/providers",r=>r.fulfill({status:503,json:{error:"Controlled provider unavailable"}}));await page.goto("/calls");await expect(page.getByText("No calls yet",{exact:true})).toBeVisible();await expect(page.getByText(/Business phone · Status unavailable/)).toBeVisible();await page.screenshot({path:`${proof}/calls-empty-unavailable.png`,fullPage:true});
});

for (const event of ["reject", "cancel"] as const) test(`provider ${event} disposes the pending call`, async ({ page }) => {
  await controlledVoice(page, "pending");
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __voice: { resolve?: unknown } }).__voice.resolve))).toBe(true);
  await page.evaluate(() => (window as unknown as { __voice: { resolve: () => void } }).__voice.resolve());
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __voice: { call: { events: Record<string, unknown[]> } } }).__voice.call.events.disconnect))).toBe(true);
  await page.evaluate(event => (window as unknown as { __voice: { call: { emit: (event: string) => void } } }).__voice.call.emit(event), event);
  await expect(page.getByRole("status").filter({ hasText: "Call ended" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __voice: { destroyed: number } }).__voice.destroyed)).toBeGreaterThan(0);
});

test("leaving an active call requires an explicit disconnect choice", async ({ page }) => {
  await controlledVoice(page, "accept");
  await expect(page.getByRole("status").filter({ hasText: "Active call" }).last()).toBeVisible();
  await page.getByRole("button", { name: "Minimize", exact: true }).click();
  const inbox = page.getByRole("link", { name: "WhatsApp · Inbox calling", exact: true });
  await inbox.click();
  const confirmation = page.getByRole("dialog", { name: "Leave this call?", exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Keep call", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show call", exact: true })).toBeVisible();
  await inbox.click();
  await confirmation.getByRole("button", { name: "End call", exact: true }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __voice: { disconnected: number } }).__voice.disconnected)).toBeGreaterThan(0);
});
