const citation = /\[E(?:[a-f0-9]{32}|[0-9]+)\]/g;

/** Customer-visible text must not expose internal evidence handles. The stored task output keeps them. */
export function publicAnswerText(text: string): string {
  return text
    .replace(citation, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/([^ \t\n])[ \t]{2,}/g, "$1 ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
