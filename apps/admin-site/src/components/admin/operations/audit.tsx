"use client";

import Link from "next/link";
import { useState } from "react";
import type { OperationsAuditEntry } from "@kasitek-labs/contracts";
import { AdminPageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { OperationsNav,ReadState,StateBadge,dateText,humanize,sourceNames,useOperationsRead } from "./shared";

type Filters={source:string;actorId:string;customerId:string;resourceId:string;status:string;action:string};
type AuditPage={items:OperationsAuditEntry[];nextCursor:string|null;sources:{source:string;status:string}[];ordering:string};
export function OperationsAudit({role}:{role:string}) {
 const initial:Filters={source:"",actorId:"",customerId:"",resourceId:"",status:"",action:""};
 const [draft,setDraft]=useState(initial),[filters,setFilters]=useState(initial),[cursor,setCursor]=useState<string|null>(null);
 const query=new URLSearchParams({limit:"40"});for(const [key,value] of Object.entries(filters))if(value.trim())query.set(key,value.trim());if(cursor)query.set("cursor",cursor);
 const audit=useOperationsRead<AuditPage>(`audit?${query}`);
 return <>
  <AdminPageHeader title="Audit" actions={<Button variant="secondary" disabled={audit.loading} onClick={audit.reload}>Refresh</Button>}/><OperationsNav role={role}/>
  <form onSubmit={event=>{event.preventDefault();setFilters({...draft});setCursor(null);}} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
   <label className="space-y-1 text-xs text-muted-foreground">Product<Select value={draft.source} onChange={event=>setDraft({...draft,source:event.target.value})}><option value="">All products</option>{["operations","growth","agents","agency","analytics"].map(value=><option key={value} value={value}>{sourceNames[value]}</option>)}</Select></label>
   {([['actorId','Actor ID'],['customerId','Customer ID'],['resourceId','Resource ID'],['action','Action'],['status','Outcome']] as const).map(([key,label])=><label key={key} className="space-y-1 text-xs text-muted-foreground">{label}<Input value={draft[key]} maxLength={200} onChange={event=>setDraft({...draft,[key]:event.target.value})}/></label>)}
   <div className="flex gap-2 sm:col-span-2 lg:col-span-3"><Button type="submit" disabled={audit.loading}>Search</Button><Button variant="secondary" onClick={()=>{setDraft(initial);setFilters(initial);setCursor(null);}}>Clear</Button></div>
  </form>
  <div className="mt-5"><ReadState loading={audit.loading} error={audit.error} retry={audit.reload}>
   {audit.data?<div className="mb-4 flex flex-wrap gap-2">{audit.data.sources.map(source=><div key={source.source} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"><span>{sourceNames[source.source]}</span><StateBadge value={source.status}/></div>)}</div>:null}
   {audit.data?.sources.some(source=>source.status!=="available")?<p role="status" className="mb-4 text-sm text-muted-foreground">Results are incomplete. Some sources are unavailable, unconfigured or deferred.</p>:null}
   {!audit.data?.items.length?<p className="py-8 text-sm text-muted-foreground">No matching audit entries</p>:<div className="divide-y divide-border rounded-md border border-border">{audit.data.items.map(entry=><article key={`${entry.source}:${entry.id}`} className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{humanize(entry.action)}</span><StateBadge value={entry.status}/></div><time dateTime={entry.occurredAt} className="text-xs text-muted-foreground">{dateText(entry.occurredAt)}</time></div><dl className="mt-3 grid grid-cols-2 gap-3 text-xs lg:grid-cols-4">{[["Product",sourceNames[entry.source]],["Actor",entry.actorId??"System"],["Resource",`${entry.resourceType}: ${entry.resourceId}`],["Operation",entry.operationId??"None"]].map(([label,value])=><div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 break-all">{value}</dd></div>)}</dl>{entry.customerId&&["growth","agents","agency"].includes(entry.source)?<Link href={`/customers/${entry.source}/${encodeURIComponent(entry.customerId)}`} className="mt-3 inline-block text-xs text-primary hover:underline">Open customer</Link>:null}{entry.code?<p className="mt-2 break-words text-xs text-muted-foreground">{humanize(entry.code)}</p>:null}</article>)}</div>}
   <div className="mt-4 flex flex-wrap gap-2">{cursor?<Button variant="secondary" size="sm" onClick={()=>setCursor(null)}>First page</Button>:null}{audit.data?.nextCursor?<Button variant="secondary" size="sm" onClick={()=>setCursor(audit.data!.nextCursor)}>Next page</Button>:null}</div>
   {audit.data?<p className="mt-3 text-xs text-muted-foreground">Each source uses its own clock and pagination. Entries are not a global chronological log.</p>:null}
  </ReadState></div>
 </>;
}
