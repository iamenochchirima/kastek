import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { websiteWidgetScript } from "../src/adapters/channels/website/widget";

const { chromium } = createRequire(__filename)("../../web/node_modules/@playwright/test");

describe("website widget presentation", () => {
  it("uses the same outline launcher icon as the editor preview", () => {
    const script = websiteWidgetScript("fixture");
    expect(script).toContain('launcher:\'<path d="M2.992 16.342');
    expect(script).toContain("icon(toggle,'launcher')");
  });

  it("paints the saved accent before the deployment info arrives", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("http://localhost/**", async (route: any) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" });
        if (url.pathname.endsWith("/widget.js")) {
          return route.fulfill({
            contentType: "application/javascript",
            body: websiteWidgetScript("fixture", { accent: "#8b1a1a", theme: "light", launcherSize: 72 }),
          });
        }
        if (url.pathname === "/api/website/fixture") {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          return route.fulfill({ json: { name: "Assistant", appearance: { accent: "#8b1a1a" } } });
        }
        return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
      });
      await page.goto("http://localhost/");
      await page.addScriptTag({ url: "http://localhost/api/website/fixture/widget.js" });
      const launcher = page.getByRole("button", { name: "Chat", exact: true });
      await launcher.waitFor();
      const background = await launcher.evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(background).toBe("rgb(139, 26, 26)");
    } finally {
      await browser.close();
    }
  });

  it("reports an exhausted daily allowance clearly", () => {
    expect(websiteWidgetScript("fixture")).toContain("Daily usage limit reached. Please try again tomorrow.");
  });

  it("renders a flat accent launcher without a border or halo", () => {
    const script = websiteWidgetScript("fixture");
    expect(script).toContain(".launcher{display:grid;place-items:center;width:var(--launcher-size,56px);height:var(--launcher-size,56px);border-radius:50%");
    expect(script).not.toContain("0 0 0 5px color-mix");
    expect(script).not.toContain("border:1px solid #ffffffb8");
  });
});
