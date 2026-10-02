import { NextRequest, NextResponse } from "next/server";

const DEFAULT_API_BASE_URL =
  process.env.NODE_ENV === "production"
    ? "https://api.kasitek.co.za"
    : "http://localhost:4000";

export async function POST(request: NextRequest) {
  const apiBaseUrl = (
    process.env.CORE_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    process.env.NEXT_PUBLIC_KASITEK_PUBLIC_API_URL ||
    DEFAULT_API_BASE_URL
  ).replace(/\/$/, "");

  try {
    const upstream = await fetch(`${apiBaseUrl}/api/waitlist`, {
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
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (error) {
    console.error("[waitlist] Core request failed", error);

    return NextResponse.json(
      {
        error: "Early-access applications are temporarily unavailable. Please try again.",
        code: "waitlist_upstream_unavailable",
      },
      { status: 503 },
    );
  }
}
