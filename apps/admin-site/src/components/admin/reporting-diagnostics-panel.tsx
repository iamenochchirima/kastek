"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import type {AdminDiagnosticService,AdminReportingDiagnostics} from "@kasitek-labs/contracts";
const names={growth:"Growth",agents:"Agents",agency:"Agency",analytics:"Analytics"};
const display=(value:string|null|undefined)=>value??"Unknown";
const date=(value:string|null|undefined)=>value?new Date(value).toLocaleString():"Unknown";
export function ReportingDiagnosticsPanel(){
 const [reports,setReports]=useState<AdminReportingDiagnostics[]>([]),[loading,setLoading]=useState<string[]>([]),[error,setError]=useState(false);
 const pending=useRef(new Map<string,AbortController>());
 const refresh=useCallback(async(source:AdminDiagnosticService|"all")=>{
  if(source==="all"){for(const controller of pending.current.values())controller.abort();pending.current.clear();}
  else if(pending.current.has("all"))return;
  pending.current.get(source)?.abort();const controller=new AbortController();pending.current.set(source,controller);
  setLoading([...pending.current.keys()]);setError(false);
  try{const response=await fetch(`/api/operations/reporting?source=${source}`,{signal:controller.signal,cache:"no-store"});if(!response.ok)throw Error();const payload=await response.json() as {reports:AdminReportingDiagnostics[]};
   if(!controller.signal.aborted)setReports(previous=>source==="all"?payload.reports:previous.map(report=>report.service===source?payload.reports[0]:report));
  }catch{if(!controller.signal.aborted)setError(true);}
  finally{if(pending.current.get(source)===controller){pending.current.delete(source);setLoading([...pending.current.keys()]);}}
 },[]);
 useEffect(()=>{void refresh("all");const requests=pending.current;return()=>{for(const controller of requests.values())controller.abort();};},[refresh]);
 return <section className="v-card overflow-hidden" aria-label="Reporting diagnostics">
  <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4"><h2 className="text-sm font-semibold">Reporting</h2><button className="v-btn-secondary" disabled={loading.length>0} onClick={()=>void refresh("all")}>{loading.includes("all")?"Refreshing…":"Refresh"}</button></div>
  {error?<p role="alert" className="px-5 py-3 text-sm text-destructive">Diagnostics unavailable. <button className="underline" onClick={()=>void refresh("all")}>Retry</button></p>:null}
  {!reports.length&&!error?<p role="status" className="p-5 text-sm text-muted-foreground">Loading reporting status…</p>:null}
  <div className="divide-y divide-border">{reports.map(report=><article key={report.service} className="space-y-3 p-5">
   <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">{names[report.service]}</h3><p className="text-xs text-muted-foreground">Observed {date(report.observedAt)}</p></div><button className="v-btn-secondary" disabled={loading.includes("all")||loading.includes(report.service)} onClick={()=>void refresh(report.service)}>Refresh {names[report.service]}</button></div>
   <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-4">{(["configuration","connectivity","schema","reads"] as const).map(key=><div key={key}><dt className="capitalize text-muted-foreground">{key}</dt><dd>{report[key].state.replaceAll("_"," ")}{report[key].code?<span className="block text-xs">{report[key].code}</span>:null}</dd></div>)}</dl>
   {report.publication?<dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs sm:grid-cols-4">{Object.entries({State:report.publication.state.replaceAll("_"," "),Pending:report.publication.pending,Retrying:report.publication.retrying,Quarantined:report.publication.quarantined,"Pending receipts":display(report.publication.pendingReceipts),"Oldest pending":date(report.publication.oldestPendingAt),"Last published":date(report.publication.lastPublishedAt),"Failure code":display(report.publication.failureCode)}).map(([key,value])=><div key={key}><dt className="text-muted-foreground">{key}</dt><dd className="break-words">{value}</dd></div>)}</dl>:null}
   {report.projection?<><dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs sm:grid-cols-4">{Object.entries({"Registered scopes":report.projection.registeredScopes,Pending:report.projection.pending,"Oldest pending":date(report.projection.oldestPendingAt),Failed:report.projection.failed,Backfilling:report.projection.backfilling,"Promoted checkpoints":report.projection.promotedGenerations,"Source time":date(report.projection.observedSourceAt),Ingested:date(report.projection.ingestedAt),Checkpoint:date(report.projection.checkpointAt),"Latest promotion":date(report.projection.latestPromotedAt),"Complete through":date(report.projection.completeThrough),Coverage:report.projection.coverage}).map(([key,value])=><div key={key}><dt className="text-muted-foreground">{key}</dt><dd>{value}</dd></div>)}</dl><div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{Object.entries(report.projection.sourceStates).map(([state,count])=><span key={state}>{state.replaceAll("_"," ")}: {count}</span>)}</div></>:null}
  </article>)}</div>
 </section>;
}
