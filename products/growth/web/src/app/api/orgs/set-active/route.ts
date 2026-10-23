import { NextRequest, NextResponse } from "next/server";
import { ACTIVE_ORG_COOKIE, fetchOrgs } from "@/lib/orgs";
import { getCoreSession } from "@/lib/core-auth";

export async function POST(req: NextRequest) {
  let expectedOrigin = req.nextUrl.origin;
  const configuredOrigin = process.env.GROWTH_WEB_ORIGIN;
  if (configuredOrigin) {
    try {
      const trusted = new URL(configuredOrigin);
      if (!["http:", "https:"].includes(trusted.protocol) || trusted.username || trusted.password || trusted.pathname !== "/" || trusted.search || trusted.hash) throw new Error("Invalid app origin");
      expectedOrigin = trusted.origin;
      if (req.headers.get("host") !== trusted.host) return NextResponse.json({ error: "Invalid request host" }, { status: 403 });
    } catch { return NextResponse.json({ error: "App origin is not configured correctly" }, { status: 503 }); }
  }
  if (req.headers.get("origin") !== expectedOrigin) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }
  const session = await getCoreSession();
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
