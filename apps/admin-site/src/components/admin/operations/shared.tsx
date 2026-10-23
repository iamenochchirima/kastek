"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export const sourceNames: Record<string,string> = {growth:"Growth",agents:"Agents",agency:"Agency",analytics:"Analytics",operations:"Operations"};
export const humanize = (value:string) => value.replaceAll("_"," ").replaceAll("."," ");
export const dateText = (value:string|null|undefined) => value ? new Date(value).toLocaleString() : "Unknown";
export async function readOperations<T>(path:string,init?:RequestInit):Promise<T> {
  const response = await fetch(`/api/operations-centre/${path}`,{...init,cache:"no-store"});
  const body = await response.json().catch(()=>({error:"Operations unavailable"}));
  if(!response.ok)throw Object.assign(new Error(body.error??"Operations unavailable"),{status:response.status});
  return body as T;
}
export function useOperationsRead<T>(path:string) {
  const [data,setData]=useState<T|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  const reload=useCallback(()=>setRevision(value=>value+1),[]);
  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true);setError(null);setData(null);
    void readOperations<T>(path,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setData(value);}).catch(error=>{if(!controller.signal.aborted)setError(error instanceof Error?error.message:"Operations unavailable");}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[path,revision]);
  return {data,error,loading,reload};
}
export function useOperationsClock() {
  const [now,setNow]=useState(0);
  useEffect(()=>{setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),15_000);return()=>clearInterval(timer);},[]);
  return now;
}
export function OperationsNav({role}:{role:string}) {
  const pathname=usePathname(),security=["security","owner","superadmin"].includes(role);
  const links=[["/operations","Incidents"],["/operations/settings","Monitoring"],["/operations/notifications","Notifications"],...(security?[["/operations/audit","Audit"]]:[])];
  return <nav aria-label="Operations sections" className="mb-5 flex flex-wrap gap-1 border-b border-border">{links.map(([href,label])=><Link key={href} href={href} aria-current={pathname===href?"page":undefined} className={`border-b-2 px-3 py-3 text-sm ${pathname===href?"border-primary font-medium text-foreground":"border-transparent text-muted-foreground hover:text-foreground"}`}>{label}</Link>)}</nav>;
}
export function StateBadge({value}:{value:string}) {
  const variant=["critical","breached","unavailable","stale"].includes(value)?"danger":["healthy","resolved","available"].includes(value)?"success":["warning","open","acknowledged"].includes(value)?"attention":"outline";
  return <Badge variant={variant}>{humanize(value)}</Badge>;
}
export function ReadState({loading,error,retry,children}:{loading:boolean;error:string|null;retry:()=>void;children:ReactNode}) {
  if(loading)return <div role="status" aria-label="Loading" className="space-y-3 py-5"><Skeleton className="h-12 w-full"/><Skeleton className="h-12 w-full"/><Skeleton className="h-12 w-3/4"/></div>;
  if(error)return <div role="alert" className="flex flex-wrap items-center gap-3 py-5 text-sm"><span>{error}</span><Button variant="secondary" size="sm" onClick={retry}>Retry</Button></div>;
  return <>{children}</>;
}

type PendingCommand={path:string;method:string;body:Record<string,unknown>};
export function useOperationsCommand(actorId:string,onSuccess:()=>void) {
  const storageKey=`operations-pending:${actorId}`;
  const pending=useRef<PendingCommand|null>(null),success=useRef(onSuccess);
  useEffect(()=>{success.current=onSuccess;},[onSuccess]);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[uncertain,setUncertain]=useState(false);
  useEffect(()=>{try{const raw=sessionStorage.getItem(storageKey);if(raw){const value=JSON.parse(raw);if(typeof value.path==="string"&&typeof value.method==="string"&&value.body&&typeof value.body.operationId==="string"){pending.current=value;setUncertain(true);setError("Previous request needs confirmation.");}}}catch{/* Storage may be unavailable. */}},[storageKey]);
  async function run(command:PendingCommand) {
    setBusy(true);setError(null);
    try{
      await readOperations(command.path,{method:command.method,headers:{"content-type":"application/json"},body:JSON.stringify(command.body)});
      pending.current=null;setUncertain(false);try{sessionStorage.removeItem(storageKey);}catch{}
      success.current();return true;
    }catch(error){
      const status=(error as {status?:number}).status;
      if(status&&status<500){pending.current=null;setUncertain(false);try{sessionStorage.removeItem(storageKey);}catch{}}
      else setUncertain(true);
      setError(error instanceof Error?error.message:"Request status unknown");return false;
    }finally{setBusy(false);}
  }
  async function submit(path:string,method:string,body:Record<string,unknown>) {
    if(busy||pending.current){setError("Confirm the previous request before another change.");return false;}
    const command={path,method,body:{...body,operationId:crypto.randomUUID()}};pending.current=command;
    try{sessionStorage.setItem(storageKey,JSON.stringify(command));}catch{}
    return run(command);
  }
  return {busy,error,uncertain,submit,retry:()=>pending.current?run(pending.current):Promise.resolve(false)};
}
export function CommandStatus({command}:{command:ReturnType<typeof useOperationsCommand>}) {
  return command.error?<div role="alert" className="my-3 flex flex-wrap items-center gap-3 text-sm text-destructive"><span>{command.error}</span>{command.uncertain?<Button size="sm" variant="secondary" disabled={command.busy} onClick={()=>void command.retry()}>{command.busy?"Checking…":"Retry previous request"}</Button>:null}</div>:null;
}
