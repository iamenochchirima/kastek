import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { PageHeader, PageHeaderContent, PageHeaderTitle } from "@/components/ui/page-header";
import { oauthPermissionLabels } from "./oauth-consent";

type Connection = {id:string;clientName:string;scopes:string[];revokedAt:string|null;createdAt:string;accessExpiresAt:string};
type DeveloperConfig = {mcpAvailable:boolean;mcpEndpoint:string|null;mcpOAuth:unknown;restBaseUrl:string};

export function McpPageClient() {
  const [config,setConfig]=useState<DeveloperConfig|null>(null);
  const [connections,setConnections]=useState<Connection[]>([]);
  const [connectionsLoaded,setConnectionsLoaded]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [target,setTarget]=useState<Connection|null>(null);
  const [revoking,setRevoking]=useState(false);
  const revokeTrigger=useRef<HTMLButtonElement|null>(null);
  const connectionsHeading=useRef<HTMLHeadingElement|null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [settings,list]=await Promise.all([fetch("/api/developers",{credentials:"include",cache:"no-store",signal:controller.signal}),fetch("/api/oauth/connections",{credentials:"include",cache:"no-store",signal:controller.signal})]);
        if(!settings.ok)throw new Error(settings.status === 403 ? "You do not have access to developer settings." : "Could not load MCP settings");
        const payload=await settings.json() as {config:DeveloperConfig};setConfig(payload.config);
        if(!list.ok)throw new Error("Could not load agent connections");
        setConnections(((await list.json()) as {connections:Connection[]}).connections);
        setConnectionsLoaded(true);
      } catch(caught) { if(!controller.signal.aborted)setError(caught instanceof Error?caught.message:"Could not load MCP settings"); }
      finally { if(!controller.signal.aborted)setLoading(false); }
    })();
    return () => controller.abort();
  },[]);
  async function revoke() {
    if(!target||revoking)return;
    setRevoking(true);
    try {
      const response=await fetch(`/api/oauth/connections/${encodeURIComponent(target.id)}`,{method:"DELETE",credentials:"include"});
      if(!response.ok)throw new Error("Could not revoke access");
      setConnections(current=>current.map(connection=>connection.id===target.id?{...connection,revokedAt:new Date().toISOString()}:connection));
      setTarget(null);toast.success("Access revoked");
    } catch(caught) { toast.error(caught instanceof Error?caught.message:"Could not revoke access"); }
    finally {setRevoking(false);}
  }
  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader><PageHeaderContent><PageHeaderTitle>MCP</PageHeaderTitle></PageHeaderContent></PageHeader>
        {loading ? <div aria-label="Loading MCP settings" className="space-y-4"><Skeleton className="h-32 w-full" /><Skeleton className="h-48 w-full" /></div> : <>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">{config?.mcpAvailable ? "Agent connection" : "MCP unavailable"}</h2>{config?.mcpAvailable ? <Badge variant="secondary">OAuth</Badge> : null}</div>
            {config?.mcpAvailable && config.mcpEndpoint ? <><p className="text-sm text-muted-foreground">Add this server in your agent, then sign in to Growth.</p><div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center"><code className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 text-xs">{config.mcpEndpoint}</code><Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(config.mcpEndpoint!).then(()=>toast.success("Endpoint copied"),()=>toast.error("Could not copy endpoint"))}>Copy endpoint</Button></div></> : <p className="text-sm text-muted-foreground">Use the REST API with a Developer API key.</p>}
            <Button asChild variant="outline"><Link to="/developers/api">View API</Link></Button>
          </CardContent>
        </Card>
        <section className="space-y-3"><h2 ref={connectionsHeading} tabIndex={-1} className="text-base font-semibold">Connected agents</h2>{!connectionsLoaded ? <p className="text-sm text-muted-foreground">Connections unavailable</p> : connections.length ? <div className="divide-y divide-border rounded-lg border border-border">{connections.map(connection=><div key={connection.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="break-words text-sm font-medium">{connection.clientName}</p><Badge variant="secondary">{connection.revokedAt?"Revoked":"Active"}</Badge></div><p className="mt-1 break-words text-xs text-muted-foreground">{connection.scopes.map(scope=>oauthPermissionLabels[scope]??scope).join(" · ")}</p></div>{!connection.revokedAt?<Button type="button" variant="outline" size="sm" className="self-start sm:self-auto" onClick={event=>{revokeTrigger.current=event.currentTarget;setTarget(connection);}}>Revoke access</Button>:null}</div>)}</div>:<p className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">No connected agents</p>}</section>
        </>}
      </div>
      <Dialog open={Boolean(target)} onOpenChange={open=>{if(!open&&!revoking)setTarget(null);}}><DialogContent onCloseAutoFocus={event=>{event.preventDefault();if(revokeTrigger.current?.isConnected)revokeTrigger.current.focus();else connectionsHeading.current?.focus();}}><DialogHeader><DialogTitle>Revoke access?</DialogTitle><DialogDescription>{target?.clientName} will lose access to this workspace.</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" disabled={revoking} onClick={()=>setTarget(null)}>Cancel</Button><Button type="button" variant="destructive" disabled={revoking} onClick={()=>void revoke()}>{revoking?"Revoking…":"Revoke access"}</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}
