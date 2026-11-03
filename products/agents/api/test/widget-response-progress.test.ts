import {createRequire} from 'node:module';
import {describe,it,expect} from 'vitest';
import {websiteWidgetScript} from '../src/adapters/channels/website/widget';
const {chromium,expect:check}=createRequire(__filename)('../../web/node_modules/@playwright/test');
describe('generated widget response progress with controlled HTTP',()=>{
 it('animates immediately on Send, restores elapsed progress, and stops on publication or ownership change',async()=>{
  const browser=await chromium.launch({headless:true});const page=await browser.newPage();
  const started=new Date('2026-11-03T10:00:00Z');let phase:string|null=null,ownership='automation_active',reads=0,failReads=false,release:()=>void=()=>{};
  const pending=new Promise<void>(r=>release=r);let replied=false;
  await page.clock.install({time:started});await page.clock.pauseAt(new Date(started.getTime()+100));
  await page.route('http://localhost/**',async(route:any)=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:'<html><body><h1>Response progress</h1></body></html>'});
   if(path.endsWith('widget.js'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:websiteWidgetScript('fixture')});
   if(path==='/api/website/fixture')return route.fulfill({json:{name:'Assistant'}});
   if(path.endsWith('/session'))return route.fulfill({json:{token:'controlled-visitor-token'}});
   if(path.endsWith('/customer-conversations'))return route.fulfill({json:{conversation:{id:'conversation'}}});
   if(path.endsWith('/messages')){
    if(route.request().method()==='POST'){await pending;phase='working';return route.fulfill({json:{}})}
    reads++;if(failReads)return route.fulfill({status:503,json:{error:{message:'History temporarily unavailable'}}});return route.fulfill({json:{conversation:{state:ownership},responseStatus:phase,responseActivity:phase===null&&!replied?null:{inputMessageId:'input',startedAt:started.toISOString(),completedAt:replied?new Date(started.getTime()+7000).toISOString():null,replyMessageId:replied?'reply':null},messages:replied?[{id:'reply',authorKind:'assistant',body:'Real fixture delivery',responseDurationMs:7000}]:[]}});
   }
   throw Error(path);
  });
  const open=async()=>{await page.addScriptTag({url:'http://localhost/api/website/fixture/widget.js'});await page.getByRole('button',{name:'Chat',exact:true}).click();await check(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled()};
  try{
   await page.goto('http://localhost/');await open();
   const indicator=page.getByRole('status',{name:'Assistant is responding'});
   await page.getByRole('textbox',{name:'Message',exact:true}).fill('Hello');await page.getByRole('button',{name:'Send',exact:true}).click();
   await check(indicator).toBeVisible();await page.clock.runFor(2000);await check(indicator).toHaveText('Responding · 2s');
   release();await check(page.getByRole('textbox',{name:'Message',exact:true})).toHaveValue('');
   await page.clock.runFor(5000);await check(indicator).toHaveText('Responding · 7s');
   await page.reload();await open();await check(indicator).toHaveText('Responding · 7s');
   failReads=true;await page.clock.runFor(1500);await check(page.getByText('History temporarily unavailable',{exact:true})).toBeVisible();await check(indicator).toBeHidden();
   failReads=false;await page.clock.runFor(1500);await check(indicator).toBeVisible();
   await page.emulateMedia({reducedMotion:'reduce'});
   expect(await indicator.locator('span').first().evaluate((node:HTMLElement)=>getComputedStyle(node).animationName)).toBe('none');
   replied=true;phase=null;let before=reads;await page.clock.runFor(1500);await check.poll(()=>reads).toBeGreaterThan(before);
   await check(page.getByText('7s',{exact:true})).toBeVisible();await check(indicator).toBeHidden();
   await page.reload();await open();await check(page.getByText('7s',{exact:true})).toBeVisible();
   for(const state of ['handoff_pending','human_owned','resolved']){ownership=state;phase='working';before=reads;await page.clock.runFor(1500);await check.poll(()=>reads).toBeGreaterThan(before);await check(indicator).toBeHidden();}
   ownership='automation_active';phase='failed';before=reads;await page.clock.runFor(1500);await check.poll(()=>reads).toBeGreaterThan(before);
   await check(page.getByText('Could not finish the reply. Please try again.',{exact:true})).toBeVisible();await check(indicator).toBeHidden();
  }finally{await browser.close()}
 },30000);
});
