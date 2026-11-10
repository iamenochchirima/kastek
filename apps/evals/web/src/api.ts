export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function shortId(value: string): string {
  return value.length > 10 ? value.slice(0, 8) : value;
}

export function shortDigest(value: string | null): string {
  return value ? `${value.slice(0, 12)}…` : "—";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
