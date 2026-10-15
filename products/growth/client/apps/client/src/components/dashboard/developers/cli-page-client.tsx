"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Copy, ExternalLink, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { useDevelopersData } from "./developers-data";

function copy(value: string) {
  void navigator.clipboard?.writeText(value);
}

export function CliPageClient() {
  const { config } = useDevelopersData();
  const [copied, setCopied] = useState(false);
  const setup = `export KASITEK_MCP_URL="${config.mcpEndpoint}"\nexport KASITEK_API_KEY="<developer-api-key>"\nnpx -y ${config.mcpPackage}`;

  function copySetup() {
    copy(setup);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader><PageHeaderContent><PageHeaderTitle>CLI</PageHeaderTitle><PageHeaderDescription>Terminal setup.</PageHeaderDescription></PageHeaderContent></PageHeader>
        <MotionReveal>
          <Card><CardContent className="space-y-5 p-5"><div className="flex items-start gap-3"><Terminal className="mt-0.5 h-5 w-5 text-muted-foreground" /><div><h2 className="text-base font-semibold">Local MCP adapter</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Create one Developer API key and set it in the client environment. The adapter forwards JSON-RPC to KasiTek; it does not contain business tools or workspace data.</p></div></div><div className="rounded-lg border border-status-attention/30 bg-status-attention-soft p-3 text-sm text-muted-foreground"><Check className="mr-2 inline h-4 w-4 text-status-attention" />The package is buildable locally. Public package publication is still pending.</div><pre className="overflow-x-auto rounded-lg bg-secondary/50 p-4 text-xs leading-6 text-foreground">{setup}</pre><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={copySetup}><Copy className="mr-2 h-3.5 w-3.5" />{copied ? "Copied" : "Copy setup"}</Button><Button asChild variant="outline"><Link href="/developers/api-keys">Create API key <ExternalLink className="ml-2 h-3.5 w-3.5" /></Link></Button><Button asChild variant="ghost"><Link href="/developers/mcp">View MCP setup <ExternalLink className="ml-2 h-3.5 w-3.5" /></Link></Button></div></CardContent></Card>
        </MotionReveal>
        <MotionReveal delay={0.08}>
          <Card><CardContent className="space-y-4 p-5"><div><h2 className="text-base font-semibold">REST from the terminal</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Use the same Developer API key as your MCP client. Keep it in an environment variable or secret manager.</p></div><pre className="overflow-x-auto rounded-lg bg-secondary/50 p-4 text-xs leading-6 text-foreground">{`export KASITEK_API_KEY="<developer-api-key>"\ncurl ${config.restBaseUrl}/capabilities \\\n  -H "Authorization: Bearer $KASITEK_API_KEY"`}</pre><Button asChild variant="outline"><Link href="/developers/api-keys">Create an API key <ExternalLink className="ml-2 h-3.5 w-3.5" /></Link></Button></CardContent></Card>
        </MotionReveal>
      </div>
    </div>
  );
}
