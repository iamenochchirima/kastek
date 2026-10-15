import { apiUrl } from "./server-api";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export async function fetchApiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { ...init, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new ApiError(response.status, `Request failed (${response.status})`);
  return response.json() as Promise<T>;
}
