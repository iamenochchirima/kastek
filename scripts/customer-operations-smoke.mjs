import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

// Uses only the dedicated development fixture produced by reporting acceptance.
const root=process.cwd();
const state=JSON.parse(await readFile(resolve(root,'.runtime/admin-reporting/acceptance-private.json'),'utf8'));
const origin='http://localhost:3001';
const proof=process.env.CUSTOMER_OPERATIONS_PROOF_DIR??'/tmp/kasitek-customer-operations-proof';
await mkdir(proof,{recursive:true});
const {chromium}=await import(pathToFileURL(resolve(root,'products/agents/web/node_modules/@playwright/test/index.mjs')).href);
const json=async(path,cookie=state.adminCookie,init={})=>{
 const response=await fetch(origin+path,{...init,headers:{cookie,origin,'Content-Type':'application/json',...init.headers}});
 return {status:response.status,body:await response.json()};
};
const scopes=[['growth',state.growthOrganizationId],['agency',state.agencyWorkspaceId],['agents',state.agents.organizationId]];
const results={metadata:[],browser:[],authorization:[],fixtureRecovery:null};
for(const[product,id]of scopes){
 const result=await json(`/api/customers/${product}/${encodeURIComponent(id)}`);
 assert.equal(result.status,200,`${product} customer overview unavailable`);
 assert.equal(result.body.customer.product,product);assert.equal(result.body.customer.id,id);
 assert(result.body.sections.every(section=>typeof section.source==='string'&&'observedAt'in section));
 const serialized=JSON.stringify(result.body);
 assert(!/"(?:access_token|refresh_token|instructions|message_body|prompt|credentials)"/.test(serialized));
 results.metadata.push({product,status:result.status,sections:result.body.sections.map(s=>({id:s.id,status:s.status,count:s.records.length})),relationships:result.body.relationships.length});
}
const endpoint=`/api/customers/agency/${state.agencyWorkspaceId}`;
const sample={operationId:randomUUID(),action:'client.suspend',targetId:state.agencyClientId,expected:{state:'active'},reason:'Development fixture verification'};
const viewerCookie=state.viewerAdminCookie.startsWith('kasitek_admin_session=')?state.viewerAdminCookie:'kasitek_admin_session='+state.viewerAdminCookie;
const denied=await json(endpoint+'/operations',viewerCookie,{method:'POST',body:JSON.stringify(sample)});
assert.equal(denied.status,403);results.authorization.push({case:'viewer command',status:denied.status});
const noOrigin=await fetch(origin+endpoint+'/operations',{method:'POST',headers:{cookie:state.adminCookie,'Content-Type':'application/json'},body:JSON.stringify(sample)});
assert.equal(noOrigin.status,403);results.authorization.push({case:'missing mutation origin',status:noOrigin.status});
const anon=await fetch(origin+endpoint);assert.equal(anon.status,401);results.authorization.push({case:'anonymous metadata',status:anon.status});
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1050}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.context().addCookies([{name:'kasitek_admin_session',value:state.adminCookie.split('=').slice(1).join('='),domain:'localhost',path:'/'}]);
 for(const[product,id]of scopes){
  await page.goto(`${origin}/customers/${product}/${encodeURIComponent(id)}`);
  await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('section[aria-label]').length>1);
  assert.equal(await page.getByText('Product unavailable',{exact:true}).count(),0);
  await page.screenshot({path:resolve(proof,`${product}-1440.png`),fullPage:true,animations:'disabled'});
  results.browser.push({product,width:1440,rendered:true});
 }
 for(const width of[768,390]){
  await page.setViewportSize({width,height:1000});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Overflow at ${width}`);
  await page.screenshot({path:resolve(proof,`agents-${width}.png`),fullPage:true,animations:'disabled'});
  results.browser.push({product:'agents',width,noOverflow:true});
 }
 await page.emulateMedia({colorScheme:'dark'});
 await page.screenshot({path:resolve(proof,'agents-dark-390.png'),fullPage:true,animations:'disabled'});
 if(process.env.KASITEK_CUSTOMER_OPS_EXERCISE_FIXTURE==='1'){
  await page.setViewportSize({width:1440,height:1050});
  const before=await json(endpoint);
  const client=before.body.sections.find(s=>s.id==='clients').records.find(r=>r.id===state.agencyClientId);
  assert(client&&['active','suspended'].includes(client.state),'Dedicated fixture client is unavailable');
  const initialState=client.state;let submitted;let blockReceipts=true;
  await page.route(`**${endpoint}/operations/*`,async route=>{
   if(route.request().method()==='GET'&&blockReceipts)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Controlled lost receipt response'})});
   return route.continue();
  });
  await page.route(`**${endpoint}/operations`,async route=>{
   if(route.request().method()!=='POST')return route.continue();
   submitted=route.request().postDataJSON();
   const response=await route.fetch();assert.equal(response.status(),200);
   await route.abort('failed');
  });
  await page.goto(origin+`/customers/agency/${state.agencyWorkspaceId}`);
  const article=page.locator('article').filter({hasText:`Client ${state.agencyClientId}`});
  await article.getByRole('button',{name:initialState==='active'?'Suspend client':'Resume client',exact:true}).click();
  await page.getByRole('textbox',{name:'Reason',exact:true}).fill('Controlled development lost-response verification');
  await page.getByRole('button',{name:'Review action',exact:true}).click();
  await page.getByRole('button',{name:'Confirm action',exact:true}).click();
  await page.getByRole('button',{name:'Retry same request',exact:true}).waitFor();
  assert(submitted.operationId);
  assert.equal(await page.locator('article button:enabled').count(),0,'Uncertain command must block new actions');
  await page.reload();await page.getByRole('button',{name:'Retry same request',exact:true}).waitFor();
  const saved=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),`customer-operation:agency:${state.agencyWorkspaceId}:command`);
  assert.equal(saved.operationId,submitted.operationId);
  blockReceipts=false;
  await page.getByRole('button',{name:'Check outcome',exact:true}).click();
  await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Retry same request'));
  const receipt=await json(endpoint+`/operations/${submitted.operationId}`);assert.equal(receipt.body.status,'confirmed');
  await page.unroute(`**${endpoint}/operations`);
  const after=await json(endpoint);const changed=after.body.sections.find(s=>s.id==='clients').records.find(r=>r.id===state.agencyClientId);
  assert.notEqual(changed.state,initialState);
  const restore={...changed.actions[0],operationId:randomUUID(),reason:'Restore dedicated development fixture state'};
  const restored=await json(endpoint+'/operations',state.adminCookie,{method:'POST',body:JSON.stringify(restore)});assert.equal(restored.body.status,'confirmed');
  results.fixtureRecovery={lostResponse:true,persistedOperationId:true,blockedNewCommand:true,reconciled:true,restored:true};
 }
 assert.deepEqual(errors,[]);results.consoleErrors=errors;
 await writeFile(resolve(proof,'results.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify(results));
}finally{await browser.close();}
