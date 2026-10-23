"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Link2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { contextLabel, safeGrowthRoute, type GrowthAgentContext, type GrowthAgentFeatureId } from "@/lib/growth-agents";
import { useGrowthAgents } from "./agent-provider";

export function pageAgentContext(pathname: string): GrowthAgentContext {
  const campaign = /^\/campaigns\/([^/]+)$/.exec(pathname);
  if (campaign && campaign[1] !== "create") return { kind: "whatsapp_campaign", resourceId: decodeURIComponent(campaign[1]) };
  const post = /^\/content\/posts\/([^/]+)$/.exec(pathname);
  if (post) return { kind: "content_post", resourceId: decodeURIComponent(post[1]) };
  return { kind: "workspace" };
}

export function ContextControl() {
  const agents = useGrowthAgents();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const candidate = useMemo(() => pageAgentContext(pathname), [pathname]);
  const context = agents.conversation?.context;
  const display = agents.conversation?.contextDisplay;
  const contextRoute = safeGrowthRoute(display?.route);
  const change = async (next: GrowthAgentContext | null) => {
    setBusy(true);
    try {
      const conversationId = await agents.attachContext(next);
      if (!conversationId) return;
      setOpen(false);
      // Context changes create a separate conversation. Preserve the old history.
      if (pathname.startsWith("/agents/conversations/")) router.push(`/agents/conversations/${encodeURIComponent(conversationId)}`);
    } finally { setBusy(false); }
  };
  return <>
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
      <span className="truncate text-muted-foreground">{agents.businessName}</span>
      {context ? <span className="inline-flex min-h-7 max-w-full items-center gap-1 rounded-md bg-secondary px-2 text-foreground"><Link2 className="size-3 shrink-0" aria-hidden="true" />{contextRoute ? <a href={contextRoute} className="truncate underline underline-offset-2">{display?.title || contextLabel(context)}</a> : <span className="truncate">{display?.title || contextLabel(context)}</span>}<button type="button" className="ml-1 grid size-6 place-items-center rounded hover:bg-background disabled:opacity-50" aria-label="Remove context" disabled={busy || agents.sending} onClick={() => setOpen(true)}><X className="size-3" /></button></span> : null}
      <Button type="button" variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" disabled={!agents.conversation || agents.sending} onClick={() => setOpen(true)}>{context ? "Change context" : "Attach context"}</Button>
    </div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Conversation context</DialogTitle><DialogDescription>Changing context starts a new conversation. Your current conversation stays in history.</DialogDescription></DialogHeader>
      <div className="space-y-2"><Button type="button" variant="outline" className="w-full justify-start" disabled={busy} onClick={() => void change(candidate)}>Use {candidate.kind === "workspace" ? agents.businessName : contextLabel(candidate)}</Button>{candidate.kind !== "workspace" ? <Button type="button" variant="outline" className="w-full justify-start" disabled={busy} onClick={() => void change({ kind: "workspace" })}>Use {agents.businessName}</Button> : null}{context ? <Button type="button" variant="ghost" className="w-full justify-start" disabled={busy} onClick={() => void change(null)}>Start without context</Button> : null}</div>
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}

export function AskGrowthAgent({ featureId = "assistant", context, children = "Ask agent", className }: { featureId?: GrowthAgentFeatureId; context: GrowthAgentContext; children?: React.ReactNode; className?: string }) {
  const agents = useGrowthAgents();
  return <Button type="button" variant="outline" className={className} disabled={agents.loading} onClick={() => void agents.start(featureId, context)}><Sparkles className="mr-2 size-4" aria-hidden="true" />{children}</Button>;
}
