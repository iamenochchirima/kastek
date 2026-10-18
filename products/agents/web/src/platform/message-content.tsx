import { Fragment, type ReactNode } from "react";

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      try { const url = new URL(link[2]); if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return <a key={index} href={url.href} target="_blank" rel="noopener noreferrer">{link[1]}</a>; } catch { /* Invalid links remain ordinary text. */ }
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}
export function MessageContent({ text }: { text: string }) {
  const blocks = text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g);
  return <div className="message-content">{blocks.map((block, index) => {
    if (block.startsWith("```")) { const firstLine = block.indexOf("\n"); return <pre key={index}><code>{block.slice(firstLine + 1).replace(/```$/, "").trimEnd()}</code></pre>; }
    return <Fragment key={index}>{block.split(/\n\s*\n/).filter(Boolean).map((paragraph, p) => {
      if (/^#{1,6} /.test(paragraph)) return <h3 key={p}>{inline(paragraph.replace(/^#{1,6} /, ""))}</h3>;
      if (/^(?:[-*] |\d+\. )/.test(paragraph) && paragraph.split("\n").every(line => /^(?:[-*] |\d+\. )/.test(line))) return <ul key={p}>{paragraph.split("\n").map((line, l) => <li key={l}>{inline(line.replace(/^(?:[-*] |\d+\. )/, ""))}</li>)}</ul>;
      return <p key={p}>{inline(paragraph)}</p>;
    })}</Fragment>;
  })}</div>;
}
