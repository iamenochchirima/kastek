/** Improve slug-only labels without changing user-provided names or identifiers. */
export function catalogueLabel(name: string): string {
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(name)) return name;
  const words = name.replace(/[-_]+/g, " ");
  return words[0].toUpperCase() + words.slice(1);
}
