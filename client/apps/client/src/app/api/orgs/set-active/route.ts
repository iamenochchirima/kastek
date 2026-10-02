import { NextRequest, NextResponse } from "next/server";
import { ACTIVE_ORG_COOKIE, fetchOrgs } from "@/lib/orgs";
import { getRustSession } from "@/lib/rust-auth";

export async function POST(req: NextRequest) {
  if (req.headers.get("origin") !== req.nextUrl.origin) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }
  const session = await getRustSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const orgId = body?.orgId;

  if (!orgId || typeof orgId !== "string") {
    return NextResponse.json({ error: "orgId required" }, { status: 400 });
  }

  const orgs = await fetchOrgs();
  if (!orgs.some((org) => org.id === orgId)) {
    return NextResponse.json({ error: "Organization access denied" }, { status: 403 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACTIVE_ORG_COOKIE, orgId, {
    path: "/",
    httpOnly: true,
    secure: req.nextUrl.protocol === "https:",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });

  return res;
}
