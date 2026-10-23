import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface GrowthBrowserOptions {
  growthOrigin: string;
  tenantId: string;
  userId: string;
  configureFrontend(origin: string): Promise<void>;
  dispatch(): Promise<void>;
}
async function until(check: () => Promise<boolean>, label: string, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Growth browser timed out: ${label}`);
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
    child.kill("SIGTERM");
  });
}
/** Controlled identity and model boundaries; actual Next UI, Growth BFF and durable execution. */
export async function verifyGrowthBrowser(options: GrowthBrowserOptions) {
  const root = resolve(__dirname, "../../../../.."), web = resolve(root, "products/growth/web");
  const artifacts = resolve(root, ".audit/growth-agent-real-browser");
  const { chromium, expect } = createRequire(__filename)(resolve(root, "products/growth/web/node_modules/@playwright/test"));
  const upstream = new URL(options.growthOrigin);
  assert.ok(upstream.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname));
  await access(resolve(web, ".next/BUILD_ID"));
  const reserve = createServer();
  await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  await options.configureFrontend(origin);
  let frontend: ChildProcess | undefined, browser: any, page: any;
  const taskIds: string[] = [], failures: string[] = [];
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(AGENTS_|GROWTH_|CORE_|DATABASE_URL|OPENROUTER_|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
    Object.assign(env, { NODE_ENV: "production", CORE_API_BASE_URL: upstream.origin, GROWTH_WEB_ORIGIN: origin, NEXT_TELEMETRY_DISABLED: "1" });
    frontend = spawn(process.execPath, [resolve(web, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: web, env, stdio: "ignore" });
    await until(async () => {
      if (frontend!.exitCode !== null) throw Error("Growth frontend exited before readiness");
      try { return (await fetch(origin + "/agents", { redirect: "manual" })).status === 200; } catch { return false; }
    }, "built frontend readiness");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    await context.addCookies([{ name: "kasitek_active_org", value: options.tenantId, url: origin }]);
    page = await context.newPage();
    page.on("pageerror", (error: Error) => failures.push(error.message));
    await page.goto(origin + "/agents");
    await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
    const bootstrap = await (await context.request.get(origin + "/api/agents/bootstrap")).json();
    assert.equal(bootstrap.scope.businessId, options.tenantId);
    assert.equal(bootstrap.scope.userId, options.userId);
    assert.ok(bootstrap.features.find((feature: { id: string; ready: boolean }) => feature.id === "assistant")?.ready);
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    const createdResponse = page.waitForResponse((response: any) => new URL(response.url()).pathname === "/api/agents/conversations" && response.request().method() === "POST");
    await page.getByRole("dialog").getByRole("button", { name: /^Growth assistant/ }).click();
    const created = await createdResponse;
    assert.equal(created.status(), 201);
    const conversationId = (await created.json()).conversation.id as string;
    let chat = page.getByRole("region", { name: "Agent conversation" });
    await expect(chat).toBeVisible();
    await chat.getByRole("button", { name: "Close assistant", exact: true }).click();
    await page.getByRole("button", { name: "Open Growth assistant", exact: true }).click();
    await expect(chat.getByRole("textbox", { name: "Message agent", exact: true })).toBeEnabled();
    async function send(text: string) {
      const acceptedResponse = page.waitForResponse((response: any) => new URL(response.url()).pathname === `/api/agents/conversations/${conversationId}/messages` && response.request().method() === "POST");
      await chat.getByRole("textbox", { name: "Message agent", exact: true }).fill(text);
      await chat.getByRole("button", { name: "Send message", exact: true }).click();
      const response = await acceptedResponse;
      assert.ok(response.status() === 202 || response.status() === 200);
      const accepted = await response.json();
      assert.equal(accepted.task.conversationId, conversationId);
      taskIds.push(accepted.task.id);
      let output = "";
      await until(async () => {
        await options.dispatch();
        const status = await context.request.get(origin + "/api/agents/tasks/" + encodeURIComponent(accepted.task.id));
        assert.equal(status.status(), 200);
        const { task } = await status.json();
        if (["failed", "refused", "cancelled", "incomplete", "uncertain"].includes(task.state)) throw Error(`Growth browser task ended ${task.state}: ${task.errorCode ?? "unknown"}`);
        output = task.output ?? "";
        return task.state === "completed" && output.length > 0;
      }, "actual shared-worker completion");
      const visibleOutput = output.replace(/\[E[0-9a-f]{32}\]/gi, "").replace(/\s+/g, " ").trim();
      assert.ok(visibleOutput.length > 0);
      await expect.poll(async () => (await chat.locator("article").allTextContents()).some((text: string) =>
        text.replace(/\[\d+\]/g, "").replace(/\s+/g, " ").includes(visibleOutput)), { timeout: 10000 }).toBe(true);
      return output;
    }
    const first = "Review my business through the Growth assistant";
    await send(first);
    await send("What should I do next?");
    assert.equal(new Set(taskIds).size, 2);
    await chat.getByRole("link", { name: "Expand conversation", exact: true }).click();
    await expect(page).toHaveURL(origin + "/agents/conversations/" + conversationId);
    await page.reload();
    chat = page.getByRole("region", { name: "Agent conversation" });
    await expect(chat.locator("article").getByText(first, { exact: true })).toBeVisible();
    await expect(chat.locator("article").getByText("What should I do next?", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Agents", exact: true }).last().click();
    await page.getByRole("tab", { name: "Conversations", exact: true }).click();
    await page.getByRole("textbox", { name: "Search conversations", exact: true }).fill(first);
    await page.getByRole("link", { name: new RegExp(first) }).click();
    await expect(page).toHaveURL(origin + "/agents/conversations/" + conversationId);
    await expect(page.getByRole("region", { name: "Agent conversation" }).locator("article").getByText("What should I do next?", { exact: true })).toBeVisible();
    assert.deepEqual(failures, []);
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: resolve(artifacts, "conversation.png"), fullPage: true });
    await writeFile(resolve(artifacts, "acceptance.json"), JSON.stringify({ mode: "controlled_identity_and_provider_actual_ui_bff_worker", conversationId, taskIds, checks: ["configured_readiness", "create", "quick_access_resume", "actual_model_reply", "follow_up", "expand", "reload", "history_reopen"], errors: failures }, null, 2));
    return { conversationId, taskIds, artifacts };
  } catch (error) {
    await mkdir(artifacts, { recursive: true });
    if (page && !page.isClosed()) await page.screenshot({ path: resolve(artifacts, "failure.png"), fullPage: true }).catch(() => undefined);
    throw error;
  } finally {
    await browser?.close();
    await stop(frontend);
    await options.configureFrontend(upstream.origin);
  }
}
