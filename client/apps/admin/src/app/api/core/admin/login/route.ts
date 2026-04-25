import { NextResponse } from "next/server";

const CORE_BACKEND_URL = process.env.CORE_BACKEND_URL ?? "http://localhost:4000";
const ADMIN_SESSION_COOKIE = "kasitek_admin_session";

function extractCookieValue(setCookie: string | null, name: string): string | null {
  if (!setCookie) return null;

  const parts = setCookie.split(/,(?=[^;,]+=)/g);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      const value = trimmed.slice(name.length + 1);
      return value.split(";")[0] ?? null;
    }
  }

  const direct = setCookie.trim();
  if (direct.startsWith(`${name}=`)) {
    return direct.slice(name.length + 1).split(";")[0] ?? null;
  }

  return null;
}

export async function POST(req: Request) {
  const requestUrl = new URL(req.url);
  const isHttps = requestUrl.protocol === "https:";
  const body = await req.text();

  const res = await fetch(`${CORE_BACKEND_URL}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    return NextResponse.json(data, { status: res.status });
  }

  const response = NextResponse.json(data, { status: 200 });
  const setCookie = res.headers.get("set-cookie");
  const sessionToken = extractCookieValue(setCookie, ADMIN_SESSION_COOKIE);

  if (sessionToken) {
    response.cookies.set({
      name: ADMIN_SESSION_COOKIE,
      value: sessionToken,
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: isHttps,
    });
  } else if (setCookie) {
    response.headers.set("set-cookie", setCookie);
  }

  return response;
}
