import { test, expect, type Page } from "@playwright/test";
async function fixture(page: Page) {
  const writes: Record<string, unknown>[] = [];
  let reject = true;
  let settings = { appearance: { accent: "#3730a3", title: "Support", greeting: "How can I help?", launcherLabel: "Chat", position: "bottom-right", quickReplies: ["Opening hours"] }, deploymentId: "website", appearanceDigest: "appearance-1", paused: false, allowedOrigins: ["https://example.com"] };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test" }, organizations: [{ id: "org", name: "Workspace", role: "owner" }] };
    else if (path.endsWith("/channels/catalogue")) data = { channels: [{ kind: "website", name: "Website", assetLabel: "Website", modes: [{ id: "website", available: true }], restrictions: [] }] };
    else if (path.endsWith("/channels")) data = { connections: [], deployments: [], websites: [] };
    else if (path.endsWith("/agents/summaries")) data = { agents: [{ id: "agent", name: "Support" }], nextCursor: null };
    else if (path.endsWith("/agents/agent")) data = { deployments: [{ id: "website", allowedOrigins: ["https://example.com"] }] };
    else if (path.endsWith("/deployments/website/appearance")) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON(); writes.push(body);
        if (reject) { reject = false; await route.fulfill({ status: 409, json: { error: { message: "Try saving again" } } }); return; }
        expect(body.expectedAppearanceDigest).toBe(settings.appearanceDigest);
        settings = { ...settings, appearance: body.appearance, appearanceDigest: "appearance-2" };
      }
      data = settings;
    } else if (path.endsWith("/supported-connections/catalogue")) data = { providers: [] };
    else if (path.endsWith("/connections")) data = { connections: [], profiles: [], targets: [] };
    else if (path.endsWith("/api-connections") || path.endsWith("/remote-connections")) data = { connections: [] };
    else { await route.fulfill({ status: 404, json: { error: { message: "Unexpected fixture request" } } }); return; }
    await route.fulfill({ json: data });
  });
  await page.goto("/app/connections");
  await page.getByRole("region", { name: "Customer channels" }).getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByLabel("Serving agent").selectOption("agent");
  await page.getByRole("button", { name: "Customize widget" }).click();
  return writes;
}
for (const width of [1440, 768, 390]) test(`widget appearance preserves input and saves geometry at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const writes = await fixture(page);
  const dialog = page.getByRole("dialog", { name: "Widget appearance", exact: true });
  await expect(dialog).toBeVisible();
  if (width === 768) {
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(15);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 15);
  }
  await dialog.getByLabel("Chat title", { exact: true }).fill("Welcome team");
  await dialog.getByLabel("Window width (px)").fill("600");
  await dialog.getByLabel("Window height (px)").fill("800");
  await dialog.getByLabel("Corner radius (px)").fill("24");
  await dialog.getByLabel("Launcher size (px)").fill("72");
  await dialog.getByLabel("Screen offset (px)").fill("32");
  await dialog.getByRole("button", { name: "Emerald", exact: true }).click();
  await dialog.getByLabel("Position", { exact: true }).selectOption("bottom-left");
  await dialog.getByLabel("Show KasiTek branding", { exact: true }).uncheck();
  await dialog.getByLabel("Suggested messages", { exact: true }).fill("Opening hours\nBook a visit");
  const preview = dialog.getByRole("region", { name: "Widget preview" });
  await expect(preview).toContainText("Welcome team"); await expect(preview).toContainText("Book a visit");
  await expect(preview).not.toContainText("Powered by KasiTek");
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`appearance-${width}.png`), fullPage: true });
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Try saving again");
  await expect(dialog.getByLabel("Chat title", { exact: true })).toHaveValue("Welcome team");
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes[1]).toMatchObject({ expectedAppearanceDigest: "appearance-1", paused: false, appearance: { title: "Welcome team", accent: "#059669", position: "bottom-left", windowWidth: 600, windowHeight: 800, borderRadius: 24, launcherSize: 72, launcherOffset: 32, showBranding: false, avatarUrl: "", quickReplies: ["Opening hours", "Book a visit"] } });
  await page.getByRole("button", { name: "Customize widget" }).click();
  await expect(dialog.getByLabel("Chat title", { exact: true })).toHaveValue("Welcome team");
  await dialog.getByLabel("Chat title", { exact: true }).fill("Discard this");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Customize widget" }).click();
  await expect(dialog.getByLabel("Chat title", { exact: true })).toHaveValue("Welcome team");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Connect Website", exact: true })).toBeVisible();
  expect(writes).toHaveLength(2); expect(errors).toEqual([]);
});
