import { expect, test, type Page } from "@playwright/test";
const base = "/api/organizations/org";
async function fixture(page: Page) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let draftRevision = 1;
  let setup: unknown = null, setupStep: string | null = null, name = "Bicycle shop assistant";
  const policies: Record<string, unknown>[] = [];
  let configuration = { executionKind: "business", instructions: "Support customers", model: { selection: { kind: "organization_default" } }, tools: ["knowledge.search", "knowledge.read"], sourceRevisionIds: ["existing-source"], capabilities: {businessActions:{enabled:false},delegation:{enabled:false},sandbox:{enabled:false},workflows:{enabled:false},schedules:{enabled:false}} };
  const agent = () => ({ id: "new-agent", name, setup, setupStep, draft: configuration, draftRevision });
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const body = req.postData() ? req.postDataJSON() : null;
    if (body) requests.push({ path, body });
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test" }, organizations: [{ id: "org", name: "Business", role: "owner" }] };
    else if (path.endsWith("/agents/summaries")) data = { agents: [], nextCursor: null };
    else if (path.endsWith("/inbox-alerts")) data = { unread: 0, alerts: [] };
    else if (path === `${base}/agents` && req.method() === "POST") {setup=body.setup;name=body.name;data = { agent: agent() };}
    else if (path.endsWith("/website-crawls")) data = { crawls: [], available: true };
    else if (path.endsWith("/configuration")) {expect(body.expectedRevision).toBe(draftRevision);configuration=body.configuration;setup=body.setup ?? setup;setupStep=body.setupStep ?? setupStep;name=body.name;draftRevision++; data = { agent: agent(), deployments: [], snapshot: { id: "version", number: 1, configuration } }; }
    else if (path === `${base}/agents/new-agent`) data = { agent: agent(), deployments: [], versions: [] };
    else if (path.endsWith("/booking-policies")) {
      if(req.method()==="POST") { const policy={id:"policy",policyDigest:"digest",state:"active",definition:{...body,calendarId:"primary",connectionPolicyRevision:1}};policies.push(policy);data={policy}; }
      else data={policies};
    }
    else if(path.endsWith("/provider-calendars/connections"))data={connections:[{providerId:"google-calendar",id:"calendar",name:"Appointments",operations:["calendar.availability","calendar.book"],customerDeploymentEligible:true,calendar:{name:"Bookings",timeZone:"Africa/Johannesburg"}}]};
    else if(path.endsWith("/setup-readiness"))data={readiness:{readyToTest:true,setupStep,requirements:{model:{state:"ready",code:null},bookings:{state:"deferred",code:null}},channels:[{kind:"website",state:"needs_connection"}]}};
    else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
    else if (path.endsWith("/model-providers/default")) data = { selection: null, revision: 0 };
    else if (path.endsWith("/model-providers")) data = { connections: [] };
    else data = {};
    await route.fulfill({ json: data });
  });
  return requests;
}
async function start(page: Page) {
  await page.goto("/app/agents");
  await page.getByRole("button", { name: "Create agent", exact: true }).filter({ visible: true }).first().click();
  return page.getByRole("dialog", { name: "Create agent", exact: true });
}
async function setSupportHours(dialog: ReturnType<Page["getByRole"]>) {
  await dialog.getByLabel("Timezone", { exact: true }).fill("Africa/Johannesburg");
  await dialog.getByLabel("Monday", { exact: true }).check();
  await dialog.getByLabel("Monday opens").fill("09:00");
  await dialog.getByLabel("Monday closes", { exact: true }).fill("12:00");
  await dialog.getByRole("button", { name: "Add Monday hours" }).click();
  await dialog.getByLabel("Monday opens 2").fill("13:00");
  await dialog.getByLabel("Monday closes 2").fill("17:00");
}
for (const width of [1440, 768, 390]) test(`guided setup preserves choices and knowledge at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); const requests = await fixture(page); const dialog = await start(page);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByLabel("Website (optional)").fill("bicycles.example");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Enter your business name.");
  await expect(dialog.getByLabel("Business name", { exact: true })).toHaveAttribute("aria-describedby", "setup-error-business");
  await expect(dialog.getByLabel("Business name", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByLabel("Website (optional)")).toHaveValue("bicycles.example");
  await dialog.getByLabel("Business name", { exact: true }).fill("Bicycle shop");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByLabel("Website (optional)").fill("bicycles.example");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByLabel(/Book appointments/).check();
  await dialog.getByLabel(/Collect enquiries/).check();
  await page.screenshot({ path: test.info().outputPath(`responsibilities-${width}.png`), fullPage: true });
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByLabel("Business website", { exact: true })).toHaveValue("bicycles.example");
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  expect(requests.filter(request => request.path === `${base}/agents`)).toHaveLength(1);
  await dialog.getByRole("button", { name: "Skip for now", exact: true }).click();
  await dialog.getByLabel("WhatsApp", { exact: true }).check();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByLabel("Agent name", { exact: true }).fill("Cycle helper");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Select support days and enter valid hours and timezone.");
  await setSupportHours(dialog);
  await dialog.getByLabel("Duration (minutes)").fill("45");
  await dialog.getByLabel("Availability and booking rules").fill("Weekdays, 9–5");
  await dialog.getByLabel("Phone", { exact: true }).check();
  await page.screenshot({ path: test.info().outputPath(`preferences-${width}.png`), fullPage: true });
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await dialog.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("heading",{name:"Appointments",exact:true})).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollTop)).toBe(0);
  await dialog.getByRole("button",{name:"Continue",exact:true}).click();
  await expect(dialog).toContainText("Channels still need connecting.");
  await page.screenshot({ path: test.info().outputPath(`review-${width}.png`), fullPage: true });
  await dialog.getByRole("button", { name: "Create and test", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/agents\/new-agent$/);
  const saved = requests.filter(request => request.path.endsWith("/configuration")).at(-1)!.body;
  expect(saved.name).toBe("Cycle helper");
  expect(saved.configuration).toEqual(expect.objectContaining({ sourceRevisionIds: ["existing-source"] }));
  expect(saved.setup).toEqual(expect.objectContaining({ responsibilities: ["answer-questions", "customer-support", "bookings", "enquiries"], channels: ["website", "whatsapp"], supportHours: { timeZone: "Africa/Johannesburg", intervals: [{ day: 1, start: "09:00", end: "12:00" }, { day: 1, start: "13:00", end: "17:00" }] }, booking: { durationMinutes: 45, notes: "Weekdays, 9–5" }, intake: { fields: ["name", "email", "message", "phone"] } }));
  expect(requests.some(request => /connections|deployments|booking-policies/.test(request.path))).toBe(false);
});
test("booking-only setup skips knowledge and closing preserves the current step", async ({ page }) => {
  const requests = await fixture(page); let dialog = await start(page);
  await dialog.getByLabel("Business name", { exact: true }).fill("Salon");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByLabel(/Answer questions/).uncheck(); await dialog.getByLabel(/Handle support/).uncheck(); await dialog.getByLabel(/Book appointments/).check();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Where will customers use it?" })).toBeVisible();
  expect(requests.filter(request=>request.path===`${base}/agents`)).toHaveLength(1);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Create agent", exact: true }).filter({ visible: true }).first().click();
  dialog = page.getByRole("dialog", { name: "Create agent", exact: true });
  await expect(dialog.getByRole("heading", { name: "Where will customers use it?" })).toBeVisible();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect(dialog.getByLabel(/Book appointments/)).toBeChecked();
});


test("saved setup resumes after reload through the scoped creation pointer",async({page})=>{
  const requests=await fixture(page);let dialog=await start(page);
  await dialog.getByLabel("Business name",{exact:true}).fill("Salon");
  await dialog.getByRole("button",{name:"Continue",exact:true}).click();
  await dialog.getByLabel(/Answer questions/).uncheck();await dialog.getByLabel(/Handle support/).uncheck();await dialog.getByLabel(/Book appointments/).check();
  await dialog.getByRole("button",{name:"Continue",exact:true}).click();
  await expect(dialog.getByRole("heading",{name:"Where will customers use it?"})).toBeVisible();
  await page.reload();
  await page.getByRole("button",{name:"Create agent",exact:true}).filter({visible:true}).first().click();dialog=page.getByRole("dialog",{name:"Create agent",exact:true});
  await expect(dialog.getByRole("heading",{name:"Where will customers use it?"})).toBeVisible();
  await dialog.getByRole("button",{name:"Back",exact:true}).click();await expect(dialog.getByLabel(/Book appointments/)).toBeChecked();
  expect(requests.filter(request=>request.path===`${base}/agents`)).toHaveLength(1);
  expect(await page.evaluate(()=>sessionStorage.getItem("agent-setup:owner:org"))).toBe("new-agent");
});

test("booking policy is selected in guided setup and saved before review and direct resume",async({page})=>{
  const requests=await fixture(page);let dialog=await start(page);
  await dialog.getByLabel("Business name",{exact:true}).fill("Salon");await dialog.getByRole("button",{name:"Continue",exact:true}).click();
  await dialog.getByLabel(/Answer questions/).uncheck();await dialog.getByLabel(/Handle support/).uncheck();await dialog.getByLabel(/Book appointments/).check();await dialog.getByRole("button",{name:"Continue",exact:true}).click();
  await dialog.getByRole("button",{name:"Continue",exact:true}).click();await dialog.getByLabel("Duration (minutes)").fill("45");await dialog.getByRole("button",{name:"Continue",exact:true}).click();
  await dialog.getByRole("button",{name:"New booking policy",exact:true}).click();
  const policyDialog=page.getByRole("dialog",{name:"New booking policy",exact:true});
  await expect(policyDialog.getByLabel("Duration in minutes")).toHaveValue("45");
  await policyDialog.getByLabel("Booking calendar",{exact:true}).selectOption("calendar");
  await policyDialog.getByRole("button",{name:"Create policy",exact:true}).click();
  await expect(policyDialog).toBeHidden();await expect(dialog.getByRole("combobox",{name:"Booking policy",exact:true})).toHaveValue("policy");
  await dialog.getByRole("button",{name:"Continue",exact:true}).click();
  expect(requests.filter(request=>request.path.endsWith("/configuration")).at(-1)!.body.configuration).toEqual(expect.objectContaining({capabilities:expect.objectContaining({businessActions:{enabled:true,profileId:"calendar-booking-v1",permittedOperations:["calendar.availability","calendar.book"],policyId:"policy",policyDigest:"digest"}})}));
  await page.goto("/app/agents/new-agent?setup=guided");dialog=page.getByRole("dialog",{name:"Create agent",exact:true});await expect(dialog.getByRole("heading",{name:"Review agent",exact:true})).toBeVisible();
  await dialog.getByRole("button",{name:"Back",exact:true}).click();await expect(dialog.getByRole("combobox",{name:"Booking policy",exact:true})).toHaveValue("policy");
  expect(requests.filter(request=>request.path===`${base}/agents`)).toHaveLength(1);
});

test("creation validation visual states in light and dark", async ({ page }) => {
  await fixture(page);
  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    const dialog = await start(page);
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Enter your business name.");
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`creation-error-${theme}-${width}.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
  }
});

test("tablet conditional setup stays usable in both themes", async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/app/agents");
    await page.evaluate(() => sessionStorage.clear());
    const dialog = await start(page);
    const capture = async (step: string) => {
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(15);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(753);
      await page.screenshot({ path: test.info().outputPath(`setup-${step}-${theme}-768.png`), animations: "disabled" });
    };
    await dialog.getByLabel("Business name", { exact: true }).fill("Bicycle shop");
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await dialog.getByLabel(/Book appointments/).check();
    await dialog.getByLabel(/Collect enquiries/).check();
    await capture("responsibilities");
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Business knowledge" })).toBeVisible();
    await capture("knowledge");
    await dialog.getByRole("button", { name: "Skip for now", exact: true }).click();
    await dialog.getByLabel("WhatsApp", { exact: true }).check();
    await capture("channels");
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(dialog.getByLabel("Duration (minutes)")).toBeVisible();
    await setSupportHours(dialog);
    await dialog.getByLabel("Phone", { exact: true }).check();
    await capture("preferences");
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Appointments", exact: true })).toBeVisible();
    await capture("bookings");
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Review agent", exact: true })).toBeVisible();
    await capture("review");
    await page.keyboard.press("Escape");
  }
});
