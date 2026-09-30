import { NextResponse } from "next/server";

const CORE_BACKEND_URL = process.env.CORE_BACKEND_URL ?? "http://localhost:4000";

export async function POST(req: Request) {
  const body = await req.text();

  const res = await fetch(`${CORE_BACKEND_URL}/api/admin/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const text = await res.text();
  let data: Record<string, unknown> = {};

  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok && !data.error) {
    data.error =
      res.status === 404
        ? "Core admin reset-password endpoint was not found. Restart kasitek-core or verify CORE_BACKEND_URL."
        : `Request failed with status ${res.status}.`;
  }

  return NextResponse.json(data, { status: res.status });
}
