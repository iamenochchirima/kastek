import { queryClient, requestScope } from "@/lib/query-client";

export class ApiError extends Error {
  constructor(public status: number, public path: string) {
    super(`API request failed (${status})`);
  }
}

// Loader reads and component reads share the same scoped, cancellable query cache.
export async function fetchCoreJson<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const read = async (signal?: AbortSignal): Promise<T> => {
    const response = await fetch(path, { ...init, credentials: "include", cache: "no-store", signal: init?.signal ?? signal });
    if (!response.ok) throw new ApiError(response.status, path);
    return response.json() as Promise<T>;
  };
  if (method !== "GET") return read();
  return queryClient.fetchQuery({ queryKey: ["growth", requestScope(), path, Array.from(new Headers(init?.headers).entries())], queryFn: ({ signal }) => read(signal) });
}
