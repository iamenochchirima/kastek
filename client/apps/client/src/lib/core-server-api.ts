import { cookies } from "next/headers";
import { apiUrl } from "@/lib/server-api";

export async function fetchCoreJson<T>(path: string, init?: RequestInit): Promise<T> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");

  const response = await fetch(apiUrl(path), {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.headers || {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Core API request failed for ${path} (${response.status})${text ? `: ${text}` : ""}`,
    );
  }

  return response.json() as Promise<T>;
}
