import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const proof = fileURLToPath(new URL("../../../../.audit/growth-campaigns/after/", import.meta.url));
const stateURL = "http://127.0.0.1:4311/__fixture/campaigns";
test.beforeEach(async ({ request, context }) => {
  await request.post(stateURL);
  await context.addCookies([{ name: "kasitek_active_org", value: "growth-fixture-one", domain: "127.0.0.1", path: "/" }]);
});
async function review(page: Page, name: string) {
  await page.goto("/campaigns/create");
  await page.getByRole("textbox", { name: "Campaign name", exact: true }).fill(name);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search audience", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Search audience", exact: true }).fill("Customer 65");
  await expect(page.getByText("Customer 65", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Search audience", exact: true }).fill("");
  await page.getByRole("spinbutton", { name: "Batch size", exact: true }).fill("3");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("combobox", { name: "Marketing template", exact: true }).click();
  await page.getByRole("option", { name: /fixture_offer/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review campaign", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeEnabled();
}
async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
}
for (const scenario of [
  { width:1440, height:1000, theme:"light" }, { width:1280, height:900, theme:"dark" },
  { width:768, height:1000, theme:"light" }, { width:390, height:844, theme:"light" }, { width:360, height:844, theme:"dark" },
] as const) test(`Campaign screens ${scenario.width} ${scenario.theme}`, async ({ page }) => {
  await mkdir(proof, {recursive:true});
  await page.setViewportSize(scenario);
  await page.emulateMedia({colorScheme:scenario.theme, reducedMotion:"reduce"});
  await page.addInitScript(theme => localStorage.setItem("kasitek-theme",theme),scenario.theme);
  const errors:string[]=[]; page.on("pageerror",e=>errors.push(e.message));
  await page.goto("/campaigns");
  await expect(page.getByRole("heading",{name:"Campaigns",exact:true})).toBeVisible();
  await expect(page.getByRole("link",{name:/^Spring offer/}).filter({visible:true})).toBeVisible();
  await noOverflow(page); await page.screenshot({path:`${proof}/list-${scenario.width}-${scenario.theme}.png`,fullPage:true});
  await review(page,"Design review");
  await expect(page.locator(".campaign-create-page")).toHaveCSS("opacity","1");
  await noOverflow(page); await page.screenshot({path:`${proof}/review-${scenario.width}-${scenario.theme}.png`,fullPage:true});
  await page.goto("/campaigns/spring-offer");
  await expect(page.getByRole("heading",{name:/^Spring offer/})).toBeVisible();
  await expect(page.locator(".campaign-detail")).toHaveCSS("opacity","1");
  await noOverflow(page); await page.screenshot({path:`${proof}/detail-${scenario.width}-${scenario.theme}.png`,fullPage:true});
  const contactButton=page.getByRole("button",{name:/^Thandi Mokoena/}).filter({visible:true});
  await contactButton.click();
  if(scenario.width < 1200) {
    const sheet=page.getByRole("dialog",{name:"Recipient details",exact:true});
    await expect(sheet).toBeVisible();await noOverflow(page);
    await page.screenshot({path:`${proof}/contact-${scenario.width}-${scenario.theme}.png`,fullPage:true});
    await page.keyboard.press("Escape");await expect(sheet).toBeHidden();await expect(contactButton).toBeFocused();
  } else await expect(page.getByRole("heading",{name:"Selected contact",exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test("search and status views retain actual records and show retryable failure", async ({page})=>{
  await page.goto("/campaigns");
  await page.getByRole("button",{name:/^Drafts/}).click();
  await expect(page.getByRole("link",{name:"Customer follow-up",exact:true}).filter({visible:true})).toBeVisible();
  await expect(page.getByRole("link",{name:/^Spring offer/}).filter({visible:true})).toHaveCount(0);
  await page.getByRole("textbox",{name:"Search campaigns",exact:true}).fill("absent-campaign");
  await expect(page.getByRole("heading",{name:"No matching campaigns",exact:true})).toBeVisible();
  await page.screenshot({path:`${proof}/list-search-empty.png`,fullPage:true});
  await page.getByRole("button",{name:"Clear filters",exact:true}).click();
  await expect(page.getByRole("link",{name:/^Spring offer/}).filter({visible:true})).toBeVisible();
  await page.route("**/api/whatsapp/campaigns",route=>route.fulfill({status:503,json:{error:"Temporary outage"}}));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("couldn't be loaded");
  await expect(page.getByRole("heading",{name:"No campaigns yet",exact:true})).toHaveCount(0);
  await page.screenshot({path:`${proof}/list-error.png`,fullPage:true});
  await page.unroute("**/api/whatsapp/campaigns");
  await page.getByRole("button",{name:"Try again",exact:true}).click();
  await expect(page.getByRole("link",{name:/^Spring offer/}).filter({visible:true})).toBeVisible();
});

test("saves a real draft after authoritative preflight without launching",async({page,request})=>{
  await review(page,"Saved campaign");
  await expect(page.getByText("Eligible", { exact: true }).locator("..")).toContainText("63");
  await page.getByRole("button",{name:"Save draft",exact:true}).click();
  await expect(page).toHaveURL(/\/campaigns\/[^/]+\?notice=/);
  await page.reload(); await expect(page.getByRole("heading",{name:"Saved campaign",exact:true})).toBeVisible();
  const state=await (await request.get(stateURL)).json();
  expect(state.campaigns.find((c:{name:string})=>c.name==="Saved campaign").status).toBe("DRAFT");
  expect(state.mutations.filter((m:{path:string})=>m.path.endsWith("/launch"))).toHaveLength(0);
});

test("reviewed schedule retries the saved record without duplicate creation",async({page,request})=>{
  await review(page,"Scheduled campaign");
  await page.getByRole("radio",{name:"Schedule",exact:true}).check();
  await page.getByLabel("Date and time",{exact:true}).fill("2030-06-15T10:00");
  await page.getByRole("combobox",{name:"Timezone",exact:true}).click();
  await page.getByRole("option",{name:"Africa/Johannesburg",exact:true}).click();
  let fail=true;
  await page.route("**/api/whatsapp/campaigns/*/launch",async route=> {if(fail){fail=false;await route.fulfill({status:503,json:{error:"Launch temporarily unavailable"}});}else await route.continue();});
  await page.getByRole("button",{name:"Schedule campaign",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Launch temporarily unavailable");
  await expect(page.getByText(/Draft saved · 63 recipients/)).toBeVisible();
  await page.getByRole("button",{name:"Retry launch",exact:true}).click();
  await expect(page).toHaveURL(/\/campaigns\/[^/]+\?notice=/);
  const state=await (await request.get(stateURL)).json();
  expect(state.mutations.filter((m:{path:string;method:string})=>m.path==="/api/whatsapp/campaigns"&&m.method==="POST")).toHaveLength(1);
  const launch=state.mutations.find((m:{path:string})=>m.path.endsWith("/launch"));
  expect(launch.input.scheduledAt).toBe("2030-06-15T08:00:00.000Z");
  expect(state.campaigns.find((c:{name:string})=>c.name==="Scheduled campaign").status).toBe("SCHEDULED");
});

test("excludes canonical contact IDs even when contact list membership differs",async({page,request})=>{
  await page.goto("/campaigns/create");
  await page.getByRole("textbox",{name:"Campaign name",exact:true}).fill("Canonical exclusion");
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await page.getByRole("textbox",{name:"Search audience",exact:true}).fill("Customer 65");
  await page.getByRole("checkbox",{name:"Exclude Customer 65",exact:true}).check();
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await page.getByRole("combobox",{name:"Marketing template",exact:true}).click();
  await page.getByRole("option",{name:/fixture_offer/}).click();
  let preflight:Record<string,unknown>|null=null;
  page.on("request",r=>{ if(r.url().endsWith("/preflight"))preflight=r.postDataJSON(); });
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await expect(page.getByRole("button",{name:"Save draft",exact:true})).toBeEnabled();
  expect(preflight?.["excludedContactIds"]).toEqual(["campaign-contact-64"]);
  await expect(page.getByText("Eligible",{exact:true}).locator("..")).toContainText("62");
  await page.getByRole("button",{name:"Save draft",exact:true}).click();
  await expect(page).toHaveURL(/\/campaigns\/[^/]+\?notice=/);
  const state=await(await request.get(stateURL)).json();
  expect(state.mutations[0].input.excludedContactIds).toEqual(["campaign-contact-64"]);
});

test("launch requires review and cancelling confirmation never sends",async({page,request})=>{
  await page.goto("/campaigns/customer-follow-up");
  await page.getByRole("button",{name:"Launch batch",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Review launch",exact:true});
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button",{name:"Back",exact:true}).click();
  expect((await(await request.get(stateURL)).json()).mutations).toHaveLength(0);
  await page.getByRole("button",{name:"Launch batch",exact:true}).click();
  await page.getByRole("dialog",{name:"Review launch",exact:true}).getByRole("button",{name:"Queue campaign",exact:true}).click();
  await expect(page.getByRole("button",{name:"Pause",exact:true})).toBeVisible();
  const state=await(await request.get(stateURL)).json();
  expect(state.mutations).toHaveLength(1);expect(state.mutations[0].input.scheduledAt).toBeNull();
});

test("preserves pause resume next batch retry and safe cancel delete controls",async({page,request})=>{
  await page.goto("/campaigns/spring-offer");
  await page.getByRole("button",{name:"Pause",exact:true}).click();
  await expect(page.getByRole("button",{name:"Resume",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"More",exact:true}).click();
  await page.getByRole("menuitem",{name:"Cancel campaign",exact:true}).click();
  const cancel=page.getByRole("dialog",{name:"Cancel campaign?",exact:true});await expect(cancel).toBeVisible();
  await page.screenshot({path:`${proof}/cancel-confirmation.png`,fullPage:true});
  await page.keyboard.press("Escape");await expect(cancel).toBeHidden();
  await expect(page.getByRole("button",{name:"Send more",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Send more",exact:true}).click();
  const more=page.getByRole("dialog",{name:"Send more: Spring offer",exact:true});
  await expect(more.getByText("Customer 6",{exact:true})).toBeVisible();
  await page.screenshot({path:`${proof}/send-more.png`,fullPage:true});
  await more.getByRole("textbox",{name:"Search remaining contacts",exact:true}).fill("absent contact");
  await expect(more.getByRole("button",{name:"Send next batch",exact:true})).toBeEnabled();
  await more.getByRole("button",{name:"Send next batch",exact:true}).click();await expect(more).toBeHidden();
  await page.getByRole("button",{name:"Pause",exact:true}).click();
  await expect(page.getByRole("button",{name:"Resume",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"More",exact:true}).click();await page.getByRole("menuitem",{name:"Retry failed",exact:true}).click();
  const retry=page.getByRole("dialog",{name:"Retry failed recipients?",exact:true});
  await page.screenshot({path:`${proof}/retry-confirmation.png`,fullPage:true});
  await retry.getByRole("button",{name:"Retry failed",exact:true}).click();
  await expect(page.getByRole("button",{name:"Pause",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Pause",exact:true}).click();await page.getByRole("button",{name:"Resume",exact:true}).click();
  await page.getByRole("button",{name:"Pause",exact:true}).click();
  await page.getByRole("button",{name:"More",exact:true}).click();await page.getByRole("menuitem",{name:"Delete campaign",exact:true}).click();
  const remove=page.getByRole("dialog",{name:"Delete campaign?",exact:true});await expect(remove).toBeVisible();
  await page.screenshot({path:`${proof}/delete-confirmation.png`,fullPage:true});
  await remove.getByRole("button",{name:"Cancel",exact:true}).click();await expect(remove).toBeHidden();
  let state=await(await request.get(stateURL)).json();
  expect(state.mutations.map((m:{input:{action?:string}})=>m.input.action).filter(Boolean)).toEqual(["pause","send_more","pause","retry_failed","pause","resume","pause"]);
  await page.getByRole("button",{name:"More",exact:true}).click();await page.getByRole("menuitem",{name:"Cancel campaign",exact:true}).click();
  await page.getByRole("dialog",{name:"Cancel campaign?",exact:true}).getByRole("button",{name:"Cancel campaign",exact:true}).click();
  await page.getByRole("button",{name:"More",exact:true}).click();await page.getByRole("menuitem",{name:"Delete campaign",exact:true}).click();
  await page.getByRole("dialog",{name:"Delete campaign?",exact:true}).getByRole("button",{name:"Delete campaign",exact:true}).click();
  await expect(page).toHaveURL(/\/campaigns$/);
  state=await(await request.get(stateURL)).json();expect(state.campaigns.some((c:{id:string})=>c.id==="spring-offer")).toBe(false);
});

test("recipient details failure preview and stale refresh preserve real context",async({page})=>{
  await page.goto("/campaigns/spring-offer");
  await page.getByRole("button",{name:/^Thandi Mokoena/}).filter({visible:true}).click();
  await expect(page.getByRole("heading",{name:"Selected contact",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"View message",exact:true}).click();
  const preview=page.getByRole("dialog",{name:"Template preview",exact:true});await expect(preview).toContainText("Hi Thandi Mokoena");
  await page.keyboard.press("Escape");await expect(preview).toBeHidden();
  await page.getByRole("button",{name:"Actions for Customer 5",exact:true}).click();
  await page.getByRole("menuitem",{name:"View error",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"Delivery failure",exact:true})).toContainText("131047");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog",{name:"Delivery failure",exact:true})).toBeHidden();
  await page.route("**/api/whatsapp/campaigns/spring-offer",route=>route.fulfill({status:503,json:{error:"Refresh unavailable"}}));
  await page.getByRole("button",{name:"More",exact:true}).click();await page.getByRole("menuitem",{name:"Refresh results",exact:true}).click();
  await expect(page.getByRole("button",{name:"Retry refresh",exact:true})).toBeVisible();
  await expect(page.getByText("Spring offer",{exact:true}).first()).toBeVisible();
  await page.unroute("**/api/whatsapp/campaigns/spring-offer");await page.getByRole("button",{name:"Retry refresh",exact:true}).click();
  await expect(page.getByRole("button",{name:"Retry refresh",exact:true})).toHaveCount(0);
});

test("empty permission and missing service states remain explicit",async({page})=>{
  await page.route("**/api/whatsapp/campaigns",route=>route.fulfill({json:{campaigns:[]}}));
  await page.goto("/campaigns");await expect(page.getByRole("heading",{name:"No campaigns yet",exact:true})).toBeVisible();
  await page.screenshot({path:`${proof}/list-empty.png`,fullPage:true});
  await page.unroute("**/api/whatsapp/campaigns");
  await page.route("**/api/whatsapp/campaigns",route=>route.fulfill({status:403,json:{error:"Forbidden"}}));
  await page.reload();await expect(page.getByRole("alert")).toContainText("don't have access");
  await page.screenshot({path:`${proof}/list-forbidden.png`,fullPage:true});
  await page.route("**/api/whatsapp/connections",route=>route.fulfill({json:{connections:[]}}));
  await page.goto("/campaigns/create");await expect(page.getByText(/No WhatsApp accounts/)).toBeVisible();
  await page.screenshot({path:`${proof}/create-no-connection.png`,fullPage:true});
});

test("handles long names zero audiences invalid dates and remaining statuses",async({page})=>{
  await page.setViewportSize({width:1280,height:900});
  await page.route("**/api/whatsapp/campaigns",async route=>{
    const original=await route.fetch();const body=await original.json();const sample=body.campaigns[0];
    await route.fulfill({json:{campaigns:[
      {...sample,id:"long-zero",name:"A long campaign name ".repeat(12),totalRecipients:0,sentCount:0,deliveredCount:0,readCount:0,failedCount:0,blockedCount:0,unsubscribedCount:0,scheduledAt:"invalid-date",status:"DRAFT"},
      {...sample,id:"paused",name:"Paused campaign",status:"PAUSED",scheduledAt:null},
      {...sample,id:"failed",name:"Failed campaign",status:"FAILED",scheduledAt:null},
    ]}});
  });
  await page.goto("/campaigns");await expect(page.getByRole("link",{name:/^A long campaign/}).filter({visible:true})).toBeVisible();
  await expect(page.getByRole("cell",{name:"Invalid Date",exact:true})).toHaveCount(0);await noOverflow(page);
  await page.getByRole("combobox",{name:"Campaign status",exact:true}).click();await page.getByRole("option",{name:"Paused",exact:true}).click();
  await expect(page.getByRole("link",{name:"Paused campaign",exact:true})).toBeVisible();
  await expect(page.getByRole("link",{name:"Failed campaign",exact:true})).toHaveCount(0);
});

test("audience loading and failed preflight keep unavailable counts distinct from zero",async({page})=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/api/whatsapp/contacts?**",async route=>{
    if(new URL(route.request().url()).searchParams.get("limit")==="500")await gate;
    await route.continue();
  });
  await page.goto("/campaigns/create");await page.getByRole("textbox",{name:"Campaign name",exact:true}).fill("Availability check");
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  try {await expect(page.getByRole("status")).toContainText("Loading audience");await page.screenshot({path:`${proof}/audience-loading.png`,fullPage:true});}finally{release();}
  await expect(page.getByRole("status").filter({hasText:"Loading audience"})).toHaveCount(0);
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await page.getByRole("combobox",{name:"Marketing template",exact:true}).click();await page.getByRole("option",{name:/fixture_offer/}).click();
  await page.route("**/api/whatsapp/campaigns/preflight",route=>route.fulfill({status:503,json:{error:"Recipient check unavailable"}}));
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Recipient check unavailable");
  await expect(page.getByRole("button",{name:"Save draft",exact:true})).toBeDisabled();
  await expect(page.getByText("Eligible",{exact:true})).toHaveCount(0);
  await page.screenshot({path:`${proof}/preflight-error.png`,fullPage:true});
  await page.unroute("**/api/whatsapp/campaigns/preflight");await page.getByRole("button",{name:"Retry",exact:true}).click();
  await expect(page.getByRole("button",{name:"Save draft",exact:true})).toBeEnabled();
  await expect(page.getByRole("textbox",{name:"Campaign name",exact:true})).toHaveCount(0);
  await expect(page.getByText("Availability check",{exact:true})).toBeVisible();
});
