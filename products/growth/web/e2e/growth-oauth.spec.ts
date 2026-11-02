import {expect,test,type Page} from "@playwright/test";

const nonce="a".repeat(43),endpoint="https://api.example.test/mcp";
const review=()=>({id:"fixture-review",operation:"content.posts.draft.create",state:"proposed",payloadDigest:"exact-fixture-digest",input:{draft:{title:"Reviewed launch",content:"Keep this exact content",channels:[]}},preview:{postId:"fixture-post",title:"Reviewed launch",content:"Keep this exact content",scheduledFor:"2030-01-02T10:00:00Z",variants:[{platform:"FACEBOOK",content:"Facebook launch copy"}],accounts:[{id:"fixture-facebook",platform:"FACEBOOK",displayName:"Luma Studio page",handle:"@lumastudio",externalAccountId:"fb-business-page"}],media:[{assetId:"asset-launch",fileName:"launch-campaign.jpg",mimeType:"image/jpeg"}]},result:null,reviewUrl:"/operations/reviews/fixture-review",expiresAt:new Date(Date.now()+600000).toISOString()});
const connection=()=>({id:"fixture-connection",clientName:"Fixture external agent",scopes:["growth:read","growth:draft"],revokedAt:null,createdAt:new Date().toISOString(),accessExpiresAt:new Date(Date.now()+3600000).toISOString()});
const json=(value:unknown,status=200)=>({status,contentType:"application/json",body:JSON.stringify(value)});
async function fits(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}

// Controlled production UI fixture; OAuth protocol/database behavior is tested independently by the API suite.
for(const width of [390,768,1440])for(const theme of ["light","dark"] as const)test(`OAuth and exact reviews at ${width}px ${theme}`,async({page},testInfo)=>{
  await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.route(`**/api/oauth/requests/${nonce}`,route=>route.fulfill(json({request:{clientId:"fixture",clientName:"Fixture external agent",scopes:["growth:read","growth:draft"],resource:endpoint},organizations:[{id:"one",name:"First workspace"},{id:"two",name:"Second workspace"}]})));
  let consentAttempts=0,releaseConsent:(()=>void)|undefined;
  await page.route(`**/api/oauth/requests/${nonce}/decision`,async route=>{
    const input=route.request().postDataJSON();expect(input.organizationId).toBe("one");expect(input.scope).toBe("growth:read");consentAttempts++;
    if(consentAttempts===1){await new Promise<void>(resolve=>{releaseConsent=resolve;});return route.fulfill(json({error:"Connection temporarily unavailable"},503));}
    return route.fulfill(json({redirectUrl:"http://127.0.0.1:3313/developers/mcp"}));
  });
  await page.goto(`/oauth/consent?request=${nonce}`);
  await expect(page.getByRole("heading",{name:"Connect Fixture external agent"})).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme",theme);await fits(page);await page.screenshot({path:testInfo.outputPath("consent.png"),fullPage:true});
  const workspace=page.getByRole("combobox",{name:"Workspace"});await workspace.focus();await page.keyboard.press("Space");await page.getByRole("option",{name:"First workspace"}).click();
  await page.getByRole("checkbox",{name:"Create and edit records"}).uncheck();
  const connect=page.getByRole("button",{name:"Connect",exact:true});await connect.focus();await page.keyboard.press("Enter");
  await expect(page.getByRole("button",{name:"Connecting…"})).toBeDisabled();releaseConsent!();
  await expect(page.getByRole("alert")).toHaveText("Connection temporarily unavailable");
  await expect(workspace).toHaveText("First workspace");await expect(page.getByRole("checkbox",{name:"Create and edit records"})).not.toBeChecked();

  await page.route("**/api/developers",route=>route.fulfill(json({apiKeys:[],config:{mcpAvailable:true,mcpEndpoint:endpoint,mcpOAuth:{enabled:true},mcpPackage:null,clients:[],restBaseUrl:"https://api.example.test/v1"}})));
  await page.route("**/api/oauth/connections",route=>route.fulfill(json({connections:[connection()]})));
  let revokeAttempts=0,releaseRevoke:(()=>void)|undefined;
  await page.route("**/api/oauth/connections/fixture-connection",async route=>{
    expect(route.request().method()).toBe("DELETE");revokeAttempts++;
    if(revokeAttempts===1){await new Promise<void>(resolve=>{releaseRevoke=resolve;});return route.fulfill(json({error:"Unavailable"},503));}
    return route.fulfill(json({revoked:true}));
  });
  await connect.click();await expect(page).toHaveURL(/\/developers\/mcp$/);
  await expect(page.getByText(endpoint,{exact:true})).toBeVisible();await fits(page);await page.screenshot({path:testInfo.outputPath("connections.png"),fullPage:true});
  await page.getByRole("button",{name:"Revoke access",exact:true}).click();const dialog=page.getByRole("dialog");await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab");expect(await dialog.evaluate(element=>element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");await expect(dialog).not.toBeVisible();await expect(page.getByRole("button",{name:"Revoke access",exact:true})).toBeFocused();
  await page.getByRole("button",{name:"Revoke access",exact:true}).click();await fits(page);await page.screenshot({path:testInfo.outputPath("revoke.png"),fullPage:true});
  const revoke=dialog.getByRole("button",{name:"Revoke access",exact:true});await revoke.focus();await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button",{name:"Revoking…"})).toBeDisabled();releaseRevoke!();
  await expect(page.getByText("Could not revoke access",{exact:true})).toBeVisible();await expect(dialog).toBeVisible();
  await revoke.click();await expect(dialog).not.toBeVisible();await expect(page.getByText("Revoked",{exact:true})).toBeVisible();

  let current=review(),decisionAttempts=0,releaseDecision:(()=>void)|undefined;
  await page.route("**/api/operations/reviews/fixture-review",route=>route.fulfill(json({review:current})));
  await page.route("**/api/operations/reviews/fixture-review/decision",async route=>{
    const input=route.request().postDataJSON();expect(input).toEqual({decision:"approve",payloadDigest:"exact-fixture-digest"});decisionAttempts++;
    if(decisionAttempts===1){await new Promise<void>(resolve=>{releaseDecision=resolve;});return route.fulfill(json({error:"Review changed; retry"},409));}
    current={...current,state:"approved"};return route.fulfill(json({review:current}));
  });
  await page.goto("/operations/reviews/fixture-review");await expect(page.getByRole("heading",{name:"Review action",exact:true})).toBeVisible();await fits(page);
  await expect(page.getByRole("region",{name:"Content preview"})).toContainText("Keep this exact content");
  await expect(page.getByText("Luma Studio page",{exact:true})).toBeVisible();await expect(page.getByText("FACEBOOK · @lumastudio",{exact:true})).toBeVisible();
  await expect(page.getByText("Facebook launch copy",{exact:true})).toBeVisible();await expect(page.getByText("launch-campaign.jpg",{exact:true})).toBeVisible();
  await expect(page.getByRole("link",{name:"Open post",exact:true})).toHaveAttribute("href","/content/posts/fixture-post");
  await expect(page.locator("details")).not.toHaveAttribute("open","");
  await page.getByText("Exact request",{exact:true}).focus();await page.keyboard.press("Enter");await expect(page.locator("pre")).toContainText("Keep this exact content");
  await page.getByText("Exact request",{exact:true}).click();await fits(page);await page.screenshot({path:testInfo.outputPath("review.png"),fullPage:true});
  const approve=page.getByRole("button",{name:"Approve action",exact:true});await approve.focus();await page.keyboard.press("Enter");
  await expect(page.getByRole("button",{name:"Approving…"})).toBeDisabled();await expect(page.getByRole("button",{name:"Reject",exact:true})).toBeDisabled();releaseDecision!();
  await expect(page.getByRole("alert")).toHaveText("Review changed; retry");await expect(page.getByRole("region",{name:"Content preview"})).toContainText("Keep this exact content");
  await approve.click();await expect(page.getByText("Approved. Waiting for your agent.",{exact:true})).toBeVisible();await expect(approve).toHaveCount(0);
  let keyAttempts=0,releaseKey:(()=>void)|undefined;
  await page.route("**/api/developers/api-keys",async route=>{
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({name:"Scope pilot",scopes:["growth:read","growth:publish"]});
    keyAttempts++;
    if(keyAttempts===1){await new Promise<void>(resolve=>{releaseKey=resolve;});return route.fulfill(json({error:"Scope fixture temporarily unavailable"},503));}
    return route.fulfill(json({key:{id:"fixture-scoped-key",name:"Scope pilot",prefix:"kst_fixture",scopes:["growth:read","growth:publish"],status:"ACTIVE",createdById:"fixture-user",lastUsedAt:null,expiresAt:null,revokedAt:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},secret:"kst_fixture_not_a_real_credential"},201));
  });
  await page.goto("/developers/api-keys");
  const keyName=page.getByRole("textbox",{name:"API key name",exact:true});await keyName.fill("Scope pilot");
  await expect(page.getByRole("checkbox",{name:"Read business records"})).toBeChecked();
  await page.getByRole("checkbox",{name:"Create and edit records"}).uncheck();
  await page.getByRole("checkbox",{name:"Publish, schedule and send"}).check();
  await fits(page);await page.screenshot({path:testInfo.outputPath("api-key-scopes.png"),fullPage:true});
  await keyName.focus();await page.keyboard.press("Enter");
  await expect(page.getByRole("button",{name:"Creating…"})).toBeDisabled();await expect(keyName).toBeDisabled();
  await expect(page.getByRole("checkbox",{name:"Publish, schedule and send"})).toBeDisabled();releaseKey!();
  await expect(page.getByRole("alert")).toHaveText("Scope fixture temporarily unavailable");
  await expect(keyName).toHaveValue("Scope pilot");await expect(page.getByRole("checkbox",{name:"Read business records"})).toBeChecked();
  await expect(page.getByRole("checkbox",{name:"Publish, schedule and send"})).toBeChecked();await expect(page.getByRole("checkbox",{name:"Create and edit records"})).not.toBeChecked();
  await page.getByRole("button",{name:"Create API key",exact:true}).click();
  await expect(page.getByText("Copy this API key now",{exact:true})).toBeVisible();await expect(keyName).toHaveValue("");
  const savedKey=width<768?page.locator("article").filter({hasText:"Scope pilot"}):page.getByRole("row").filter({hasText:"Scope pilot"});
  await expect(savedKey).toContainText("growth:read, growth:publish");await fits(page);
  expect(errors).toEqual([]);
});

test("unavailable consent, connections, expired review and rejected review are explicit",async({page})=>{
  await page.route(`**/api/oauth/requests/${nonce}`,route=>route.fulfill(json({error:"Not found"},404)));
  await page.goto(`/oauth/consent?request=${nonce}`);await expect(page.getByRole("heading",{name:"Connection unavailable"})).toBeVisible();
  await page.route("**/api/developers",route=>route.fulfill(json({config:{mcpAvailable:true,mcpEndpoint:endpoint,mcpOAuth:{},restBaseUrl:"/v1"}})));
  let release:(()=>void)|undefined;await page.route("**/api/oauth/connections",async route=>{await new Promise<void>(resolve=>{release=resolve;});return route.fulfill(json({error:"Unavailable"},503));});
  await page.goto("/developers/mcp");await expect(page.getByLabel("Loading MCP settings")).toBeVisible();release!();await expect(page.getByRole("alert")).toHaveText("Could not load agent connections");await expect(page.getByText("Connections unavailable",{exact:true})).toBeVisible();
  await page.route("**/api/operations/reviews/fixture-review",route=>route.fulfill(json({review:{...review(),expiresAt:new Date(Date.now()-60000).toISOString()}})));
  await page.goto("/operations/reviews/fixture-review");await expect(page.getByText("Expired",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Approve action"})).toHaveCount(0);
  await page.route("**/api/operations/reviews/rejected",route=>route.fulfill(json({review:{...review(),id:"rejected",operation:"inbox.messages.send",input:{conversationId:"fixture-customer",text:"Thanks for your message"},preview:{targetLabel:"Fixture customer · WhatsApp",content:"Thanks for your message"}}})));
  await page.route("**/api/operations/reviews/rejected/decision",route=>{expect(route.request().postDataJSON()).toEqual({decision:"reject",payloadDigest:"exact-fixture-digest"});return route.fulfill(json({review:{...review(),id:"rejected",state:"rejected"}}));});
  await page.goto("/operations/reviews/rejected");await expect(page.getByText("Fixture customer · WhatsApp",{exact:true})).toBeVisible();await expect(page.getByRole("heading",{name:"Send message",exact:true})).toBeVisible();await expect(page.locator("details")).toHaveAttribute("open","");await expect(page.locator("pre")).toContainText("Thanks for your message");await page.getByRole("button",{name:"Reject",exact:true}).click();await expect(page.getByText("rejected",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Approve action"})).toHaveCount(0);
});


test("approved internal action refreshes to completion and links its saved post",async({page})=>{
  const original={...review(),id:"refresh-review",preview:{title:"New draft",content:"Saved after approval",variants:[],accounts:[],media:[]}};
  let approved=false,refreshes=0;
  await page.route("**/api/operations/reviews/refresh-review",route=>{
    if(approved){refreshes++;return route.fulfill(json({review:{...original,state:"succeeded",result:{post:{id:"new-saved-post",content:"Saved after approval"}}}}));}
    return route.fulfill(json({review:original}));
  });
  await page.route("**/api/operations/reviews/refresh-review/decision",route=>{
    expect(route.request().postDataJSON()).toEqual({decision:"approve",payloadDigest:"exact-fixture-digest"});approved=true;
    return route.fulfill(json({review:{...original,state:"approved"}}));
  });
  await page.goto("/operations/reviews/refresh-review");await expect(page.getByRole("link",{name:"Open post",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Approve action",exact:true}).click();
  await expect(page.getByText("Approved. Waiting for your agent.",{exact:true})).toBeVisible();
  await expect(page.getByText("succeeded",{exact:true})).toBeVisible({timeout:10000});expect(refreshes).toBe(1);
  await expect(page.getByRole("link",{name:"Open post",exact:true})).toHaveAttribute("href","/content/posts/new-saved-post");
  const result=page.locator("details").filter({has:page.getByText("Result",{exact:true})});await expect(result).not.toHaveAttribute("open","");
  await result.locator("summary").click();await expect(result.locator("pre")).toContainText("new-saved-post");
  await expect(page.getByText("Approved. Waiting for your agent.",{exact:true})).toHaveCount(0);
});
