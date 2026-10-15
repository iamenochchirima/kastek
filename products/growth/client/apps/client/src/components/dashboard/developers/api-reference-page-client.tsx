"use client";

import Link from "next/link";
import { useState } from "react";
import { Braces, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { useDevelopersData } from "./developers-data";

type Example = "curl" | "javascript" | "python";

function copy(value: string) {
  void navigator.clipboard?.writeText(value);
}

export function ApiReferencePageClient() {
  const { config } = useDevelopersData();
  const [example, setExample] = useState<Example>("curl");
  const examples: Record<Example, string> = {
    curl: `curl ${config.restBaseUrl}/capabilities \\\n+  -H "Authorization: Bearer <developer-api-key>"`,
    javascript: `const response = await fetch("${config.restBaseUrl}/capabilities", {\n  headers: { Authorization: "Bearer <developer-api-key>" },\n});\nconst capabilities = await response.json();`,
    python: `import requests\n\nresponse = requests.get(\n    "${config.restBaseUrl}/capabilities",\n    headers={"Authorization": "Bearer <developer-api-key>"},\n)\nprint(response.json())`,
  };

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader><PageHeaderContent><PageHeaderTitle>API</PageHeaderTitle><PageHeaderDescription>REST API reference.</PageHeaderDescription></PageHeaderContent></PageHeader>
        <MotionReveal>
          <Card><CardContent className="space-y-5 p-5"><div className="flex items-start gap-3"><Braces className="mt-0.5 h-5 w-5 text-muted-foreground" /><div><h2 className="text-base font-semibold">List capabilities</h2><p className="mt-1 text-sm text-muted-foreground">Replace the placeholder with a key created in API Keys.</p></div></div><div className="flex gap-5 overflow-x-auto border-b border-border" role="tablist" aria-label="API examples">{(["curl", "javascript", "python"] as Example[]).map((id) => <button key={id} type="button" role="tab" aria-selected={example === id} onClick={() => setExample(id)} className={`min-h-10 shrink-0 border-b-2 px-1 py-3 text-sm font-medium capitalize ${example === id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{id === "curl" ? "cURL" : id}</button>)}</div><div className="flex gap-2"><pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-secondary/50 p-4 text-xs leading-6 text-foreground">{examples[example]}</pre><Button type="button" variant="outline" size="icon-sm" onClick={() => copy(examples[example])} aria-label="Copy API example"><Copy className="h-3.5 w-3.5" /></Button></div></CardContent></Card>
        </MotionReveal>
        <MotionReveal delay={0.08} className="grid gap-3 md:grid-cols-3"><ApiTopic title="Accounts and resources" body="Provider account identity remains in Connections. Use the resource references returned by the API." /><ApiTopic title="Errors and retries" body="Use stable error codes, correlation IDs, and idempotency keys for safe mutation retries." /><ApiTopic title="OpenAPI" body="The core-owned OpenAPI document describes the public v1 contract and supported principals." /></MotionReveal>
        <MotionReveal delay={0.16} className="flex flex-wrap gap-2"><Button asChild><Link href="/developers/api-keys">Create API key <ExternalLink className="ml-2 h-3.5 w-3.5" /></Link></Button><Button asChild variant="outline"><Link href="/developers/resources">View resources <ExternalLink className="ml-2 h-3.5 w-3.5" /></Link></Button></MotionReveal>
      </div>
    </div>
  );
}

function ApiTopic({ title, body }: { title: string; body: string }) {
  return <Card className="gap-2"><CardContent className="p-5"><h2 className="text-sm font-semibold">{title}</h2><p className="mt-2 text-sm leading-5 text-muted-foreground">{body}</p></CardContent></Card>;
}
