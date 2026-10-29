import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { websiteWidgetScript } from "../src/adapters/channels/website/widget";

const { chromium, expect: browserExpect } = createRequire(__filename)("../../web/node_modules/@playwright/test");

describe("website widget conversation switching", () => {
  it("keeps each session, history and pending message separate across reload", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const bySession = new Map<string, { id: string; messages: { authorKind: string; body: string }[] }>();
      let count = 0, failFirstMessage = true;
      await page.route("http://localhost/**", async (route: any) => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname;
        if (path === "/") return route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" });
        if (path.endsWith("/widget.js")) return route.fulfill({ contentType: "application/javascript", body: websiteWidgetScript("fixture") });
        if (path === "/api/website/fixture") return route.fulfill({ json: { name: "Assistant", appearance: {} } });
        if (path.endsWith("/session")) { const token = `session-${++count}`; bySession.set(token, { id: `conversation-${count}`, messages: [] }); return route.fulfill({ json: { token } }); }
        const token = (request.headers().authorization ?? "").replace("Bearer ", ""), chat = bySession.get(token);
        if (!chat) return route.fulfill({ status: 403, json: { error: { message: "Session expired" } } });
        if (path.endsWith("/customer-conversations")) return route.fulfill({ json: { conversation: { id: chat.id } } });
        if (path !== `/api/website/fixture/customer-conversations/${chat.id}/messages`) return route.fulfill({ status: 403, json: { error: { message: "Wrong session" } } });
        if (request.method() === "POST") {
          if (failFirstMessage) { failFirstMessage = false; return route.fulfill({ status: 503, json: { error: { message: "Unavailable" } } }); }
          chat.messages.push({ authorKind: "visitor", body: request.postDataJSON().body });
          return route.fulfill({ json: {} });
        }
        return route.fulfill({ json: { conversation: { state: "automation_active" }, messages: chat.messages } });
      });
      await page.goto("http://localhost/");
      await page.addScriptTag({ url: "http://localhost/api/website/fixture/widget.js" });
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("First pending");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await browserExpect(page.getByRole("button", { name: "Retry message" })).toBeVisible();
      await page.getByRole("button", { name: "New conversation" }).click();
      await browserExpect(page.getByRole("combobox", { name: "Conversations" })).toBeVisible();
      await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("Second message");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await browserExpect(page.getByRole("log").getByText("Second message")).toBeVisible();
      const selector = page.getByRole("combobox", { name: "Conversations" });
      await browserExpect(selector).toBeEnabled();
      await selector.selectOption({ label: "Conversation 1" });
      await browserExpect(page.getByRole("button", { name: "Retry message" })).toBeVisible();
      await browserExpect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("First pending");
      await page.getByRole("button", { name: "Retry message" }).click();
      await browserExpect(page.getByRole("log").getByText("First pending")).toBeVisible();
      await page.reload();
      await page.addScriptTag({ url: "http://localhost/api/website/fixture/widget.js" });
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await browserExpect(page.getByRole("log").getByText("First pending")).toBeVisible();
      expect(bySession.size).toBe(2);
      expect([...bySession.values()].map(chat => chat.messages.map(message => message.body))).toEqual([["First pending"], ["Second message"]]);
      const afterReload = page.getByRole("combobox", { name: "Conversations" });
      await browserExpect(afterReload).toBeEnabled();
      await afterReload.selectOption({ label: "Conversation 2" });
      await browserExpect(page.getByRole("log").getByText("Second message")).toBeVisible();
      bySession.delete("session-1");
      await browserExpect(afterReload).toBeEnabled();
      await afterReload.selectOption({ label: "Conversation 1" });
      await browserExpect(page.getByRole("status")).toHaveText("Session expired");
      await browserExpect(page.getByRole("log").getByText("Second message")).toHaveCount(0);
      await browserExpect(page.getByRole("button", { name: "New conversation" })).toBeEnabled();
      await page.getByRole("button", { name: "New conversation" }).click();
      await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      expect(count).toBe(3);
    } finally { await browser.close(); }
  }, 30_000);
});
