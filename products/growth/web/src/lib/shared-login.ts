import { apiUrl } from "@/lib/server-api";

export function safeReturnTo(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20]/.test(value)) {
    return "/workspace";
  }
  return value;
}

export function loginUrl(returnTo?: string | null, signup = false) {
  const params = new URLSearchParams({ returnTo: safeReturnTo(returnTo) });
  if (signup) params.set("screen", "signup");
  return apiUrl(`/api/auth/login?${params}`);
}

export async function signOut(allDevices = false) {
  const response = await fetch(apiUrl(allDevices ? "/api/auth/logout-all" : "/api/auth/logout"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: "{}",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.redirectUrl !== "string") {
    throw new Error("Could not sign out. Please try again.");
  }
  const target = new URL(body.redirectUrl, window.location.origin);
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Could not sign out. Please try again.");
  }
  window.dispatchEvent(new Event("kasitek:session-ended"));
  window.location.assign(target.href);
}
