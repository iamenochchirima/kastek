import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { websiteWidgetScript } from "../../api/src/adapters/channels/website/widget";

test.use({ launchOptions: { channel: "chromium-headless-shell" } });
let server: Server;
test.afterEach(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
for (const enabled of [false, true]) test(`follow-up controls reflect availability: ${enabled}`, async ({ page }) => {
  let verified = false, reads = 0; const posts: Array<{path:string;body:unknown}> = [];
  server = createServer(async (req,res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    res.setHeader("content-type", "application/json");
    if (path === "/") { res.setHeader("content-type", "text/html"); res.end('<script src="/api/website/example/widget.js"></script>'); return; }
    if (path.endsWith("widget.js")) { res.setHeader("content-type", "application/javascript"); res.end(websiteWidgetScript("example")); return; }
    if (path === "/api/website/example") { res.end(JSON.stringify({name:"Support", followupEnabled:enabled})); return; }
    if (path.endsWith("/session")) {res.end(JSON.stringify({token:"session"})); return;}
    if (path.endsWith("/customer-conversations")) {res.end(JSON.stringify({conversation:{id:"conversation"}}));return;}
    if (path.endsWith("/messages")) {res.end(JSON.stringify({conversation:{state:"handoff_pending"},messages:[{sequence:"1",authorKind:"human",body:"Hello"}]}));return;}
    if (req.method === "GET" && path.endsWith("/followup")) {res.end(JSON.stringify({state:verified?"verified":"none"}));return;}
    let raw="";for await(const part of req)raw+=part;const body=JSON.parse(raw || "{}");posts.push({path,body});
    if(path.endsWith("/request"))res.end(JSON.stringify({state:"confirmation_sent"}));
    else if(path.endsWith("/verify")){verified=true;res.end(JSON.stringify({state:"verified"}));}
    else if(path.endsWith("/revoke")){verified=false;res.end(JSON.stringify({state:"revoked"}));}
    else if(path.endsWith("/read")){reads++;res.end(JSON.stringify({state:"recorded"}));}
    else {res.statusCode=404;res.end("{}");}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
  await page.getByRole("button",{name:"Chat"}).click();
  if(!enabled){await expect(page.getByLabel("Email address")).toHaveCount(0);return;}
  await page.getByLabel("Email address").fill("customer@example.test");await page.getByRole("button",{name:"Email me"}).click();
  expect(posts.find(item=>item.path.endsWith("/request"))?.body).toEqual({email:"customer@example.test",confirmed:true});
  await page.getByLabel("Confirmation code").fill("A".repeat(43));await page.getByRole("button",{name:"Confirm",exact:true}).click();
  await expect(page.getByText("Notifications on")).toBeVisible();await page.getByRole("button",{name:"Turn off"}).click();
  await expect(page.getByLabel("Email address")).toBeVisible();await expect.poll(()=>reads).toBe(1);
  await page.waitForTimeout(1800);expect(reads).toBe(1);
});
