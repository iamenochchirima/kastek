import {test} from "node:test";
import assert from "node:assert/strict";
import {parseAdminReportQuery,collectAdminProductReports,missingProductReport,validateProductReport,reportMetric} from "../dist/admin-reporting.js";
const query=parseAdminReportQuery({});
function fixture(product){return {...missingProductReport(product,query,"unavailable"),availability:"available",metrics:[reportMetric("organizations",2,"records",null)],privateToken:"DO NOT FORWARD"};}
test("partial failure retains successful sources and never converts failure to zero",async()=>{
 const rows=await collectAdminProductReports([{product:"growth",query,url:"http://growth"},{product:"agency",query,url:"http://agency"}],undefined,async url=>url.includes("agency")?new Response("failure",{status:503}):Response.json(fixture("growth")));
 assert.equal(rows[0].metrics[0].value,"2");assert.equal(rows[1].metrics[0].value,null);assert(!JSON.stringify(rows).includes("DO NOT FORWARD"));
});
test("wrong product, unknown metric, invalid null and excessive detail fail closed",()=>{
 for(const change of [{product:"agency"},{metrics:[reportMetric("invented",0,"source",null)]},{metrics:[{...reportMetric("paid",null,"source",null),availability:"available"}]},{records:Array(101).fill({})}])
  assert.throws(()=>validateProductReport({...fixture("growth"),...change},"growth",query));
});
test("cancellation propagates rather than reporting a source outage",async()=>{
 const controller=new AbortController();controller.abort(new Error("cancelled"));
 await assert.rejects(()=>collectAdminProductReports([{product:"growth",query,url:"http://growth"}],controller.signal,async()=>{throw Error();}),/cancelled/);
});
