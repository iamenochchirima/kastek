import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {describe,it,expect} from 'vitest';
import {websiteWidgetScript} from '../src/adapters/channels/website/widget';
const {chromium,expect:check}=createRequire(__filename)('../../web/node_modules/@playwright/test');
const schedule=['| Day | Open from | Close at |','| :--- | :---: | ---: |',...['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(day=>'| '+day+' | 01:00 am | 02:00 am |'),'| Notes | Left \\| right | `open|close` <img src=x onerror=alert(1)> |'];
const body = ['## Available tools','', 'Support hours:',...schedule,'', '- **[knowledge_search]** — Search *approved* sources.', '- `enquiry_submit` — Submit details.','', '1. First step','2. Second **bold and *italic*** step','   - Nested item','', '[Safe link](https://example.com/path?q=1)', '[Bad link](javascript:alert(1))','[Data link](data:text/html,hello)','', '\\*literal stars\\* and <img src=x onerror=alert(1)>','', '```js','<script>alert(1)</script>','const long = "'+ 'x'.repeat(160) +'";','```'].join('\n');
describe('generated website widget Markdown with controlled HTTP',()=>{
 it('renders reply formatting as safe DOM and keeps visitor text literal at supported widths',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
   for(const width of [390,768,1440]){
    const page=await browser.newPage({viewport:{width,height:900}});
    await page.route('http://localhost/**',async(route:any)=>{
     const path=new URL(route.request().url()).pathname;
     if(path==='/')return route.fulfill({contentType:'text/html',body:'<html><body><h1>Widget Markdown verification</h1></body></html>'});
     if(path.endsWith('/widget.js'))return route.fulfill({contentType:'application/javascript',body:websiteWidgetScript('fixture')});
     if(path==='/api/website/fixture')return route.fulfill({json:{name:'Assistant'}});
     if(path.endsWith('/session'))return route.fulfill({json:{token:'controlled-visitor'}});
     if(path.endsWith('/customer-conversations'))return route.fulfill({json:{conversation:{id:'conversation'}}});
     if(path.endsWith('/messages'))return route.fulfill({json:{conversation:{state:'automation_active'},messages:[{authorKind:'visitor',body:'**Keep visitor text literal**'},{authorKind:'assistant',body,responseDurationMs:2000}]}});
     throw Error(path);
    });
    const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
    await page.goto('http://localhost/');await page.addScriptTag({url:'http://localhost/api/website/fixture/widget.js'});await page.getByRole('button',{name:'Chat',exact:true}).click();
    const reply=page.locator('.message-body');
    await check(reply.getByRole('heading',{name:'Available tools'})).toBeVisible();
    await check(reply.locator('strong').getByText('[knowledge_search]',{exact:true})).toBeVisible();
    await check(reply.locator('em').getByText('approved',{exact:true})).toBeVisible();
    await check(reply.locator('strong em')).toHaveText('italic');
    await check(reply.locator('ol>li')).toHaveCount(2);await check(reply.locator('ol ul>li')).toHaveText('Nested item');
    const table=reply.getByRole('table');
    await check(table).toHaveCount(1);await check(table.getByRole('columnheader')).toHaveText(['Day','Open from','Close at']);
    await check(table.locator('tbody tr')).toHaveCount(8);await check(table.getByRole('cell',{name:'Sunday',exact:true})).toBeVisible();
    await check(table.getByRole('cell',{name:'Left | right',exact:true})).toBeVisible();await check(table.locator('code')).toHaveText('open|close');
    await check(table).toContainText('<img src=x onerror=alert(1)>');await check(table.locator('img')).toHaveCount(0);
    expect(await table.getByRole('columnheader').nth(1).evaluate((n:HTMLElement)=>getComputedStyle(n).textAlign)).toBe('center');
    await check(reply.getByRole('region',{name:'Table'})).toHaveAttribute('tabindex','0');
    await check(reply.locator('pre code')).toContainText('<script>alert(1)</script>');
    await check(reply.getByRole('link',{name:'Safe link'})).toHaveAttribute('href','https://example.com/path?q=1');
    await check(reply.getByRole('link',{name:'Safe link'})).toHaveAttribute('rel','noopener noreferrer');
    await check(reply.getByRole('link')).toHaveCount(1);
    await check(reply).toContainText('*literal stars*');
    await check(reply.locator('img,script,iframe')).toHaveCount(0);
    await check(page.locator('.message[data-author=visitor]')).toContainText('**Keep visitor text literal**');
    await check(page.locator('.message[data-author=visitor] strong')).toHaveCount(1);
    expect(await page.locator('[data-agents-widget]').evaluate((host:HTMLElement)=>{const panel=host.shadowRoot!.querySelector('section')!;const body=host.shadowRoot!.querySelector('.message-body')!;return panel.getBoundingClientRect().right<=innerWidth&&panel.getBoundingClientRect().left>=0&&body.scrollWidth<=body.clientWidth+1})).toBe(true);
    expect(await reply.locator('strong').first().evaluate((n:HTMLElement)=>getComputedStyle(n).display)).toBe('inline');
    expect(errors).toEqual([]);
    await mkdir('../../../.audit/widget-markdown',{recursive:true});await page.screenshot({path:'../../../.audit/widget-markdown/'+width+'.png'});await page.close();
   }
  }finally{await browser.close()}
 },30000);
});
