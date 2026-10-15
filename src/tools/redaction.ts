const SECRET_KEY = /(api[_-]?key|secret|token|password|authorization|cookie|private[_-]?key|access[_-]?token)/i;

export function redactSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[REDACTED_DEPTH]";
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry, depth + 1));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactSensitiveValue(entry, depth + 1);
  }
  return result;
}

function redactPath(value: unknown, segments: string[]): unknown {
  if (!segments.length) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => redactPath(entry, segments));
  if (!value || typeof value !== "object") return value;
  const result = { ...(value as Record<string, unknown>) };
  const [segment, ...remaining] = segments;
  if (segment && Object.prototype.hasOwnProperty.call(result, segment)) {
    result[segment] = redactPath(result[segment], remaining);
  }
  return result;
}

/** Apply a capability's declared field redactions to its durable audit output. */
export function redactToolOutput(value: unknown, paths: readonly string[]): unknown {
  return paths.reduce((current, path) => {
    const segments = path.split(".").map((segment) => segment.trim()).filter(Boolean);
    return segments.length ? redactPath(current, segments) : current;
  }, redactSensitiveValue(value));
}
