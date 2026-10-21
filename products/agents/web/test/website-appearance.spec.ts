import { createServer, type Server } from "node:http";
import { test, expect, type Page } from "@playwright/test";
import { websiteWidgetScript } from "../../api/src/adapters/channels/website/widget";
const servers: Server[] = [];
test.use({ launchOptions: { channel: "chromium-headless-shell" } });
test.afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});
async function fixture(page: Page, paused=false) {
  const sent: Record<string,unknown>[] = [], errors:string[]=[];let sessions=0,lost=true;
  page.on("pageerror",error=>errors.push(error.message));
  const server=createServer(async(req,res)=>{
    res.setHeader("content-type","application/json");const path=new URL(req.url!,"http://fixture.test").pathname;
    if(path==="/"){res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><script src="/api/website/exact/widget.js"></script>');return;}
    if(path.endsWith("widget.js")){res.setHeader("content-type","application/javascript");res.end(websiteWidgetScript("exact"));return;}
    if(path==="/api/website/exact"){res.end(JSON.stringify({name:"Support",state:paused?"paused":"active",bookingEnabled:false,appearance:{title:'Help <img src=x onerror=alert(1)>',accent:"#065f46",launcherLabel:"Ask support",greeting:"Welcome <script>unsafe</script>",position:"bottom-left",quickReplies:["Opening hours","Book an appointment"]}}));return;}
    if(path.endsWith("/session")){sessions++;res.end(JSON.stringify({token:"private-session"}));return;}
    if(path.endsWith("/customer-conversations")){res.end(JSON.stringify({conversation:{id:"one"}}));return;}
    if(path.endsWith("/messages")){
      expect(req.headers.authorization).toBe("Bearer private-session");
      if(req.method==="POST"){let body="";for await(const chunk of req)body+=chunk;sent.push(JSON.parse(body));if(lost){lost=false;res.end("lost acknowledgement");return;}}
      res.end(JSON.stringify({conversation:{id:"one",state:"automation_active"},messages:sent.length?[{authorKind:"visitor",body:sent[0]!.body},{authorKind:"human",body:"We are open."}]:[]}));return;
    }
    res.statusCode=404;res.end("{}");
  });servers.push(server);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;await page.goto(origin);
  await expect(page.getByRole("button",{name:"Ask support",exact:true})).toBeVisible();
  return {sent,errors,get sessions(){return sessions;}};
}
test("plain-text appearance, suggested messages and lost acknowledgement reload",async({page})=>{
  const f=await fixture(page);expect(f.sessions).toBe(0);await page.getByRole("button",{name:"Ask support",exact:true}).click();
  await expect(page.getByRole("log")).toContainText("Welcome <script>unsafe</script>");expect(await page.locator("img").count()).toBe(0);
  await page.getByRole("button",{name:"Opening hours",exact:true}).click();await expect(page.getByRole("button",{name:"Retry message"})).toBeVisible();
  await page.getByRole("button",{name:"Retry message"}).click();await expect(page.getByRole("log")).toContainText("Support: We are open.");
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
