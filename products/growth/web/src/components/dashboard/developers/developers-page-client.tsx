"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Check, Code2, Copy, KeyRound, Plug, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { useDevelopersData } from "./developers-data";

type ClientId = "claude" | "chatgpt" | "claude-code" | "cursor" | "other";

const clientCopy: Record<ClientId, {
  title: string;
  description: string;
  steps: string[];
  prompt: string;
  hosted: boolean;
}> = {
  claude: {
    title: "Claude",
    description: "Use Claude’s custom connector flow for a hosted MCP connection.",
    steps: [
      "Open Settings → Connectors and choose Add custom connector.",
      "Paste the KasiTek MCP endpoint and connect the external installation.",
      "Approve the connection, then ask Claude to discover available tools.",
    ],
    prompt: "Connect to KasiTek, discover the available tools, and use safe reads first. Ask before any consequential write.",
    hosted: true,
  },
  chatgpt: {
    title: "ChatGPT",
    description: "Add the hosted MCP endpoint in ChatGPT when custom connectors are available.",
    steps: [
      "Open the connector or MCP settings in ChatGPT.",
      "Add the KasiTek MCP endpoint and complete the sign-in or approval step.",
      "Test the connection with a safe read before using a write capability.",
    ],
    prompt: "Connect to KasiTek, list the available tools, and perform a safe read. Ask before consequential writes.",
    hosted: true,
  },
  "claude-code": {
    title: "Claude Code",
    description: "Use the local stdio adapter when Claude Code needs a command-launched MCP server.",
    steps: [
      "Create a Developer API key and copy it once.",
      "Set KASITEK_MCP_URL and KASITEK_API_KEY in the client environment.",
      "Run the KasiTek MCP adapter and ask Claude Code to discover tools.",
    ],
    prompt: "Use the KasiTek MCP server. Discover tools first, perform safe reads, and ask before consequential writes.",
    hosted: false,
  },
  cursor: {
    title: "Cursor",
    description: "Use the hosted MCP endpoint or the local adapter for a command-based setup.",
    steps: [
      "Open Cursor’s MCP settings and choose a remote or command-based server.",
      "Use the endpoint for remote MCP, or configure the local adapter environment.",
      "Test discovery with a safe read before enabling consequential operations.",
    ],
    prompt: "Use KasiTek MCP for workspace data. Discover tools first, perform safe reads, and ask before consequential writes.",
    hosted: true,
  },
  other: {
    title: "Other MCP client",
    description: "Use the hosted Streamable HTTP endpoint or configure the local stdio adapter.",
    steps: [
      "Choose whether your client supports remote Streamable HTTP or local stdio.",
      "Configure the KasiTek endpoint and your Developer API key as a Bearer credential.",
      "Run discovery, then begin with a safe read.",
    ],
    prompt: "Use KasiTek MCP. Discover tools first, perform safe reads, and ask before consequential writes.",
    hosted: true,
  },
};

function copy(value: string) {
  void navigator.clipboard?.writeText(value);
}

export function DevelopersPageClient() {
  const { config } = useDevelopersData();
  const [selectedClient, setSelectedClient] = useState<ClientId>("claude");
  const selected = clientCopy[selectedClient];

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader><PageHeaderContent><PageHeaderTitle>Developers</PageHeaderTitle><PageHeaderDescription>API, MCP, and CLI setup.</PageHeaderDescription></PageHeaderContent></PageHeader>
        <MotionReveal>
          <h2 className="text-lg font-semibold text-foreground">Choose a path</h2>
          <p className="mt-1 text-sm text-muted-foreground">Post from Claude, ChatGPT, your own code, or the terminal. Pick a path:</p>

          <div className="mt-4 grid gap-3 overflow-x-auto lg:grid-cols-3">
            <Link href="/developers/mcp" className="group rounded-xl border-2 border-primary/20 bg-card p-5 transition-colors hover:border-primary/50">
              <Plug className="h-5 w-5 text-foreground" />
              <h2 className="mt-4 text-base font-semibold">Connect an AI agent</h2>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">Claude, ChatGPT, Cursor, or another MCP client. Connect once, then use plain language.</p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-foreground">2 minutes <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
            </Link>
            <Link href="/developers/api" className="group rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/40">
              <Code2 className="h-5 w-5 text-muted-foreground" />
              <h2 className="mt-4 text-base font-semibold">Build with the API or SDK</h2>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">Schedule and publish from your own code using the public REST API.</p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-foreground">Create a key <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
            </Link>
            <Link href="/developers/cli" className="group rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/40">
              <Terminal className="h-5 w-5 text-muted-foreground" />
              <h2 className="mt-4 text-base font-semibold">Use the command line</h2>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">Run the local MCP adapter or use cURL from your terminal and scripts.</p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-foreground">CLI setup <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
            </Link>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">1. Create a Developer API key&nbsp;&nbsp; 2. Choose your client&nbsp;&nbsp; 3. Test a safe request</p>
        </MotionReveal>

        <MotionReveal delay={0.08}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Connect an AI agent</h2>
            <Badge variant="secondary">For AI agents</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Let Claude, ChatGPT, or another MCP-compatible assistant connect once and work in plain English.</p>

          <div className="mt-4 rounded-xl border border-border bg-card">
            <div className="flex gap-6 overflow-x-auto border-b border-border px-4 pt-1" role="tablist" aria-label="AI clients">
              {(Object.keys(clientCopy) as ClientId[]).map((clientId) => (
                <button
                  key={clientId}
                  type="button"
                  role="tab"
                  aria-selected={selectedClient === clientId}
                  onClick={() => setSelectedClient(clientId)}
                  className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors ${selectedClient === clientId ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                >
                  {clientCopy[clientId].title}
                </button>
              ))}
            </div>

            <div className="space-y-5 p-4 lg:p-5">
              <p className="text-sm text-muted-foreground">{selected.description}</p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground"><Check className="h-4 w-4 text-primary" />Use the same Developer API key for MCP and REST. Capabilities and approvals determine the available actions.</div>
              <div className="space-y-3">
                {selected.steps.map((step, index) => (
                  <div key={step} className="flex gap-3 text-sm">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-xs text-muted-foreground">{index + 1}</span>
                    <span className="pt-0.5 text-foreground">{step}</span>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-border bg-secondary/30 p-3">
                <p className="text-xs font-medium text-muted-foreground">MCP endpoint</p>
                <div className="mt-2 flex gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-background px-3 py-2 text-xs text-foreground">{config.mcpEndpoint}</code>
                  <Button type="button" variant="outline" size="icon-sm" onClick={() => copy(config.mcpEndpoint)} aria-label="Copy MCP endpoint"><Copy className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                <p className="text-sm italic text-muted-foreground">Then ask {selected.title}: “{selected.prompt}”</p>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => copy(selected.prompt)}><Copy className="mr-1.5 h-3.5 w-3.5" />Copy prompt</Button>
                  <Button asChild size="sm"><Link href="/developers/api-keys"><KeyRound className="mr-1.5 h-3.5 w-3.5" />Create API key</Link></Button>
                </div>
              </div>
            </div>
          </div>
        </MotionReveal>

        <MotionReveal delay={0.16} className="grid gap-3 md:grid-cols-2">
          <Card className="gap-3" data-motion-card>
            <CardContent className="flex items-start gap-3 p-5"><KeyRound className="mt-0.5 h-5 w-5 text-muted-foreground" /><div><h2 className="text-sm font-semibold">Developer API keys</h2><p className="mt-1 text-sm leading-5 text-muted-foreground">Use one workspace API key for REST, MCP, scripts, and local AI clients. Capabilities and approvals still apply.</p><Link href="/developers/api-keys" className="mt-3 inline-flex text-sm font-medium text-foreground underline-offset-4 hover:underline">Manage API keys <ArrowRight className="ml-1.5 h-3.5 w-3.5" /></Link></div></CardContent>
          </Card>
          <Card className="gap-3" data-motion-card>
            <CardContent className="flex items-start gap-3 p-5"><Code2 className="mt-0.5 h-5 w-5 text-muted-foreground" /><div><h2 className="text-sm font-semibold">Connected accounts</h2><p className="mt-1 text-sm leading-5 text-muted-foreground">Provider accounts and account identifiers are managed in Connections, not duplicated here.</p><Link href="/connections" className="mt-3 inline-flex text-sm font-medium text-foreground underline-offset-4 hover:underline">Open Connections <ArrowRight className="ml-1.5 h-3.5 w-3.5" /></Link></div></CardContent>
          </Card>
        </MotionReveal>
      </div>
    </div>
  );
}
