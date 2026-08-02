import { NextRequest, NextResponse } from "next/server";

const DEFAULT_API_BASE_URL = "http://localhost:4000";

export async function POST(request: NextRequest) {
  const apiBaseUrl = (
    process.env.RUST_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    DEFAULT_API_BASE_URL
  ).replace(/\/$/, "");

  const upstream = await fetch(`${apiBaseUrl}/api/quote-requests`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "ngrok-skip-browser-warning": "1",
    },
    body: await request.text(),
    cache: "no-store",
  });

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
    },
  });
}
