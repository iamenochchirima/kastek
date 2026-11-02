"use client";

import Link from "next/link";
import { useState } from "react";
import type { OperationsActor,OperationsIncidentDetail,OperationsSignal } from "@kasitek-labs/contracts";
import { AdminPageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter } from "@/components/ui/dialog";
import { CommandStatus,OperationsNav,ReadState,StateBadge,dateText,humanize,sourceNames,useOperationsClock,useOperationsCommand,useOperationsRead } from "./shared";

type Detail=OperationsIncidentDetail&{observations:{observedAt:string;code:string|null;signals:OperationsSignal[]}[]};
export function IncidentDetail({id,actor}:{id:string;actor:OperationsActor}) {
 const detail=useOperationsRead<Detail>(`incidents/${encodeURIComponent(id)}`),operators=useOperationsRead<{items:OperationsActor[]}>("operators");
 const [action,setAction]=useState<"acknowledge"|"assign"|"resolve"|null>(null),[reason,setReason]=useState(""),[assignedTo,setAssignedTo]=useState("");
 const command=useOperationsCommand(actor.id,()=>{setAction(null);setReason("");detail.reload();});
 const now=useOperationsClock();
 const item=detail.data?.incident,canOperate=["operator","admin","owner","superadmin"].includes(actor.role);
 const canResolve=item?.condition==="healthy"&&!!item.observedAt&&Date.parse(item.observedAt)>now-180_000;
 async function apply(){if(!item||!action)return;await command.submit(`incidents/${item.id}/actions`,"POST",{action,reason,expectedRevision:item.revision,...(action==="assign"?{assignedTo:assignedTo||null}:{})});}
 return <>
  <AdminPageHeader title="Incident" actions={<Button variant="secondary" onClick={detail.reload} disabled={detail.loading}>Refresh</Button>}/><OperationsNav role={actor.role}/>
  <Link href="/operations" className="text-sm text-primary hover:underline">All incidents</Link>
  <CommandStatus command={command}/>
  <ReadState loading={detail.loading} error={detail.error} retry={detail.reload}>{item?<div className="mt-5 space-y-6">
   <section className="rounded-md border border-border p-4 sm:p-5"><div className="flex flex-wrap items-center gap-2"><StateBadge value={item.severity}/><StateBadge value={item.status}/><span className="text-xs text-muted-foreground">{sourceNames[item.source]} · {item.environment}</span></div>
    <h2 className="mt-3 break-words text-lg font-semibold">{humanize(item.signalKey)}</h2><p className="mt-1 break-all text-sm text-muted-foreground">{item.group}</p>
    <dl className="mt-5 grid grid-cols-2 gap-4 text-sm lg:grid-cols-4">{[["Condition",humanize(item.condition)],["Value",item.value??"Unknown"],["Assigned to",operators.data?.items.find(operator=>operator.id===item.assignedTo)?.name||item.assignedTo||"Unassigned"],["Observed",dateText(item.observedAt)]].map(([key,value])=><div key={key}><dt className="text-xs text-muted-foreground">{key}</dt><dd className="mt-1 break-words">{value}</dd></div>)}</dl>
    {canOperate&&item.status!=="resolved"?<div className="mt-5 flex flex-wrap gap-2"><Button variant="secondary" disabled={command.busy||command.uncertain||item.status==="acknowledged"} onClick={()=>{setAction("acknowledge");setReason("");}}>Acknowledge</Button><Button variant="secondary" disabled={command.busy||command.uncertain||!operators.data} onClick={()=>{setAction("assign");setAssignedTo(item.assignedTo??"");setReason("");}}>Assign</Button><Button variant="outline" disabled={command.busy||command.uncertain||!canResolve} onClick={()=>{setAction("resolve");setReason("");}}>Resolve</Button>{!canResolve?<span className="self-center text-xs text-muted-foreground">Fresh healthy evidence required to resolve</span>:null}</div>:null}
    {item.previousIncidentId?<Link href={`/operations/incidents/${item.previousIncidentId}`} className="mt-4 inline-block text-sm text-primary hover:underline">Previous incident</Link>:null}
   </section>
   <section aria-labelledby="evidence-title"><h2 id="evidence-title" className="mb-3 text-base font-semibold">Affected resources</h2>{item.evidence.length?<div className="divide-y divide-border rounded-md border border-border">{item.evidence.map((evidence,index)=><div key={`${evidence.product}:${evidence.resourceId}:${index}`} className="space-y-1 p-4 text-sm"><p>{sourceNames[evidence.product]} · {humanize(evidence.resourceType)}</p><p className="break-all font-mono text-xs text-muted-foreground">{evidence.resourceId}</p>{evidence.code?<p className="text-xs">{humanize(evidence.code)}</p>:null}{evidence.customerId&&["growth","agents","agency"].includes(evidence.product)?<Link href={`/customers/${evidence.product}/${encodeURIComponent(evidence.customerId)}`} className="inline-block text-xs text-primary hover:underline">Open customer</Link>:null}{evidence.operationId?<p className="break-all text-xs text-muted-foreground">Operation {evidence.operationId}</p>:null}</div>)}</div>:<p className="py-3 text-sm text-muted-foreground">No resource details available</p>}</section>
   <section aria-labelledby="timeline-title"><h2 id="timeline-title" className="mb-3 text-base font-semibold">Timeline</h2><ol className="divide-y divide-border rounded-md border border-border">{detail.data!.transitions.map(transition=><li key={transition.id} className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">{humanize(transition.action)}</span><time className="text-xs text-muted-foreground" dateTime={transition.createdAt}>{dateText(transition.createdAt)}</time></div><p className="mt-1 break-all text-xs text-muted-foreground">{transition.actorId??"System"}</p>{transition.reason?<p className="mt-2 break-words text-sm">{transition.reason}</p>:null}</li>)}</ol></section>
   <details className="rounded-md border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Recent observations</summary><div className="mt-3 space-y-3">{detail.data!.observations.length?detail.data!.observations.map((observation,index)=><div key={`${observation.observedAt}:${index}`} className="rounded border border-border p-3 text-xs"><p>{dateText(observation.observedAt)}</p>{observation.code?<p className="mt-1 text-muted-foreground">{humanize(observation.code)}</p>:null}{observation.signals.map((signal,signalIndex)=><div key={`${signal.key}:${signalIndex}`} className="mt-2 flex flex-wrap gap-2"><StateBadge value={signal.status}/><span>{signal.value??"Unknown"} {humanize(signal.unit)}</span><span className="text-muted-foreground">Coverage: {signal.coverage}</span></div>)}</div>):<p className="text-sm text-muted-foreground">No observations available</p>}</div></details>
  </div>:null}</ReadState>
  <Dialog open={action!==null} onOpenChange={open=>{if(!open&&!command.busy)setAction(null);}}><DialogContent><DialogHeader><DialogTitle>{action==="assign"?"Assign incident":action==="resolve"?"Resolve incident":"Acknowledge incident"}</DialogTitle><DialogDescription>{action==="resolve"?"Close this incident using its latest healthy observation.":"Record the operator and reason."}</DialogDescription></DialogHeader>
   {action==="assign"?<label className="space-y-1 text-sm">Operator<Select value={assignedTo} disabled={command.busy||command.uncertain} onChange={event=>setAssignedTo(event.target.value)}><option value="">Unassigned</option>{operators.data?.items.map(operator=><option key={operator.id} value={operator.id}>{operator.name||operator.id}</option>)}</Select></label>:null}
   <label className="space-y-1 text-sm">Reason<Textarea autoFocus maxLength={500} value={reason} disabled={command.busy||command.uncertain} onChange={event=>setReason(event.target.value)}/></label><CommandStatus command={command}/>
   <DialogFooter><Button variant="secondary" disabled={command.busy} onClick={()=>setAction(null)}>Cancel</Button><Button disabled={command.busy||command.uncertain||reason.trim().length<3} onClick={()=>void apply()}>{command.busy?"Saving…":"Confirm"}</Button></DialogFooter>
  </DialogContent></Dialog>
 </>;
}
