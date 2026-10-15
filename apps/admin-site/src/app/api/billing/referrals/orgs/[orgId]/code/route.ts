import { getAdminSession, proxyToCore } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { orgId } = await params;
  const response = await proxyToCore(
    req,
    "/api/admin/referrals/orgs/" + encodeURIComponent(orgId) + "/code",
  );
  const payload = await response.json();
  return NextResponse.json(payload, { status: response.status });
}
