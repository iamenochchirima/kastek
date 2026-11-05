/** A channel alone does not identify who will receive a reviewed message. */
export function reviewedRecipientLabel(value: { name?: unknown; identifier?: unknown; channel?: unknown } | undefined): string | null {
  if (!value) return null;
  const clean = (item: unknown) => typeof item === "string" ? item.trim() : "";
  const name = clean(value.name), identifier = clean(value.identifier);
  if (!name && !identifier) return null;
  // Preserve the existing snapshot representation for already approved reviews.
  return [value.name, value.identifier, value.channel].filter(Boolean).join(" · ");
}
