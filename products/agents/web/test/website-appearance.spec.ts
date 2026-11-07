import { createServer, type Server } from "node:http";
import { test, expect, type Page } from "@playwright/test";
import { websiteWidgetScript } from "../../api/src/adapters/channels/website/widget";
const servers: Server[] = [];
test.use({ launchOptions: { channel: "chromium-headless-shell" } });
test.afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});
async function fixture(page: Page, paused=false, appearance: Record<string,unknown> = {}) {
  const sent: Record<string,unknown>[] = [], errors:string[]=[];let sessions=0,lost=true,refreshes=0,conversationState="automation_active";
  page.on("pageerror",error=>errors.push(error.message));
  const server=createServer(async(req,res)=>{
    res.setHeader("content-type","application/json");const path=new URL(req.url!,"http://fixture.test").pathname;
    if(path==="/"){res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><script src="/api/website/exact/widget.js"></script>');return;}
    if(path.endsWith("widget.js")){res.setHeader("content-type","application/javascript");res.end(websiteWidgetScript("exact"));return;}
    if(path==="/api/website/exact"){res.end(JSON.stringify({name:"Support",state:paused?"paused":"active",bookingEnabled:false,appearance:{title:'Help <img src=x onerror=alert(1)>',accent:"#065f46",launcherLabel:"Ask support",greeting:"Welcome <script>unsafe</script>",position:"bottom-left",quickReplies:["Opening hours","Book an appointment"],...appearance}}));return;}
    if(path.endsWith("/session")){sessions++;res.end(JSON.stringify({token:"private-session"}));return;}
    if(path.endsWith("/customer-conversations")){res.end(JSON.stringify({conversation:{id:"one"}}));return;}
    if(path.endsWith("/messages")){
      expect(req.headers.authorization).toBe("Bearer private-session");
      if(req.method==="POST"){let body="";for await(const chunk of req)body+=chunk;sent.push(JSON.parse(body));if(lost){lost=false;res.end("lost acknowledgement");return;}}
      else refreshes++;
      res.end(JSON.stringify({conversation:{id:"one",state:conversationState},messages:sent.length?[{authorKind:"visitor",body:sent[0]!.body},{authorKind:"human",body:"We are open."}]:[]}));return;
    }
    res.statusCode=404;res.end("{}");
  });servers.push(server);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;await page.goto(origin);
  await expect(page.getByRole("button",{name:"Ask support",exact:true})).toBeVisible();
  return {sent,errors,setState(value:string){conversationState=value;},get sessions(){return sessions;},get refreshes(){return refreshes;}};
}
test("shows waiting and human ownership without claiming a person has replied",async({page})=>{
  const f=await fixture(page);await page.getByRole("button",{name:"Ask support",exact:true}).click();
  f.setState("handoff_pending");await expect(page.getByRole("status")).toHaveText("Waiting for support");
  f.setState("human_owned");await expect(page.getByRole("status")).toHaveText("With support");
  await expect(page.locator(".eyebrow")).toHaveText("Human support");
  f.setState("automation_active");await expect(page.locator(".eyebrow")).toHaveText("Powered by AI");
});
test("plain-text appearance, suggested messages and lost acknowledgement reload",async({page})=>{
  const f=await fixture(page);expect(f.sessions).toBe(0);await page.getByRole("button",{name:"Ask support",exact:true}).click();
  await expect(page.getByRole("log")).toContainText("Welcome <script>unsafe</script>");expect(await page.locator("img").count()).toBe(0);
  await page.getByRole("button",{name:"Opening hours",exact:true}).click();await expect(page.getByRole("button",{name:"Retry message"})).toBeVisible();
  const error = await page.getByRole("status").textContent();expect(error).toBeTruthy();const refreshes=f.refreshes;
  await expect.poll(()=>f.refreshes).toBeGreaterThan(refreshes);await expect(page.getByRole("status")).toHaveText(error!);
  await page.getByRole("button",{name:"Retry message"}).click();
  const humanReply=page.locator('main p[data-author="human"]');
  await expect(humanReply.locator("strong")).toHaveText("Support");
  await expect(humanReply).toContainText("We are open.");
  await page.screenshot({path:test.info().outputPath("desktop.png")});
  expect(f.sent).toHaveLength(2);expect(f.sent[0]).toEqual(f.sent[1]);expect(f.sessions).toBe(1);
  await page.keyboard.press("Escape");await expect(page.getByRole("button",{name:"Ask support",exact:true})).toBeFocused();
  await page.reload();await page.getByRole("button",{name:"Ask support",exact:true}).click();await expect(page.getByRole("log")).toContainText("We are open.");expect(f.sessions).toBe(1);expect(f.errors).toEqual([]);
});
test("mobile sizing and ignored foreign postMessage",async({page})=>{
  await page.setViewportSize({width:320,height:568});const f=await fixture(page);await page.getByRole("button",{name:"Ask support",exact:true}).click();
  const bounds=await page.getByRole("region",{name:"Website assistant"}).boundingBox();expect(bounds).not.toBeNull();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(320);expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(568);
  await page.screenshot({path:test.info().outputPath("mobile.png")});
  await page.addScriptTag({url:new URL("/api/website/exact/widget.js",page.url()).href});await expect(page.getByRole("region",{name:"Website assistant"})).toHaveCount(1);
  await page.evaluate(()=>window.postMessage({type:"kasitek:send",text:"forged",token:"forged"},"*"));expect(f.sent).toHaveLength(0);expect(f.errors).toEqual([]);
});
test("paused cannot create a visitor session or send",async({page})=>{
  const f=await fixture(page,true);await page.getByRole("button",{name:"Ask support",exact:true}).click();await expect(page.getByRole("status")).toHaveText("Chat is currently unavailable");await expect(page.getByRole("button",{name:"Send",exact:true})).toBeDisabled();expect(f.sessions).toBe(0);expect(f.sent).toHaveLength(0);
});
test("renders an optional subtitle and dark theme",async({page})=>{
  const appearance={subtitle:"Ask us anything: menu, prices, orders",theme:"dark",accent:"#2fd4a7"};
  await fixture(page,false,appearance);
  await page.getByRole("button",{name:"Ask support",exact:true}).click();
  await expect(page.locator(".subtitle")).toHaveText("Ask us anything: menu, prices, orders");
  await expect(page.locator(".eyebrow")).toBeHidden();
  await expect(page.locator("[data-agents-widget]")).toHaveAttribute("data-theme","dark");
  await page.screenshot({path:test.info().outputPath("dark-template.png")});
});

test("restored appearance applies geometry, avatar, branding and expansion",async({page})=>{
  await page.route("https://avatar.example.test/avatar.svg",route=>route.fulfill({contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#065f46"/></svg>'}));
  const f=await fixture(page,false,{title:"KasiTek support",launcherSize:72,windowWidth:460,windowHeight:680,borderRadius:24,launcherOffset:24,avatarUrl:"https://avatar.example.test/avatar.svg",showBranding:false});
  const launcher=page.getByRole("button",{name:"Ask support",exact:true});
  expect((await launcher.boundingBox())!.width).toBe(72);
  await launcher.click();const panel=page.getByRole("region",{name:"Website assistant"});
  await expect(panel.locator(".avatar img")).toBeVisible();await expect(panel.locator(".branding")).toBeHidden();
  const bounds=(await panel.boundingBox())!;expect(bounds.width).toBe(460);expect(bounds.height).toBe(680);expect(bounds.x).toBe(24);
  await expect(panel).toHaveCSS("border-radius","24px");await expect(panel.locator("header")).toHaveCSS("background-color","rgb(31, 31, 31)");
  await page.screenshot({path:test.info().outputPath("custom-desktop.png")});
  await page.getByRole("button",{name:"Expand chat",exact:true}).click();const expanded=(await panel.boundingBox())!;expect(expanded.width).toBe(600);expect(expanded.height).toBe(952);
  await expect(page.getByRole("button",{name:"Collapse chat",exact:true})).toHaveAttribute("aria-pressed","true");
  await page.getByRole("button",{name:"Collapse chat",exact:true}).click();expect((await panel.boundingBox())!.width).toBe(460);
  await page.keyboard.press("Escape");await expect(launcher).toBeFocused();expect(f.errors).toEqual([]);
});
test("unsafe appearance falls back safely and stays within a small viewport",async({page})=>{
  await page.setViewportSize({width:320,height:568});
  const f=await fixture(page,false,{avatarUrl:"javascript:alert(1)",launcherSize:-100,windowWidth:10000,windowHeight:10000,borderRadius:1000,launcherOffset:1000,accent:"red;position:fixed"});
  await page.getByRole("button",{name:"Ask support",exact:true}).click();const panel=page.getByRole("region",{name:"Website assistant"});
  await expect(panel.locator(".avatar img")).toHaveCount(0);await expect(panel.locator(".branding")).toContainText("Powered by KasiTek");
  await page.getByRole("button",{name:"Expand chat",exact:true}).click();const box=(await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);expect(box.y).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(320);expect(box.y+box.height).toBeLessThanOrEqual(568);
  await page.screenshot({path:test.info().outputPath("expanded-mobile.png")});expect(f.errors).toEqual([]);
});
