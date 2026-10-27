import { test, expect } from "@playwright/test";
const org="11111111-1111-4111-8111-111111111111", otherOrg="33333333-3333-4333-8333-333333333333",taskId="22222222-2222-4222-8222-222222222222";
const session={account:{id:"owner",email:"owner@example.test",displayName:"Owner"},organizations:[{id:org,name:"Research",role:"owner"},{id:otherOrg,name:"Studio",role:"owner"}]};
for(const width of [1440,768,390])test(`mock transport: management and settings at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});const errors:string[]=[];page.on("pageerror",cause=>errors.push(cause.message));
 await page.route("**/api/**",async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==="/api/session"){await route.fulfill({json:session});return;}
  if(path.endsWith("/model-providers/catalogue")){await route.fulfill({json:{providers:[]}});return;}
  if(path.endsWith("/model-providers/default")){await route.fulfill({json:{selection:null,revision:0}});return;}
  if(path.endsWith("/model-providers")){await route.fulfill({json:{connections:[]}});return;}
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

test("task rows keep long agent names readable on mobile in both themes", async ({ page }) => {
  const name = "Support" + "x".repeat(120);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: session });
    if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [], nextCursor: null } });
    if (path.endsWith("/tasks")) return route.fulfill({ json: { tasks: [{ id: taskId, agentId: "agent", agentName: name, state: "cancel_requested", createdAt: "2026-10-18T12:00:00Z", reviewOnly: true }], nextCursor: null } });
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/app/tasks");
    const row = page.locator(".task-list-row");
    await expect(row.getByRole("link", { name, exact: true })).toBeVisible();
    await expect(row.getByText("cancel requested", { exact: true })).toBeVisible();
    expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("knowledge and settings dialog visual states in light and dark", async ({ page }) => {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: session });
    if (path.endsWith("/knowledge/sources")) return route.fulfill({ json: { sources: [], imports: [] } });
    if (path.endsWith("/model-providers/catalogue")) return route.fulfill({ json: { providers: [] } });
    if (path.endsWith("/model-providers/default")) return route.fulfill({ json: { selection: null, revision: 0 } });
    if (path.endsWith("/model-providers")) return route.fulfill({ json: { connections: [] } });
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/app/knowledge");
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Title", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await dialog.getByRole("textbox", { name: "Content", exact: true }).fill("Keep this information");
    await dialog.getByRole("button", { name: "Import source", exact: true }).click();
    await expect(dialog.getByLabel("Title", { exact: true })).toHaveAttribute("aria-describedby", "source-error-title");
    await expect(dialog.locator("#source-error-title")).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Content", exact: true })).toHaveValue("Keep this information");
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`knowledge-dialog-${theme}-${width}.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
    await page.goto("/app/settings");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`settings-dialog-${theme}-${width}.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
  }
});
