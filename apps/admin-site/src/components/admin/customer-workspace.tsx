"use client";

import {useCallback,useEffect,useRef,useState} from "react";
import Link from "next/link";
import type {CustomerActionTemplate,CustomerOperationPreview,CustomerOperationReceipt,CustomerOperationRequest,CustomerOverview,CustomerProduct,CustomerSection} from "@kasitek-labs/contracts";
import {Button} from "@/components/ui/button";
import {Textarea} from "@/components/ui/textarea";
import {Dialog,DialogContent,DialogHeader,DialogTitle} from "@/components/ui/dialog";
import {AdminPageHeader} from "./page-header";

const products={growth:"Growth",agents:"Agents",agency:"Agency"};
const labelText=(value:string)=>{const text=value.replaceAll("_"," ").replace(/([a-z0-9])([A-Z])/g,"$1 $2");return text.charAt(0).toUpperCase()+text.slice(1);};
async function read<T>(url:string,init?:RequestInit):Promise<T>{
 const response=await fetch(url,{...init,cache:"no-store"});
 const data=await response.json();
 if(!response.ok)throw Error(data.error??"Request unavailable");
 return data as T;
}
export function CustomerWorkspace({product,customerId,canOperate}:{product:CustomerProduct;customerId:string;canOperate:boolean}) {
 const endpoint=`/api/customers/${product}/${encodeURIComponent(customerId)}`;
 const storageKey=`customer-operation:${product}:${customerId}`;
 const [overview,setOverview]=useState<CustomerOverview|null>(null);
 const [error,setError]=useState<string|null>(null);
 const [busy,setBusy]=useState(false);
 const [receipt,setReceipt]=useState<CustomerOperationReceipt|null>(null);
 const [receiptId,setReceiptId]=useState<string|null>(null);
 const currentReceiptId=useRef<string|null>(null);
 const [receiptError,setReceiptError]=useState<string|null>(null);
 const [uncertainCommand,setUncertainCommand]=useState<CustomerOperationRequest|null>(null);
 const [selection,setSelection]=useState<CustomerActionTemplate|null>(null);
 const [command,setCommand]=useState<CustomerOperationRequest|null>(null);
 const [reason,setReason]=useState("");
 const [preview,setPreview]=useState<CustomerOperationPreview|null>(null);
 const [actionError,setActionError]=useState<string|null>(null);
 const [actionBusy,setActionBusy]=useState(false);
 const load=useCallback(async()=>{
  setBusy(true);setError(null);
  try {setOverview(await read<CustomerOverview>(endpoint));}
  catch(failure){setError((failure as Error).message);}
  finally{setBusy(false);}
 },[endpoint]);
 const reconcile=useCallback(async(id:string)=>{
  setReceiptError(null);
  try {const found=await read<CustomerOperationReceipt>(`${endpoint}/operations/${encodeURIComponent(id)}`);if(currentReceiptId.current!==id)return;setReceipt(found);setUncertainCommand(null);sessionStorage.removeItem(`${storageKey}:command`);}
  catch(failure){if(currentReceiptId.current===id)setReceiptError((failure as Error).message);}
 },[endpoint,storageKey]);
 useEffect(()=>{void load();},[load]);
 useEffect(()=>{const id=sessionStorage.getItem(storageKey);currentReceiptId.current=id;try{const saved=sessionStorage.getItem(`${storageKey}:command`);if(saved)setUncertainCommand(JSON.parse(saved));}catch{setReceiptError("Saved operation could not be restored");}if(id){setReceiptId(id);void reconcile(id);}},[storageKey,reconcile]);
 async function more(section:CustomerSection){
  setError(null);
  try {
   const next=await read<CustomerSection>(`${endpoint}/${encodeURIComponent(section.id)}?cursor=${encodeURIComponent(section.nextCursor!)}&limit=50`);
   setOverview(current=>current?{...current,sections:current.sections.map(s=>s.id===section.id?{...next,records:[...s.records,...next.records]}:s)}:current);
  }catch(failure){setError((failure as Error).message);}
 }
 function choose(action:CustomerActionTemplate){if(uncertainCommand)return;setSelection(action);setCommand(null);setPreview(null);setReason("");setActionError(null);}
 async function prepare(){
  if(!selection)return;
  setActionBusy(true);setActionError(null);
  const request={...selection,operationId:command?.operationId??crypto.randomUUID(),reason:reason.trim()};
  setCommand(request);
  try{setPreview(await read<CustomerOperationPreview>(`${endpoint}/operations/preview`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(request)}));}
  catch(failure){setActionError((failure as Error).message);}
  finally{setActionBusy(false);}
 }
 async function submit(){
  if(!command||!preview?.eligible)return;
  await dispatch(command);
 }
 async function dispatch(request:CustomerOperationRequest){
  setActionBusy(true);setActionError(null);
  // Keep the same operation ID across a lost response and page refresh.
  currentReceiptId.current=request.operationId;setReceipt(null);sessionStorage.setItem(storageKey,request.operationId);sessionStorage.setItem(`${storageKey}:command`,JSON.stringify(request));setReceiptId(request.operationId);setUncertainCommand(request);
  try{
   const commandPath=request.action==="webhook.replay.approve"?`/operations/${encodeURIComponent(request.targetId)}/approve`:"/operations";
   const result=await read<CustomerOperationReceipt>(`${endpoint}${commandPath}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(request)});
   setReceipt(result);setReceiptError(null);setSelection(null);setUncertainCommand(null);sessionStorage.removeItem(`${storageKey}:command`);void load();
  }catch(failure){
   setActionError((failure as Error).message);
   setSelection(null);await reconcile(request.operationId);
  }finally{setActionBusy(false);}
 }
 return <div className="admin-page min-w-0">
  <AdminPageHeader title={overview?.customer.name??"Customer"} eyebrow={products[product]} actions={<><Link className="text-sm underline underline-offset-4" href="/customers">Customers</Link><Button variant="outline" disabled={busy} onClick={()=>void load()}>{busy?"Refreshing...":"Refresh"}</Button></>} />
  <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground"><span className="break-all">{customerId}</span>{overview?<><span>{overview.customer.state}</span><span>Observed {new Date(overview.observedAt).toLocaleString()}</span></>:null}<Link className="underline underline-offset-4" href={`/analytics/customers?product=${product}&organizationId=${encodeURIComponent(customerId)}`}>Reporting</Link></div>
  {error?<p role="alert" className="rounded-md border border-border p-4 text-sm">{error}</p>:null}
  {!overview&&busy?<div aria-label="Loading customer" className="h-40 animate-pulse rounded-md bg-muted"/>:null}
  {receiptId?<section aria-label="Current operation" className="v-card space-y-2 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">Operation</h2><Button variant="outline" size="sm" onClick={()=>void reconcile(receiptId)}>Check outcome</Button></div><p className="break-all text-xs text-muted-foreground">{receiptId}</p>{receipt?<><p role="status" className="text-sm">{receipt.status.replaceAll("_"," ")}{receipt.code?` · ${receipt.code}`:""}</p><p className="text-xs text-muted-foreground">{receipt.action} · {receipt.targetId}</p></>:null}{receiptError?<p role="alert" className="text-sm">{receiptError}</p>:null}{uncertainCommand?<div className="space-y-2"><p role="status" className="text-sm">Submission outcome unavailable. Reconcile or retry the same request.</p><Button variant="outline" disabled={actionBusy} onClick={()=>void dispatch(uncertainCommand)}>Retry same request</Button></div>:null}</section>:null}
  {overview?.relationships.length?<section className="v-card space-y-2 p-4"><h2 className="font-medium">Linked execution</h2>{overview.relationships.map(link=><div key={link.mappingId} className="flex flex-wrap items-center gap-3 text-sm"><span>{products[link.product]} · {link.state}</span><Link className="break-all underline underline-offset-4" href={`/customers/${product==="agents"?link.product:"agents"}/${encodeURIComponent(product==="agents"?link.customerId:link.executionOrganizationId)}`}>{product==="agents"?link.customerId:link.executionOrganizationId}</Link></div>)}</section>:null}
  <div className="grid min-w-0 gap-5 xl:grid-cols-2">{overview?.sections.map(section=><section key={section.id} className="v-card min-w-0 overflow-hidden" aria-label={section.title}>
   <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">{labelText(section.title)}</h2>{section.status!=="available"?<span className="text-xs text-muted-foreground">{section.status}</span>:null}</div>
   {section.status==="available"&&!section.records.length?<p className="p-4 text-sm text-muted-foreground">No records</p>:null}
   <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">{section.source} · {section.observedAt?new Date(section.observedAt).toLocaleString():"Observation unavailable"}</p><div className="divide-y divide-border">{section.records.map(record=><article key={record.id} className="space-y-3 p-4"><div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="break-all text-sm font-medium">{record.label}</h3><span className="text-xs text-muted-foreground">{record.state}</span></div><dl className="space-y-2 text-xs">{record.facts.map(fact=><div key={fact.key} className="grid grid-cols-[minmax(90px,1fr)_minmax(0,2fr)] gap-3"><dt className="break-words text-muted-foreground">{labelText(fact.label)}</dt><dd className="break-words [overflow-wrap:anywhere]">{fact.value??"Unavailable"}{fact.unit?` ${fact.unit}`:""}{fact.period?<span className="block text-muted-foreground">{fact.period}</span>:null}{fact.enforced!==undefined?<span className="block text-muted-foreground">{fact.enforced===null?"Enforcement unknown":fact.enforced?"Enforced":"Not enforced"}</span>:null}</dd></div>)}</dl>{canOperate&&record.actions?.length?<div className="flex flex-wrap gap-2">{record.actions.map(action=><Button key={`${action.action}-${action.targetId}`} size="sm" variant="outline" disabled={Boolean(uncertainCommand)||(receipt?.targetId===action.targetId&&["pending","unknown","awaiting_approval"].includes(receipt.status))} onClick={()=>choose(action)}>{action.label}</Button>)}</div>:null}</article>)}</div>
   {section.nextCursor?<div className="border-t border-border p-3"><Button variant="outline" size="sm" onClick={()=>void more(section)}>Load more</Button></div>:null}
  </section>)}</div>
  <Dialog open={Boolean(selection)} onOpenChange={open=>{if(!open&&!actionBusy)setSelection(null);}}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{selection?.label??"Confirm action"}</DialogTitle></DialogHeader><p className="break-all text-xs text-muted-foreground">{products[product]} · {customerId}<br/>{selection?.targetId}</p>
   <label className="grid gap-2 text-sm">Reason<Textarea aria-label="Reason" maxLength={500} disabled={actionBusy||Boolean(preview)} value={reason} onChange={event=>setReason(event.target.value)} /></label>
   {preview?<p className="rounded-md bg-muted p-3 text-sm">{preview.impact}{!preview.eligible?` · ${preview.code??"Action unavailable"}`:""}</p>:null}
   {actionError?<p role="alert" className="text-sm text-status-danger">{actionError}</p>:null}
   <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={actionBusy} onClick={()=>setSelection(null)}>Close</Button>{preview?<><Button variant="outline" disabled={actionBusy} onClick={()=>{setPreview(null);setCommand(null);}}>Edit</Button><Button disabled={actionBusy||!preview.eligible} onClick={()=>void submit()}>{actionBusy?"Submitting...":"Confirm action"}</Button></>:<Button disabled={actionBusy||reason.trim().length<8} onClick={()=>void prepare()}>{actionBusy?"Checking...":"Review action"}</Button>}</div>
  </DialogContent></Dialog>
 </div>;
}
