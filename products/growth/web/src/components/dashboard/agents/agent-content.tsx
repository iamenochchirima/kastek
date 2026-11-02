import { AgentMessageContent } from "@kasitek-labs/ui/agent";
import { safeGrowthRoute, type GrowthAgentSource } from "@/lib/growth-agents";
import { safeSourceLink, sourceCitations } from "@/lib/growth-agent-sources";

export function AgentSources({ sources }: { sources: GrowthAgentSource[] }) {
  if (!sources.length) return null;
  return <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">Sources · {sources.length}</summary><ol className="mt-2 list-decimal space-y-2 pl-5">{sources.map((source) => { const href = safeSourceLink(source); return <li key={source.id}>{href ? <a href={href} target={href.startsWith("/") ? undefined : "_blank"} rel="noreferrer" className="text-primary underline underline-offset-2">{source.title}</a> : <span className="text-muted-foreground">{source.title}</span>}</li>; })}</ol></details>;
}
export function GrowthAgentMarkdown({ text, sources = [] }: { text: string; sources?: GrowthAgentSource[] }) {
  return <AgentMessageContent text={text} remarkPlugins={[sourceCitations(sources)]} resolveLink={href => {
    const route = safeGrowthRoute(href); if (route) return route;
    try { const url = new URL(href); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
  }} />;
}
