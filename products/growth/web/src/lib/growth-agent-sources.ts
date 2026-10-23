import type { GrowthAgentSource } from "@kasitek-labs/contracts";

export function safeGrowthRoute(route: string | undefined): string | null {
  if (!route || !route.startsWith("/") || route.startsWith("//") || /[\\\u0000-\u001f]/.test(route)) return null;
  try {
    const url = new URL(route, "https://growth.invalid");
    if (url.origin !== "https://growth.invalid") return null;
    const artifactDownload = /^\/api\/agents\/tasks\/[0-9a-f-]{36}\/artifacts\/[0-9a-f-]{36}\/download$/i.test(url.pathname);
    if (!artifactDownload && !/^\/(agents|campaigns|content|analytics|workspace|connections|inbox)(\/|$)/.test(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}
export function safeSourceLink(source: GrowthAgentSource): string | null {
  const route = safeGrowthRoute(source.route);
  if (route) return route;
  if (!source.url) return null;
  try {
    const url = new URL(source.url);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
type CitationPart = { kind: "text"; text: string } | { kind: "source"; number: number; title: string; href: string | null };
export function sourceCitationParts(text: string, sources: GrowthAgentSource[]): CitationPart[] {
  const labels = new Map<string, { source: GrowthAgentSource; number: number }[]>();
  sources.forEach((source, index) => {
    if (!source.citationLabel) return;
    const matching = labels.get(source.citationLabel) ?? [];
    if (!matching.some(item => item.source.id === source.id)) matching.push({ source, number: index + 1 });
    labels.set(source.citationLabel, matching);
  });
  const parts: CitationPart[] = [];
  let offset = 0;
  for (const match of text.matchAll(/\[(E[0-9a-f]{32})\]/gi)) {
    const matching = labels.get(match[1]);
    if (!matching?.length) continue;
    if (match.index > offset) parts.push({ kind: "text", text: text.slice(offset, match.index) });
    matching.forEach(({ source, number }, index) => {
      if (index) parts.push({ kind: "text", text: " " });
      parts.push({ kind: "source", number, title: source.title, href: safeSourceLink(source) });
    });
    offset = match.index + match[0].length;
  }
  if (offset < text.length || !parts.length) parts.push({ kind: "text", text: text.slice(offset) });
  return parts;
}
type CitationNode = { type: string; value?: string; url?: string; title?: string; children?: CitationNode[] };
export function sourceCitations(sources: GrowthAgentSource[]) {
  return () => (tree: unknown) => {
    function visit(node: CitationNode) {
      if (!node.children || ["link", "linkReference"].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        return sourceCitationParts(child.value, sources).map(part => {
          if (part.kind === "text") return { type: "text", value: part.text };
          const marker = { type: "text", value: `[${part.number}]` };
          return part.href ? { type: "link", url: part.href, title: part.title, children: [marker] } : marker;
        });
      });
    }
    visit(tree as CitationNode);
  };
}
