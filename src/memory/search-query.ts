const lexicalStopWords = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "by", "can", "could", "do", "does", "for", "from",
  "have", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "our", "please", "tell", "that",
  "the", "this", "to", "what", "when", "where", "which", "who", "why", "with", "would", "you", "your",
]);

/**
 * Builds a safe OR query for PostgreSQL's simple text-search configuration.
 * Natural-language questions must not require every question word to exist in
 * one chunk; the content terms are the useful lexical signal.
 */
export function buildLexicalSearchQuery(searchText: string): string | null {
  const terms = searchText
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((term) => term.length >= 2 && !lexicalStopWords.has(term))
    .filter((term, index, values) => values.indexOf(term) === index)
    .slice(0, 32);
  return terms.length ? terms.join(" | ") : null;
}
