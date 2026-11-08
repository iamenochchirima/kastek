import { chromium } from "/home/enoch/aworkspace/kasitek-labs/kastek/products/agents/web/node_modules/@playwright/test/index.mjs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Captures the product windows from the Labs landing demos at 2x.
// The landing renders the owner-approved Agents, Growth and Agency scenes; this script
// advances each sequence and saves the settled product window only.
const root = dirname(fileURLToPath(import.meta.url));
const frames = join(root, "frames");
const base = process.env.LABS_URL ?? "http://127.0.0.1:3012";
await mkdir(frames, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 });
await page.goto(base, { waitUntil: "networkidle" });
// The Growth annotation card overlaps the window; the video carries its own captions.
await page.addStyleTag({ content: ".gr-note{display:none !important}" });

for (const [name, selector] of [["agents", "#agents .operation-window"], ["growth", "#growth .gr-window"], ["agency", "#agency .agency-portal"]]) {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const replay = page.locator(`#${name}`).locator("[data-replay]");
  if (await replay.count()) { try { await replay.first().click({ timeout: 1500 }); } catch { /* Sequence may already be at a settled state. */ } }
  await page.waitForTimeout(6000);
  await target.screenshot({ path: join(frames, `${name}-window.png`) });
  console.log(`${name}: ${JSON.stringify(await target.boundingBox())}`);
}

await browser.close();
