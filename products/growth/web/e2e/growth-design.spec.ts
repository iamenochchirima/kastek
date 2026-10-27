import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const layoutExpect = expect.configure({ soft: true });
const proofDirectory = fileURLToPath(new URL("../../../../.audit/growth-redesign/cross-page/", import.meta.url));
const pages = [
  { name: "overview", path: "/workspace", heading: "Overview" },
  { name: "connections", path: "/connections", heading: "Connections" },
  { name: "inbox", path: "/inbox?conversation=fixture-inbox", heading: "Inbox" },
  { name: "agents", path: "/agents", heading: "Agents" },
  { name: "contacts", path: "/contacts", heading: "Contacts" },
  { name: "posts", path: "/content", heading: "Posts" },
] as const;

async function expectLoaded(page: Page, name: typeof pages[number]["name"]) {
  if (name === "overview") await expect(page.getByRole("img", { name: "Messages received trend", exact: true })).toBeVisible();
  if (name === "connections") await expect(page.getByRole("heading", { name: "Connected accounts", exact: true })).toBeVisible();
  if (name === "inbox") await expect(page.getByRole("textbox", { name: "Reply message", exact: true })).toBeVisible();
  if (name === "agents") await expect(page.getByRole("region", { name: "Your agents", exact: true })).toBeVisible();
  if (name === "contacts") await expect(page.getByRole("button", { name: "View contact Fixture contact", exact: true })).toBeVisible();
  if (name === "posts") await expect(page.getByRole("heading", { name: "No posts yet", exact: true })).toBeVisible();
}

for (const scenario of [
  { width: 1440, height: 1000, theme: "light" },
  { width: 1440, height: 1000, theme: "dark" },
  { width: 768, height: 1000, theme: "light" },
  { width: 360, height: 844, theme: "dark" },
] as const) {
  test(`six-page layout at ${scenario.width}px in ${scenario.theme}`, async ({ page, context }) => {
    await mkdir(proofDirectory, { recursive: true });
    await context.addCookies([{ name: "kasitek_active_org", value: "growth-fixture-one", domain: "127.0.0.1", path: "/" }]);
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.emulateMedia({ colorScheme: scenario.theme, reducedMotion: "reduce" });
    await page.addInitScript((theme) => localStorage.setItem("kasitek-theme", theme), scenario.theme);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const entry of pages) await test.step(entry.name, async () => {
      await page.goto(entry.path);
      await expect(page.getByRole("heading", { name: entry.heading, exact: true }).first()).toBeVisible();
      await expectLoaded(page, entry.name);
      await expect(page.locator("html")).toHaveAttribute("data-theme", scenario.theme);
      await expect(page.getByRole("heading", { name: /^(Unable to load workspace|Page not found|Unexpected Application Error!)$/ })).toHaveCount(0);
      await expect(page.getByText("Unexpected Application Error!", { exact: true })).toHaveCount(0);
      await layoutExpect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth), { message: `${entry.name} must contain overflow inside its labelled table regions` }).toBeLessThanOrEqual(1);
      expect(errors, `${entry.name} browser runtime errors`).toEqual([]);
      await page.screenshot({ path: `${proofDirectory}/${entry.name}-${scenario.width}-${scenario.theme}.png`, fullPage: true, animations: "disabled" });
    });
  });
}

test("keeps operational overview data available while analytics loads or fails", async ({ page }) => {
  await mkdir(proofDirectory, { recursive: true });
  let release!: () => void;
  const analyticsGate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/workspace/summary", async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    await route.fulfill({ response, json: { ...result, summary: { ...result.summary, attention: { unreadConversations: 2, socialAttention: 3, connectionAttention: 1, campaignFailures: 0 } } } });
  });
  await page.route("**/api/analytics/query", async (route) => {
    await analyticsGate;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Reporting temporarily unavailable" }) });
  });
  await page.goto("/workspace");
  try {
    await expect(page.getByRole("heading", { name: "Needs attention", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent campaigns", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Active campaigns", exact: false })).toBeVisible();
    const postsAttention = page.getByText("Posts needing attention", { exact: true }).locator("..");
    await expect(postsAttention.getByRole("link", { name: "Review", exact: true })).toHaveAttribute("href", "/content");
    await page.screenshot({ path: `${proofDirectory}/overview-analytics-loading.png`, fullPage: true, animations: "disabled" });
  } finally { release(); }
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs attention", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent campaigns", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Active campaigns", exact: false })).toBeVisible();
  await page.screenshot({ path: `${proofDirectory}/overview-analytics-failed.png`, fullPage: true, animations: "disabled" });
});


test("captures six pages at their native reference dimensions", async ({ page, context }) => {
  const nativeDirectory = fileURLToPath(new URL("../../../../.audit/growth-redesign/native/", import.meta.url));
  await mkdir(nativeDirectory, { recursive: true });
  await context.addCookies([{ name: "kasitek_active_org", value: "growth-fixture-one", domain: "127.0.0.1", path: "/" }]);
  await page.addInitScript(() => localStorage.setItem("kasitek-theme", "light"));
  const references = ["overview-light-v2.png", "connections-light-v2.png", "inbox-overview-light-v1.png", "agents-light-v2.png", "contacts-light-v1.png", "content-light-v1.png"];
  const measurements: Array<{ page: string; reference: string; viewport: { width: number; height: number }; rendered: unknown }> = [];
  for (const [index, entry] of pages.entries()) await test.step(entry.name, async () => {
    const reference = references[index];
    const png = await readFile(new URL(`../../design/interface-concepts/${reference}`, import.meta.url));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const viewport = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    await page.setViewportSize(viewport);
    await page.goto(entry.name === "inbox" ? "/inbox" : entry.path);
    await expect(page.getByRole("heading", { name: entry.heading, exact: true }).first()).toBeVisible();
    if (entry.name === "inbox") await expect(page.getByRole("button", { name: /^Fixture customer/ }).first()).toBeVisible();
    else await expectLoaded(page, entry.name);
    if (entry.name === "agents") {
      await page.getByRole("button", { name: "Open Growth assistant", exact: true }).click();
      await expect(page.getByRole("region", { name: "Agent conversation", exact: true })).toBeVisible();
    }
    if (entry.name === "contacts") {
      await page.getByRole("button", { name: "View contact Fixture contact", exact: true }).click();
      await expect(page.getByRole("complementary", { name: "Contact details", exact: true })).toBeVisible();
    }
    await page.screenshot({ path: `${nativeDirectory}/${entry.name}-native-light.png`, animations: "disabled", fullPage: false });
    const rendered = await page.evaluate(() => {
      const visible = (element: Element) => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
      const main = document.querySelector("main");
      const measure = (element: Element | null) => {
        if (!element) return null;
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y, font: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, radius: style.borderRadius, padding: style.padding, border: style.borderWidth, color: style.color, background: style.backgroundColor };
      };
      return {
        pageHeading: measure(main?.querySelector("h1") ?? null),
        sidebar: measure([...document.querySelectorAll("aside")].find(visible) ?? null),
        topbar: measure([...document.querySelectorAll("header")].find(visible) ?? null),
        firstAction: measure([...main?.querySelectorAll("button") ?? []].find(visible) ?? null),
        firstColumnHeading: measure(main?.querySelector("th") ?? null),
        firstDataRow: measure(main?.querySelector("tbody tr") ?? null),
        firstInterfaceIcon: measure([...main?.querySelectorAll("svg") ?? []].find(visible) ?? null),
      };
    });
    measurements.push({ page: entry.name, reference, viewport, rendered });
  });
  await writeFile(`${nativeDirectory}/measurements.json`, JSON.stringify(measurements, null, 2));
});
