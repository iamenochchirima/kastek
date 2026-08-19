"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Copy, ExternalLink, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useDevelopersData } from "./developers-data";

type ClientId = "claude" | "chatgpt" | "claude-code" | "cursor" | "other";

const clients: Record<ClientId, { label: string; body: string; local: boolean }> = {
  claude: { label: "Claude", body: "Open Settings → Connectors, choose Add custom connector, paste the endpoint, and approve the connection.", local: false },
  chatgpt: { label: "ChatGPT", body: "Open the connector or MCP settings, add the endpoint, and complete the approval step before testing a safe read.", local: false },
  "claude-code": { label: "Claude Code", body: "Use the local adapter when Claude Code needs a command-launched server. Keep your Developer API key in the client environment.", local: true },
  cursor: { label: "Cursor", body: "Use a remote MCP server when supported, or configure the local adapter as a command-based server.", local: false },
  other: { label: "Other MCP client", body: "Use the hosted Streamable HTTP endpoint or the local stdio adapter, depending on what your client supports.", local: false },
};

function copy(value: string) {
  void navigator.clipboard?.writeText(value);
}

export function McpPageClient() {
  const { config } = useDevelopersData();
  const [selected, setSelected] = useState<ClientId>("claude");
  const client = clients[selected];
  const localSetup = `export KASITEK_MCP_URL="${config.mcpEndpoint}"\nexport KASITEK_API_KEY="<developer-api-key>"\nnpx -y ${config.mcpPackage}`;

  return (
    <div className="p-5 lg:p-8">
      <div className="mx-auto max-w-[1080px] space-y-7">
        <header>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">MCP Server</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Connect an AI agent</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Use the KasiTek MCP endpoint with Claude, ChatGPT, Cursor, Claude Code, or another compatible client. MCP and REST use the same Developer API key, while capabilities and approvals control what the client can do.</p>
        </header>

        <Card>
          <CardContent className="space-y-5 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-semibold">Choose your client</h2><p className="mt-1 text-sm text-muted-foreground">Each path uses the same endpoint, API key, and capability policy.</p></div><Button asChild variant="outline"><Link href="/developers/api-keys"><KeyRound className="mr-2 h-4 w-4" />Create API key</Link></Button></div>
            <div className="flex gap-5 overflow-x-auto border-b border-border" role="tablist" aria-label="MCP clients">{(Object.keys(clients) as ClientId[]).map((id) => <button key={id} type="button" role="tab" aria-selected={selected === id} onClick={() => setSelected(id)} className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium ${selected === id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{clients[id].label}</button>)}</div>
            <p className="text-sm leading-6 text-foreground">{client.body}</p>
            <div className="rounded-lg border border-border bg-secondary/30 p-4"><p className="text-xs font-medium text-muted-foreground">MCP endpoint</p><div className="mt-2 flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-background px-3 py-2 text-xs text-foreground">{config.mcpEndpoint}</code><Button type="button" variant="outline" size="icon-sm" onClick={() => copy(config.mcpEndpoint)} aria-label="Copy MCP endpoint"><Copy className="h-3.5 w-3.5" /></Button></div></div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Check className="h-4 w-4 text-primary" />Use the same Developer API key for MCP and REST. Keep it in the client environment or secret settings.</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 p-5"><div><h2 className="text-base font-semibold">Local stdio setup</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Use this only when the client requires a local command-launched MCP server. Create one Developer API key, set it in the client environment, and let the package forward MCP messages.</p></div><pre className="overflow-x-auto rounded-lg bg-secondary/50 p-4 text-xs leading-6 text-foreground">{localSetup}</pre><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => copy(localSetup)}><Copy className="mr-2 h-3.5 w-3.5" />Copy setup</Button><Button asChild variant="ghost"><Link href="/developers/cli">View CLI setup <ExternalLink className="ml-2 h-3.5 w-3.5" /></Link></Button></div></CardContent>
        </Card>
      </div>
    </div>
  );
}
