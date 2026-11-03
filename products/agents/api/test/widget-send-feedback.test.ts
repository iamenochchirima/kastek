import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { websiteWidgetScript } from "../src/adapters/channels/website/widget";

const { chromium, expect: browserExpect } = createRequire(__filename)("../../web/node_modules/@playwright/test");

async function fixture(initialFailure?: { status: number; code: string; message: string }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const messages: { authorKind: string; body: string }[] = [], submitted: { requestKey: string; body: string }[] = [];
  let failure = initialFailure, reads = 0, failNextRead = false;
  await page.clock.install();
  await page.route("http://localhost/**", async (route: any) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" });
    if (path.endsWith("/widget.js")) return route.fulfill({ contentType: "application/javascript", body: websiteWidgetScript("fixture") });
    if (path === "/api/website/fixture") return route.fulfill({ json: { name: "Assistant", appearance: { greeting: "How can we help?" } } });
    if (path.endsWith("/session")) return route.fulfill({ json: { token: "visitor-session" } });
    if (path.endsWith("/customer-conversations")) return route.fulfill({ json: { conversation: { id: "conversation" } } });
    if (path.endsWith("/messages")) {
      if (request.method() === "POST") {
        submitted.push(request.postDataJSON());
        if (failure) return route.fulfill({ status: failure.status, json: { error: { code: failure.code, message: failure.message } } });
        messages.push({ authorKind: "visitor", body: request.postDataJSON().body }, { authorKind: "assistant", body: "Hello!" });
        return route.fulfill({ json: {} });
      }
      reads++;
      if (failNextRead) { failNextRead = false; return route.fulfill({ status: 503, json: { error: { message: "History temporarily unavailable" } } }); }
      return route.fulfill({ json: { conversation: { state: "automation_active" }, messages } });
    }
    throw new Error(`Unexpected widget request: ${path}`);
  });
  async function open(pending = false) {
    await page.addScriptTag({ url: "http://localhost/api/website/fixture/widget.js" });
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    if (pending) await browserExpect(page.getByRole("button", { name: "Retry message", exact: true })).toBeVisible();
    else await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  }
  await page.goto("http://localhost/");
  await open();
  return { browser, page, submitted, open, reads: () => reads, recover: () => { failure = undefined; }, rejectNextRead: () => { failNextRead = true; } };
}

describe("website widget send feedback", () => {
  it("does not offer to resend an accepted message when the following history read fails", async () => {
    const context = await fixture();
    const { browser, page } = context;
    try {
      context.rejectNextRead();
      const input = page.getByRole("textbox", { name: "Message", exact: true });
      await input.fill("Already sent");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await browserExpect(page.getByRole("status")).toHaveText("History temporarily unavailable");
      await browserExpect(page.getByRole("alert")).toBeHidden();
      await browserExpect(page.getByRole("button", { name: "Retry message", exact: true })).toBeHidden();
      await browserExpect(input).toHaveValue("");
      const before = context.reads();
      await page.clock.runFor(1_500);
      await browserExpect.poll(context.reads).toBeGreaterThan(before);
      await browserExpect(page.getByRole("button", { name: "New conversation", exact: true })).toBeEnabled();
      await browserExpect(page.getByRole("log")).toContainText("Already sent");
      await browserExpect(page.getByRole("alert")).toBeHidden();
      expect(context.submitted).toHaveLength(1);
    } finally { await browser.close(); }
  }, 20_000);

  it("keeps a rejected send error visible after successful message polling", async () => {
    const context = await fixture({ status: 429, code: "RATE_LIMITED", message: "Too many requests. Try again shortly" });
    const { browser, page } = context;
    try {
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep my message");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const failure = page.getByText("Too many requests. Try again shortly", { exact: true });
      await browserExpect(failure).toBeVisible();
      const before = context.reads();
      await page.clock.runFor(4_500);
      await browserExpect.poll(context.reads).toBeGreaterThan(before);
      await browserExpect(page.getByRole("button", { name: "New conversation", exact: true })).toBeEnabled();
      await browserExpect(failure).toBeVisible();
      await browserExpect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep my message");
    } finally { await browser.close(); }
  }, 20_000);

  it.each(["MODEL_DEFAULT_REQUIRED", "MODEL_CONNECTION_UNAVAILABLE"])("keeps %s failures visible and editable across polling and reload, then clears them after retry", async code => {
    const context = await fixture({ status: 409, code, message: "Choose a default model in Model providers" });
    const { browser, page } = context;
    try {
      const input = page.getByRole("textbox", { name: "Message", exact: true });
      const failure = page.getByRole("alert");
      await input.fill("Hello");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await browserExpect(failure).toHaveText("Chat is temporarily unavailable. Please try again later.");
      await browserExpect(input).toBeEnabled();
      await browserExpect(input).toHaveValue("Hello");
      if (code === "MODEL_DEFAULT_REQUIRED") {
        await browserExpect(page.getByText("Choose a default model in Model providers", { exact: true })).toHaveCount(0);
        for (const [name, width, height] of [["desktop", 1280, 900], ["tablet", 768, 1024], ["mobile", 390, 844]] as const) {
          await page.setViewportSize({ width, height });
          await browserExpect(failure).toBeInViewport();
          await browserExpect(input).toBeInViewport();
          const box = await failure.boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          if (process.env.AGENTS_WIDGET_SCREENSHOTS) await page.screenshot({ path: `/tmp/kasitek-widget-send-feedback-${name}.png` });
        }
      }
      const before = context.reads();
      await page.clock.runFor(4_500);
      await browserExpect.poll(context.reads).toBeGreaterThan(before);
      await browserExpect(page.getByRole("button", { name: "New conversation", exact: true })).toBeEnabled();
      await browserExpect(failure).toHaveText("Chat is temporarily unavailable. Please try again later.");
      await input.fill("Hello again");
      await page.reload();
      await context.open();
      await browserExpect(input).toHaveValue("Hello again");
      await browserExpect(failure).toHaveText("Chat is temporarily unavailable. Please try again later.");
      context.recover();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await browserExpect(page.getByRole("log")).toContainText("Hello again");
      await browserExpect(page.getByRole("log")).toContainText("Hello!");
      await browserExpect(failure).toBeHidden();
      await browserExpect(input).toHaveValue("");
      expect(context.submitted.map(message => message.body)).toEqual(["Hello", "Hello again"]);
      expect(context.submitted[0]!.requestKey).not.toBe(context.submitted[1]!.requestKey);
    } finally { await browser.close(); }
  }, 20_000);

  it("keeps an uncertain send pending with its original request key until a successful retry", async () => {
    const context = await fixture({ status: 503, code: "UNAVAILABLE", message: "Service unavailable" });
    const { browser, page } = context;
    try {
      const input = page.getByRole("textbox", { name: "Message", exact: true });
      await input.fill("Hello once");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await browserExpect(page.getByRole("alert")).toHaveText("Service unavailable");
      await browserExpect(input).toBeDisabled();
      const before = context.reads();
      await page.clock.runFor(4_500);
      await browserExpect.poll(context.reads).toBeGreaterThan(before);
      await browserExpect(page.getByRole("button", { name: "New conversation", exact: true })).toBeEnabled();
      await browserExpect(page.getByRole("alert")).toHaveText("Service unavailable");
      await page.reload();
      await context.open(true);
      await browserExpect(input).toHaveValue("Hello once");
      await browserExpect(page.getByRole("alert")).toHaveText("Service unavailable");
      context.recover();
      await page.getByRole("button", { name: "Retry message", exact: true }).click();
      await browserExpect(page.getByRole("log")).toContainText("Hello once");
      await browserExpect(page.getByRole("alert")).toBeHidden();
      expect(context.submitted).toHaveLength(2);
      expect(context.submitted[0]).toEqual(context.submitted[1]);
    } finally { await browser.close(); }
  }, 20_000);
});
