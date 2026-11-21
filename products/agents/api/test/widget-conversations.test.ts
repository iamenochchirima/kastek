import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { websiteWidgetScript } from "../src/adapters/channels/website/widget";

const { chromium, expect: browserExpect } = createRequire(__filename)("../../web/node_modules/@playwright/test");

describe("website widget active conversation", () => {
  it("keeps one active chat across reload and starts a fresh chat when the previous one resolved or expired", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const bySession = new Map<string, { id: string; messages: { authorKind: string; body: string; displayKind?: string }[] }>();
      let count = 0, failFirstMessage = true, resolveChat1 = false;
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
          return route.fulfill({ json: { message: { id: `m-${chat.messages.length}` } } });
        }
        if (resolveChat1 && chat.id === "conversation-1") return route.fulfill({ json: { conversation: { id: chat.id, state: "resolved" }, messages: chat.messages } });
        return route.fulfill({ json: { conversation: { id: chat.id, state: "automation_active" }, messages: chat.messages } });
      });
      await page.goto("http://localhost/");
      await page.addScriptTag({ url: "http://localhost/api/website/fixture/widget.js" });
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await browserExpect(page.getByRole("button", { name: "New conversation" })).toHaveCount(0);
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("First pending");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await browserExpect(page.getByRole("button", { name: "Retry message" })).toBeVisible();
      await page.getByRole("button", { name: "Retry message" }).click();
      await browserExpect(page.getByRole("log").getByText("First pending").first()).toBeVisible();
      await page.reload();
      await page.addScriptTag({ url: "http://localhost/api/website/fixture/widget.js" });
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await browserExpect(page.getByRole("log").getByText("First pending").first()).toBeVisible();
      await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      expect(count).toBe(1);
      resolveChat1 = true;
      await page.reload();
      await page.addScriptTag({ url: "http://localhost/api/website/fixture/widget.js" });
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await browserExpect.poll(() => count).toBe(2);
      await browserExpect(page.getByRole("log").getByText("First pending")).toHaveCount(0);
      await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("Second message");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await browserExpect(page.getByRole("log").getByText("Second message")).toBeVisible();
      expect(bySession.size).toBe(2);
      expect([...bySession.values()].map(chat => chat.messages.map(message => message.body))).toEqual([["First pending"], ["Second message"]]);
      bySession.get("session-2")!.messages.push({authorKind:"assistant",displayKind:"system",body:"Waiting update"},{authorKind:"assistant",body:"Agent update"},{authorKind:"human",body:"Human reply"});
      for (const label of ["You", "System", "Assistant", "Support"]) await browserExpect(page.getByRole("log").getByText(label, {exact:true}).first()).toBeVisible();
      bySession.delete("session-2");
      await browserExpect(page.getByRole("log").getByText("Second message")).toHaveCount(0);
      await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      expect(count).toBe(3);
    } finally { await browser.close(); }
  }, 30_000);
});
