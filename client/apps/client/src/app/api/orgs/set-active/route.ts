import { NextRequest, NextResponse } from "next/server";
import { ACTIVE_ORG_COOKIE } from "@/lib/orgs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const orgId = body?.orgId;

  if (!orgId || typeof orgId !== "string") {
    return NextResponse.json({ error: "orgId required" }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACTIVE_ORG_COOKIE, orgId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });

  return res;
}
