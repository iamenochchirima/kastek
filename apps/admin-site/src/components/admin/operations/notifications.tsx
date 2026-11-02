"use client";

import Link from "next/link";
import { useCallback,useEffect,useState } from "react";
import { AdminPageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { OperationsNav,ReadState,StateBadge,dateText } from "./shared";

type Notice={id:string;title:string;message:string;severity:string;read_at:string|null;created_at:string;payload:{link?:string}|null};
async function notificationsRequest<T>(path:string,init?:RequestInit):Promise<T>{
 const response=await fetch(`/api/notifications${path}`,{...init,cache:"no-store"});const body=await response.json().catch(()=>({error:"Notifications unavailable"}));if(!response.ok)throw new Error(body.error??"Notifications unavailable");return body as T;
}
export function OperationsNotifications({role}:{role:string}) {
 const [items,setItems]=useState<Notice[]>([]),[unreadOnly,setUnreadOnly]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[revision,setRevision]=useState(0);
 const reload=useCallback(()=>setRevision(value=>value+1),[]);
 useEffect(()=>{const controller=new AbortController();setLoading(true);setError(null);void notificationsRequest<{notifications:Notice[]}>(`?limit=100&unreadOnly=${unreadOnly}`,{signal:controller.signal}).then(result=>{if(!controller.signal.aborted)setItems(result.notifications);}).catch(error=>{if(!controller.signal.aborted)setError(error instanceof Error?error.message:"Notifications unavailable");}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[unreadOnly,revision]);
 async function markRead(id?:string){setBusy(true);setError(null);try{await notificationsRequest(id?`/${encodeURIComponent(id)}`:"",{method:id?"PATCH":"POST",headers:{"content-type":"application/json"},body:"{}"});reload();}catch(error){setError(error instanceof Error?error.message:"Unable to mark notifications");}finally{setBusy(false);}}
 return <>
  <AdminPageHeader title="Notifications" actions={<><Button variant="secondary" disabled={loading||busy} onClick={reload}>Refresh</Button><Button variant="secondary" disabled={busy||loading||!items.some(item=>!item.read_at)} onClick={()=>void markRead()}>{busy?"Updating…":"Mark all read"}</Button></>}/><OperationsNav role={role}/>
  <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><label className="flex items-center gap-3 text-sm">Show<Select className="w-auto" value={unreadOnly?"unread":"all"} onChange={event=>setUnreadOnly(event.target.value==="unread")}><option value="all">All notifications</option><option value="unread">Unread</option></Select></label><span className="text-xs text-muted-foreground">Latest 100 notifications</span></div>
  <ReadState loading={loading} error={error} retry={reload}>{!items.length?<p className="py-8 text-sm text-muted-foreground">No notifications</p>:<div className="divide-y divide-border rounded-md border border-border">{items.map(item=>{const link=item.payload?.link,validLink=link&&/^\/operations\/incidents\/[0-9a-f-]{36}$/i.test(link);return <article key={item.id} className={`p-4 ${item.read_at?"":"bg-secondary/30"}`}><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-2"><StateBadge value={item.severity.toLowerCase()}/><h2 className="break-words text-sm font-medium">{item.title}</h2>{!item.read_at?<span className="text-xs text-primary">Unread</span>:null}</div><time className="text-xs text-muted-foreground" dateTime={item.created_at}>{dateText(item.created_at)}</time></div><p className="mt-2 break-words text-sm text-muted-foreground">{item.message}</p><div className="mt-3 flex flex-wrap items-center gap-3">{validLink?<Link href={link} className="text-sm text-primary hover:underline">Open incident</Link>:null}{!item.read_at?<Button variant="ghost" size="sm" disabled={busy} onClick={()=>void markRead(item.id)}>Mark read</Button>:null}</div></article>;})}</div>}</ReadState>
 </>;
}
