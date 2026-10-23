"use client";

import Link from "next/link";
import { useState } from "react";
import type { OperationsActor,OperationsIncident,OperationsMonitor } from "@kasitek-labs/contracts";
import { AdminPageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { CommandStatus,OperationsNav,ReadState,StateBadge,dateText,humanize,sourceNames,useOperationsCommand,useOperationsRead } from "./shared";

type Status={environment:string;collectionEnabled:boolean;evaluationEnabled:boolean;notificationsEnabled:boolean;worker:{status:string;lastProgressAt:string|null};notificationBacklog:string;oldestPendingNotificationAt:string|null;selfHealthLimit:string};
export function OperationsOverview({actor}:{actor:OperationsActor}) {
 const [source,setSource]=useState(""),[status,setStatus]=useState("active"),[severity,setSeverity]=useState(""),[assignedTo,setAssignedTo]=useState(""),[cursor,setCursor]=useState<string|null>(null);
 const query=new URLSearchParams({status,limit:"50"});if(source)query.set("source",source);if(severity)query.set("severity",severity);if(assignedTo)query.set("assignedTo",assignedTo);if(cursor)query.set("cursor",cursor);
 const incidents=useOperationsRead<{items:OperationsIncident[];nextCursor:string|null}>(`incidents?${query}`),monitors=useOperationsRead<{items:OperationsMonitor[]}>("monitors"),health=useOperationsRead<Status>("status"),operators=useOperationsRead<{items:{id:string;name:string}[]}>("operators");
 function refresh(){incidents.reload();monitors.reload();health.reload();}
 const command=useOperationsCommand(actor.id,refresh);
 const filter=(set:(value:string)=>void,value:string)=>{set(value);setCursor(null);};
 return <>
  <AdminPageHeader title="Operations" actions={<Button variant="secondary" onClick={refresh} disabled={incidents.loading||monitors.loading||health.loading}>Refresh</Button>}/>
  <OperationsNav role={actor.role}/><CommandStatus command={command}/>
  <ReadState loading={health.loading} error={health.error} retry={health.reload}>{health.data?<section aria-label="Operations status" className="mb-5 rounded-md border border-border p-4">
   <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-3"><span className="text-sm font-medium">{health.data.environment}</span><StateBadge value={health.data.worker.status}/></div><span className="text-xs text-muted-foreground">Worker updated {dateText(health.data.worker.lastProgressAt)}</span></div>
   <dl className="mt-4 grid grid-cols-2 gap-4 text-sm lg:grid-cols-4">{[["Collection",health.data.collectionEnabled?"Enabled":"Disabled"],["Detection",health.data.evaluationEnabled?"Enabled":"Disabled"],["Notifications",health.data.notificationsEnabled?"Enabled":"Disabled"],["Pending notifications",health.data.notificationBacklog]].map(([key,value])=><div key={key}><dt className="text-xs text-muted-foreground">{key}</dt><dd className="mt-1 font-medium">{value}</dd></div>)}</dl>
   {health.data.oldestPendingNotificationAt?<p className="mt-3 text-xs text-muted-foreground">Oldest pending: {dateText(health.data.oldestPendingNotificationAt)}</p>:null}
  </section>:null}</ReadState>
  <section aria-labelledby="incidents-title" className="space-y-4">
   <h2 id="incidents-title" className="text-base font-semibold">Incidents</h2>
   <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
    <label className="space-y-1 text-xs text-muted-foreground">Product<Select value={source} onChange={event=>filter(setSource,event.target.value)}><option value="">All products</option>{Object.entries(sourceNames).map(([key,name])=><option key={key} value={key}>{name}</option>)}</Select></label>
    <label className="space-y-1 text-xs text-muted-foreground">Status<Select value={status} onChange={event=>filter(setStatus,event.target.value)}>{["active","open","acknowledged","resolved"].map(value=><option key={value} value={value}>{humanize(value)}</option>)}</Select></label>
    <label className="space-y-1 text-xs text-muted-foreground">Severity<Select value={severity} onChange={event=>filter(setSeverity,event.target.value)}><option value="">All severities</option><option value="critical">Critical</option><option value="warning">Warning</option></Select></label>
    <label className="space-y-1 text-xs text-muted-foreground">Assignee<Select value={assignedTo} onChange={event=>filter(setAssignedTo,event.target.value)}><option value="">All operators</option>{operators.data?.items.map(operator=><option key={operator.id} value={operator.id}>{operator.name||operator.id}</option>)}</Select></label>
   </div>
   <ReadState loading={incidents.loading} error={incidents.error} retry={incidents.reload}>
    {!incidents.data?.items.length?<p className="py-8 text-sm text-muted-foreground">No matching incidents</p>:<div className="divide-y divide-border rounded-md border border-border">{incidents.data.items.map(item=><Link key={item.id} href={`/operations/incidents/${item.id}`} className="block p-4 outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><StateBadge value={item.severity}/><span className="text-xs text-muted-foreground">{sourceNames[item.source]}</span></div><p className="mt-2 break-words text-sm font-medium">{humanize(item.signalKey)}</p><p className="mt-1 break-all text-xs text-muted-foreground">{item.group}</p></div><StateBadge value={item.status}/></div><div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground"><span>Condition: {humanize(item.condition)}</span><span>Opened {dateText(item.openedAt)}</span><span>Assigned: {item.assignedTo??"Unassigned"}</span></div></Link>)}</div>}
    <div className="flex gap-2">{cursor?<Button variant="secondary" size="sm" onClick={()=>setCursor(null)}>First page</Button>:null}{incidents.data?.nextCursor?<Button variant="secondary" size="sm" onClick={()=>setCursor(incidents.data!.nextCursor)}>Next page</Button>:null}</div>
   </ReadState>
  </section>
  <section className="mt-8" aria-labelledby="monitors-title"><h2 id="monitors-title" className="mb-3 text-base font-semibold">Sources</h2><ReadState loading={monitors.loading} error={monitors.error} retry={monitors.reload}>
   {!monitors.data?.items.length?<p className="py-5 text-sm text-muted-foreground">No configured sources</p>:<div className="grid gap-3 md:grid-cols-2">{monitors.data.items.map(item=><article key={item.id} className="rounded-md border border-border p-4"><div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-medium">{sourceNames[item.source]}</h3><StateBadge value={!item.enabled?"disabled":item.lastError?"unavailable":item.lastObservedAt?"available":"unknown"}/></div><p className="mt-2 break-all text-xs text-muted-foreground">{item.id}</p><p className="mt-2 text-xs">Observed {dateText(item.lastObservedAt)}</p>{item.lastError?<p className="mt-2 text-xs text-destructive">{humanize(item.lastError)}</p>:null}<p className="mt-1 text-xs text-muted-foreground">Every {item.intervalSeconds}s · next {dateText(item.nextPollAt)}</p></article>)}</div>}
  </ReadState></section>
  {health.data?<p className="mt-5 text-xs text-muted-foreground">{health.data.selfHealthLimit}</p>:null}
 </>;
}
