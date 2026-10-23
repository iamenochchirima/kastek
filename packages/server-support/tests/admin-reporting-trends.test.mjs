import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {generateKeyPairSync} from 'node:crypto';
import {importSPKI,jwtVerify} from 'jose';
import {AnalyticsReportingClient,ReportingGrantIssuer} from '../dist/analytics-reporting.js';
import {loadAdminTrends,PRODUCT_TREND_METRICS,sanitizeAdminTrends} from '../dist/admin-reporting-trends.js';
import {validateProductReport} from '../dist/admin-reporting.js';
const query={start:'2026-10-01T00:00:00.000Z',end:'2026-10-03T00:00:00.000Z',timezone:'UTC',organizationId:'same-id',page:1,pageSize:50};

test('scoped admin trends use signed versioned grants and retain projection freshness over HTTP',async()=>{
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const privatePem=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const publicKey=await importSPKI(keys.publicKey.export({type:'spki',format:'pem'}).toString(),'ES256');
  let product='growth',mode='ok';const observed=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    if(req.url.startsWith('/internal/reporting/scopes/resolve')) {
      assert.equal(req.headers.authorization,'Bearer resolver');
      assert.equal(req.headers['x-source-service'],product==='growth'?'core':'tenant-platform');
      const url=new URL(req.url,'http://fixture');assert.equal(url.searchParams.get('external_source_id'),'same-id');
      res.end(JSON.stringify({scope_id:17,root_scope_id:17,parent_scope_id:null,scope_kind:product==='growth'?'core_organization':'tenant_workspace',owning_source_service:mode==='wrong-scope'?'other':product==='growth'?'core':'tenant-platform',external_source_id:'same-id',reporting_timezone:'UTC'}));return;
    }
    const token=req.headers.authorization.slice(7);
    const verified=await jwtVerify(token,publicKey,{audience:'kasitek-analytics-reporting'});
    const request=JSON.parse(body);observed.push(request);
    assert.deepEqual(verified.payload.metric_keys,PRODUCT_TREND_METRICS[product].map(key=>`${key}@1`));
    assert.equal(verified.payload.sub,'admin-reader');assert.equal(request.reporting_scope_id,17);
    assert.equal(request.include_descendants,product==='agency');
    let output=JSON.stringify({scope_id:17,scope_kind:product==='growth'?'core_organization':'tenant_workspace',range_start:query.start,range_end:query.end,timezone:'UTC',metrics:PRODUCT_TREND_METRICS[product].map(key=>({key,unit:'count',availability:{state:'available',reason:null},coverage:{state:mode==='partial'?'partial':'available',complete_through:mode==='partial'?null:query.end},freshness:{state:mode==='stale'?'stale':'fresh',latest_source_timestamp:'2026-10-02T23:00:00.000Z'},series:[{bucket_start:query.start,bucket_end:'2026-10-02T00:00:00.000Z',value:mode==='unsafe'?9007199254740992:7}]}))});
    if(mode==='unsafe') output=output.replaceAll('9007199254740992','9007199254740992.0');
    res.end(output);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const client=new AnalyticsReportingClient(`http://127.0.0.1:${server.address().port}`,'resolver');
    const issuer=await ReportingGrantIssuer.fromPem(privatePem,'kasitek-core');
    const deps=async()=>({client,issuer});
    const results=await loadAdminTrends('growth','admin-reader',query,deps);
    assert.equal(results[0].series[0].value,'7');assert.equal(results[0].availability,'available');assert.equal(results[0].completeThrough,query.end);
    mode='stale';assert.equal((await loadAdminTrends('growth','admin-reader',query,deps))[0].availability,'stale');
    mode='partial';const partial=(await loadAdminTrends('growth','admin-reader',query,deps))[0];assert.equal(partial.availability,'partial');assert.equal(partial.completeThrough,null);
    mode='unsafe';const unsafe=(await loadAdminTrends('growth','admin-reader',query,deps))[0];assert.equal(unsafe.series[0].value,null);assert.equal(unsafe.availability,'partial');
    mode='wrong-scope';const count=observed.length;assert.equal((await loadAdminTrends('growth','admin-reader',query,deps))[0].availability,'unavailable');assert.equal(observed.length,count);
    mode='ok';product='agency';assert.equal((await loadAdminTrends('agency','admin-reader',query,deps))[0].series[0].value,'7');
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('trend collector rejects unsafe quantities and out-of-window values',()=>{
 const trend={key:'conversation.lifecycle_events',unit:'count',availability:'available',source:'labs.analytics',observedAt:null,completeThrough:null,series:[{start:query.start,end:query.end,value:'7'}]};
 assert.equal(sanitizeAdminTrends([trend],query)[0].series[0].value,'7');
 assert.throws(()=>sanitizeAdminTrends([{...trend,series:[{start:query.start,end:query.end,value:7}]}],query));
 assert.throws(()=>sanitizeAdminTrends([{...trend,series:[{start:'2026-01-01T00:00:00Z',end:'2026-01-02T00:00:00Z',value:'7'}]}],query));
 const report={contractVersion:'1',product:'growth',availability:'available',generatedAt:query.end,sourceObservedAt:null,completeThrough:null,metrics:[],records:[],hasMore:false,trends:[trend]};
 assert.equal(validateProductReport(report,'growth',query).trends[0].series[0].value,'7');
});

test('cross-organization trends call the bounded Analytics admin route with exact-path actor authority',async()=>{
  const {verifyAdminAuthority}=await import('../dist/admin-authority.js');
  const secret='admin-reporting-test-secret-32-bytes';
  const allQuery={...query};delete allQuery.organizationId;
  let mode='ok',calls=0;
  const server=createServer(async(req,res)=>{
    calls++;
    assert.equal(req.method,'GET');assert.equal(req.headers.authorization,'Bearer resolver');
    const actor=verifyAdminAuthority(req.headers['x-kasitek-admin-authority'],{secret,audience:'analytics',method:'GET',path:req.url,capability:'admin:report'});
    assert.equal(actor.id,'report-reader');assert.equal(actor.role,'viewer');
    assert.throws(()=>verifyAdminAuthority(req.headers['x-kasitek-admin-authority'],{secret,audience:'analytics',method:'GET',path:req.url+'&organizationId=other',capability:'admin:report'}));
    const params=new URL(req.url,'http://fixture').searchParams;
    assert.equal(params.get('product'),'growth');assert.equal(params.get('start'),query.start);assert.equal(params.get('timezone'),'UTC');
    assert.equal(params.has('organizationId'),false);assert.deepEqual(params.get('metrics').split(','),PRODUCT_TREND_METRICS.growth.map(key=>`${key}@1`));
    const trends=PRODUCT_TREND_METRICS.growth.map(key=>({key,unit:'count',availability:mode==='stale'?'stale':mode==='outage'?'unavailable':mode==='partial'?'partial':'available',source:'labs.analytics',observedAt:'2026-10-02T12:00:00.000Z',completeThrough:mode==='partial'?null:query.end,series:mode==='outage'?[]:[{start:query.start,end:query.end,value:'9007199254740993'}]}));
    if(mode==='missing')trends.pop();
    if(mode==='duplicate')trends[1]=trends[0];
    res.end(JSON.stringify({trends,includedScopeCount:mode==='partial'?1:2,totalScopeCount:2,hasMore:mode==='partial'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const client=new AnalyticsReportingClient(`http://127.0.0.1:${server.address().port}`,'resolver');
    const dependencies=async()=>({client,adminAuthority:{secret,role:'viewer'}});
    const results=await loadAdminTrends('growth','report-reader',allQuery,dependencies);
    assert.equal(results[0].series[0].value,'9007199254740993');assert.equal(results[0].availability,'available');assert.equal(results[0].domain,'usage');assert.equal(results[0].observedAt,'2026-10-02T12:00:00.000Z');assert.deepEqual(results[0].scopeCoverage,{includedScopeCount:2,totalScopeCount:2,hasMore:false});
    mode='partial';const partial=(await loadAdminTrends('growth','report-reader',allQuery,dependencies))[0];assert.equal(partial.availability,'partial');assert.equal(partial.completeThrough,null);assert.equal(partial.scopeCoverage.hasMore,true);
    mode='stale';assert.equal((await loadAdminTrends('growth','report-reader',allQuery,dependencies))[0].availability,'stale');
    mode='outage';assert.equal((await loadAdminTrends('growth','report-reader',allQuery,dependencies))[0].availability,'unavailable');
    mode='missing';assert.equal((await loadAdminTrends('growth','report-reader',allQuery,dependencies))[0].availability,'unavailable');
    mode='duplicate';assert.equal((await loadAdminTrends('growth','report-reader',allQuery,dependencies))[0].availability,'unavailable');
    const prior=calls;const absent=await loadAdminTrends('growth','report-reader',allQuery,async()=>({client}));assert.equal(absent[0].availability,'unavailable');assert.equal(calls,prior);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('trend sanitation retains domain and exact token values while rejecting duplicate or inconsistent buckets',()=>{
  const trend={key:'agent.native.model.input_tokens',unit:'tokens',availability:'partial',source:'labs.analytics',observedAt:null,completeThrough:null,scopeCoverage:{includedScopeCount:1,totalScopeCount:2,hasMore:true},series:[{start:query.start,end:query.end,value:'9007199254740993'}]};
  const [result]=sanitizeAdminTrends([trend],query);
  assert.equal(result.domain,'usage');assert.equal(result.series[0].value,'9007199254740993');assert.deepEqual(result.scopeCoverage,trend.scopeCoverage);
  assert.throws(()=>sanitizeAdminTrends([trend,trend],query));
  assert.throws(()=>sanitizeAdminTrends([{...trend,unit:'count'}],query));
  assert.throws(()=>sanitizeAdminTrends([{...trend,availability:'available'}],query));
  assert.throws(()=>sanitizeAdminTrends([{...trend,scopeCoverage:{includedScopeCount:1,totalScopeCount:2,hasMore:false}}],query));
  assert.throws(()=>sanitizeAdminTrends([{...trend,series:[...trend.series,...trend.series]}],query));
});
