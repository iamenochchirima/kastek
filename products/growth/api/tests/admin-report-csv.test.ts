import test from "node:test";
import assert from "node:assert/strict";
import {parse} from "csv-parse/sync";
import type {Pool} from "pg";
import {exportReport} from "../src/services/admin/reports.js";

test("legacy customer cohort export escapes spreadsheet formulas from organization names",async()=>{
 const names=['=HYPERLINK("https://example.invalid")','+SUM(1,2)','-SUM(1,2)','@SUM(1,2)','\t=SUM(1,2)','\r=SUM(1,2)','Ordinary organization'];
 const audit:string[]=[];
 const pool={query:async(sql:string)=>{
  if(sql.includes('SELECT organization.id'))return {rows:names.map((name,index)=>({id:`org-${index}`,name,plan:null,operations:0,active_days:0}))};
  audit.push(sql);return {rows:[],rowCount:1};
 }} as unknown as Pool;
 const result=await exportReport(pool,'fixture-admin','customer-cohorts',1);
 const rows=parse(result.bytes,{columns:true});
 assert.deepEqual(rows.map((row:{organization_name:string})=>row.organization_name),names.map((name,index)=>index<6?"'"+name:name));
 assert(audit.some(sql=>sql.includes("'REQUESTED'")));
 assert(audit.some(sql=>sql.includes("'SUCCEEDED'")));
});
