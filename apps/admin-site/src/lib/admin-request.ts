export async function adminRequest(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(typeof data?.error === "string" ? data.error : "Request failed. Try again.");
  }
  return response;
}
