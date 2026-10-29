import { useEffect, useRef, useState } from "react";
import { api, message, organizationPath } from "./api";
import { Button } from "@/components/ui/button";

type Presence = { state:"available"|"away"|"unknown"; expiresAt:string|null; leaseId?:string };
export function InboxPresence({ organizationId }: { organizationId:string }) {
  const path=`${organizationPath(organizationId)}/inbox-presence`;
  const [state,setState]=useState<Presence["state"]>("unknown"),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const lease=useRef<string|null>(null);
  useEffect(()=>{
    let live=true;
    void api<Presence>(path).then(value=>{if(live)setState(value.state);}).catch(e=>{if(live)setError(message(e));});
    const timer=window.setInterval(()=>{
      if(!live||document.visibilityState!=="visible")return;
      if(!lease.current){void api<Presence>(path).then(value=>{if(live&&!lease.current)setState(value.state);}).catch(e=>{if(live)setError(message(e));});return;}
      const current=lease.current;
      void api<Presence>(`${path}/renew`,{leaseId:current}).then(value=>{if(live&&lease.current===current)setState(value.state);}).catch(e=>{
        if(live&&lease.current===current){lease.current=null;setState("unknown");setError(message(e));}
      });
    },30000);
    return()=>{live=false;lease.current=null;window.clearInterval(timer);};
  },[path]);
  async function select(next:"available"|"away") {
    setBusy(true);setError("");
    try {const value=await api<Presence>(path,{state:next});lease.current=next==="available"?value.leaseId??null:null;setState(value.state);}
    catch(e){setError(message(e));} finally {setBusy(false);}
  }
  return <div className="flex flex-wrap items-center gap-2 my-3 px-4" aria-label="Your availability">
    <span className="text-xs text-muted-foreground">{state === "unknown" ? "Availability unknown" : state === "available" ? "Available" : "Away"}</span>
    <Button size="sm" variant={state==="available"?"secondary":"outline"} disabled={busy} onClick={()=>void select("available")}>Available</Button>
    <Button size="sm" variant={state==="away"?"secondary":"outline"} disabled={busy} onClick={()=>void select("away")}>Away</Button>
    {error?<span role="alert" className="text-xs text-destructive">{error}</span>:null}
  </div>;
}
