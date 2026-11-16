const citation = /\[E(?:[a-f0-9]{32}|[0-9]+)\]/gi;
const bracket = /\[([^\]\n]{1,160})\]/g;

/** A model may split a label with whitespace or put several labels in one bracket. */
function isEvidenceBracket(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  return /^(?:E[a-f0-9]{20,32})+$/i.test(compact) || /^[0-9]+$/.test(compact);
}

/** Customer-visible text must not expose internal evidence handles. The stored task output keeps them. */
export function publicAnswerText(text: string): string {
  return text
    .replace(bracket, (match, inner: string) => isEvidenceBracket(inner) ? "" : match)
    .replace(citation, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/([^ \t\n])[ \t]{2,}/g, "$1 ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
