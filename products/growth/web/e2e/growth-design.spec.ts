import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const proofDirectory = fileURLToPath(new URL("../../../.audit/growth-redesign/cross-page/", import.meta.url));
const pages = [
  { name: "overview", path: "/workspace", heading: "Overview" },
  { name: "connections", path: "/connections", heading: "Connections" },
  { name: "inbox", path: "/inbox?conversation=fixture-inbox", heading: "Inbox" },
  { name: "agents", path: "/agents", heading: "Agents" },
  { name: "contacts", path: "/contacts", heading: "Contacts" },
  { name: "posts", path: "/content", heading: "Posts" },
] as const;

async function expectLoaded(page: Page, name: typeof pages[number]["name"]) {
  if (name === "overview") await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  if (name === "connections") await expect(page.getByRole("region", { name: "Connected accounts", exact: true })).toBeVisible();
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
      await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth), { message: `${entry.name} must contain overflow inside its labelled table regions` }).toBeLessThanOrEqual(1);
      expect(errors, `${entry.name} browser runtime errors`).toEqual([]);
      await page.screenshot({ path: `${proofDirectory}/${entry.name}-${scenario.width}-${scenario.theme}.png`, fullPage: true, animations: "disabled" });
    });
  });
}
