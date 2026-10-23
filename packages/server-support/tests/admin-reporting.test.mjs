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
