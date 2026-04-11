import { NextResponse } from "next/server";

const CORE_BACKEND_URL = process.env.CORE_BACKEND_URL ?? "http://localhost:4000";

export async function POST(req: Request) {
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

  // Forward the Set-Cookie header from Rust so the browser gets the session cookie
  const response = NextResponse.json(data, { status: 200 });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    response.headers.set("set-cookie", setCookie);
  }

  return response;
}
