const SENSITIVE_QUERY = "token|access[_-]?token|refresh[_-]?token|api[_-]?key|key|code|signature|password|secret";
const SENSITIVE_FIELD = `authorization|${SENSITIVE_QUERY}|client[_-]?secret`;

/** Bounds and removes common credential material from exception text and stack summaries. */
export function redactTelemetryText(value: unknown, maxLength: number): string {
  const text = String(value ?? "unknown")
    .replace(/Bearer\s+[^\s,;&]+/gi, "Bearer [REDACTED]")
    .replace(new RegExp(`([?&](?:${SENSITIVE_QUERY})=)[^&\\s]+`, "gi"), "$1[REDACTED]")
    .replace(new RegExp(`((?:${SENSITIVE_FIELD})\\s*[:=]\\s*)(?:Bearer\\s+)?(?:"[^"]*"|'[^']*'|[^,\\s;&]+)`, "gi"), "$1[REDACTED]");
  return text.slice(0, maxLength);
}
