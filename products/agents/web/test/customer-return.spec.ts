import { expect, test } from "@playwright/test";

test("a return link removes its fragment and requires a one-time exchange", async ({ page }) => {
  const deployment = "11111111-1111-4111-8111-111111111111", secret = "A".repeat(43), calls: Array<{path:string;body:unknown;authorization:string | undefined}> = [];
  await page.route("**/api/**", async route => {
    const request=route.request(),path=new URL(request.url()).pathname;
    if(request.method()==="POST")calls.push({path,body:request.postDataJSON(),authorization:request.headers().authorization});
    let data:unknown={};
    if(path.endsWith("/session"))data={token:"new-visitor-session"};
    else if(path.endsWith("/followup/return"))data={conversationId:"conversation"};
    else if(path.endsWith("/customer-conversations"))data={conversation:{id:"conversation",state:"handoff_pending"}};
    else if(path.endsWith("/messages"))data={conversation:{id:"conversation",state:"handoff_pending"},messages:[{id:"message",sequence:"1",authorKind:"human",body:"Hello",createdAt:"2026-10-29T10:00:00Z"}]};
    else if(path.endsWith("/followup"))data={state:"verified"};
    else if(path===`/api/website/${deployment}`)data={name:"Support"};
    await route.fulfill({json:data});
  });
  await page.goto(`/support/return/${deployment}#${secret}`);
  await expect.poll(()=>new URL(page.url()).hash).toBe("");
  expect(calls).toHaveLength(0);
  await page.getByRole("button",{name:"Open conversation"}).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${deployment}$`));
  expect(calls.find(call=>call.path.endsWith("/followup/return"))).toEqual({path:`/api/website/${deployment}/followup/return`,body:{secret},authorization:"Bearer new-visitor-session"});
  await expect(page.getByRole("button",{name:"Turn off email notifications"})).toBeVisible();
  await expect.poll(()=>calls.some(call=>call.path.endsWith("/followup/read") && (call.body as {sequence?:string}).sequence==="1")).toBe(true);
  await page.getByRole("button",{name:"Turn off email notifications"}).click();
  await expect(page.getByRole("button",{name:"Turn off email notifications"})).toHaveCount(0);
  expect(calls.some(call=>call.path.endsWith("/followup/revoke"))).toBe(true);
});
