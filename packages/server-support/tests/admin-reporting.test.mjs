import {test} from "node:test";
import assert from "node:assert/strict";
import {parseAdminReportQuery,reportCsv,missingProductReport,reportMetric} from "../dist/admin-reporting.js";
test("bounds, calendar dates and scoped filters fail closed",()=>{
  for(const query of [{start:"2026-02-30T00:00:00Z"},{timezone:"invented"},{pageSize:"101"},{page:"0"},{consumer:"external"},{sql:"select"},{organizationId:""}]) assert.throws(()=>parseAdminReportQuery(query));
  const q=parseAdminReportQuery({start:"2026-03-28T00:00:00Z",end:"2026-03-30T00:00:00Z",timezone:"Europe/London",organizationId:"org"});
  assert.equal(q.timezone,"Europe/London");assert.equal(q.organizationId,"org");
});
test("unknown values remain null and bigint remains exact",()=>{
  const query=parseAdminReportQuery({});const report=missingProductReport("agency",query,"Unavailable");
  assert.equal(report.metrics[0].value,null);assert.equal(report.sourceObservedAt,null);
  assert.equal(reportMetric("paid",9007199254740993n,"invoices",null).value,"9007199254740993");
});
test("CSV preserves unknowns, currency, dimensions and prevents formulas",()=>{
  const report=missingProductReport("growth",parseAdminReportQuery({}),"=HYPERLINK(unsafe)");
  report.metrics.push(reportMetric("paid",123n,"invoices",null,{currency:"ZAR",dimensions:{key:"value"}}));
  const csv=reportCsv([report]);assert.match(csv,/'=HYPERLINK/);assert.match(csv,/"123","ZAR"/);assert.match(csv,/"unavailable"/);
});

test("CSV includes scoped projection buckets and unavailable trend evidence",()=>{
 const query=parseAdminReportQuery({start:"2026-10-01T00:00:00Z",end:"2026-10-02T00:00:00Z",consumer:"growth"});
 const report=missingProductReport("agents",query,"Unavailable");
 report.trends=[{key:"agent.native.root_tasks.completed",unit:"count",domain:"reliability",availability:"partial",source:"labs.analytics",observedAt:null,completeThrough:null,scopeCoverage:{includedScopeCount:1,totalScopeCount:2,hasMore:true},series:[{start:query.start,end:query.end,value:"9007199254740993"}]}];
 const csv=reportCsv([report]);assert.match(csv,/"9007199254740993"/);assert.match(csv,/"trend","2026-10-01/);assert.match(csv,/"1","2","growth"/);
 report.trends[0].series=[];report.trends[0].availability="unavailable";
 assert.match(reportCsv([report]),/"agent.native.root_tasks.completed",""/);
});


test('global trends disclose unregistered organizations without changing source totals',async()=>{
 const {applyAdminPopulationCoverage}=await import('../dist/admin-reporting.js');
 const query=parseAdminReportQuery({});
 const report=missingProductReport('growth',query,'fixture');
 report.metrics=[reportMetric('organizations',3n,'growth',null)];
 report.trends=[{key:'conversation.lifecycle_events',availability:'available',completeThrough:query.end,scopeCoverage:{includedScopeCount:2,totalScopeCount:2,hasMore:false}}];
 applyAdminPopulationCoverage(report);
 assert.equal(report.metrics[0].value,'3');assert.equal(report.trends[0].availability,'partial');assert.equal(report.trends[0].completeThrough,null);assert.match(report.trends[0].reason,/subset/);
 report.query.organizationId='scoped';report.trends[0].availability='available';applyAdminPopulationCoverage(report);assert.equal(report.trends[0].availability,'available');
});


test('CSV includes only the same bounded safe supporting record page',()=>{
 const query=parseAdminReportQuery({page:2,detail:{metric:'runs',dimensions:{consumer:'growth'}}});
 const report=missingProductReport('agents',query,'fixture');report.hasMore=true;
 report.records=[{id:'root-task',kind:'task',organizationId:'org',state:'completed',occurredAt:query.start,label:'=unsafe',consumer:'growth'}];
 const csv=reportCsv([report]);assert.match(csv,/"record"/);assert.match(csv,/"root-task","task","completed"/);assert.match(csv,/'=unsafe/);assert.match(csv,/"2","true"/);
});
