import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

/** Reopens the real fixture account in an empty browser context; it never admits another task. */
export async function verifyWorkspaceBrowserAcceptance(options: {
  pool: Pool; origin: string; token: string; browserModule: string; evidenceDirectory: string;
}) {
  const rows = (await options.pool.query(`SELECT t.id,v.agent_id,t.conversation_id,t.version_id,t.input,
    a.name AS agent_name,v.number AS version_number FROM agents_platform.tasks t
    JOIN agents_platform.agent_versions v ON v.id=t.version_id JOIN agents_platform.agents a ON a.id=v.agent_id
    WHERE t.parent_task_id IS NULL ORDER BY t.created_at,t.id`)).rows;
  assert.equal(rows.length, 3);
  const first = rows[0];
  assert.ok(first && first.input.includes("ORCHID-17"));
  assert.equal(rows[1].version_id, first.version_id);
  assert.notEqual(rows[2].version_id, first.version_id);
  const { chromium } = require(options.browserModule);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: "agents_session", value: options.token, url: options.origin, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    let admissions = 0;
    page.on("request", (request: { method(): string; url(): string }) => { if (request.method() === "POST" && /\/tasks$/u.test(new URL(request.url()).pathname)) admissions++; });
    await page.goto(`${options.origin}/app/agents/${first.agent_id}`);
    const history = page.getByRole("navigation", { name: "Conversation history", exact: true });
    const original = history.getByRole("link").filter({ hasText: "My project code is ORCHID-17. Acknowledge it." });
    await original.waitFor({ state: "visible" });
    assert.equal(await history.getByRole("link").count(), 2);
    await original.click();
    const canonical = `/app/agents/${first.agent_id}/conversations/${first.conversation_id}`;
    await page.waitForURL(`${options.origin}${canonical}`);
    await page.getByRole("article", { name: "Turn 2", exact: true }).getByText("What is my project code? Use our earlier conversation.", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.getByRole("combobox", { name: "Version", exact: true }).inputValue(), first.version_id);
    assert.equal(await page.getByRole("combobox", { name: "Version", exact: true }).isDisabled(), true);
    await page.evaluate(() => { sessionStorage.clear(); localStorage.clear(); });
    await page.reload();
    await page.getByRole("article", { name: "Turn 2", exact: true }).getByText("What is my project code? Use our earlier conversation.", { exact: true }).waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).pathname, canonical);
    assert.equal(await page.getByRole("combobox", { name: "Version", exact: true }).inputValue(), first.version_id);
    await page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: "Tasks", exact: true }).click();
    await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("combobox", { name: "Filter by agent", exact: true }).selectOption(first.agent_id);
    await page.getByRole("combobox", { name: "Filter by status", exact: true }).selectOption("completed");
    await page.waitForFunction(() => document.querySelectorAll(".task-list-row").length === 3);
    const taskLinks = await page.locator(".task-list-row > div > a").evaluateAll((links: Element[]) => links.map(link => link.getAttribute("href")));
    assert.deepEqual(taskLinks.sort(), rows.map(row => `/app/tasks/${row.id}`).sort());
    await page.locator(`.task-list-row a[href="${canonical}"]`).first().click();
    await page.waitForURL(`${options.origin}${canonical}`);
    await page.getByRole("article", { name: "Turn 2", exact: true }).getByText("What is my project code? Use our earlier conversation.", { exact: true }).waitFor({ state: "visible" });
    await mkdir(options.evidenceDirectory, { recursive: true });
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Conversation overflow at ${width}px`);
      await page.screenshot({ path: join(options.evidenceDirectory, `live-chat-history-${width}.png`), fullPage: true });
    }
    assert.equal(admissions, 0);
    const proof = { status: "passed", transport: "actual isolated API/PostgreSQL/browser", freshBrowserContext: true,
      storageClearedReload: true, authorizedInputsRestored: true, oldAndNewVersionIsolation: true, serverConversations: 2, filteredCompletedTasks: rows.length, restoredVersion: first.version_id,
      conversationId: first.conversation_id, taskIds: rows.map(row => row.id), additionalAdmissions: admissions, widths: [1440, 768, 390] };
    await writeFile(join(options.evidenceDirectory, "live-chat-history-proof.json"), JSON.stringify(proof, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ evidence: "actual server history, pinned version, empty browser storage, task filters and conversation deep links", ...proof }));
    await context.close();
  } finally { await browser.close(); }
}
