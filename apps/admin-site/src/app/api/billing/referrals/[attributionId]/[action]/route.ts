import { getAdminSession, proxyToCore } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ attributionId: string; action: string }> },
) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { attributionId, action } = await params;
  if (action !== "reject" && action !== "reverse") {
    return NextResponse.json({ error: "Unsupported referral action" }, { status: 400 });
  }
  const response = await proxyToCore(
    req,
    "/api/admin/referrals/" + encodeURIComponent(attributionId) + "/" + action,
  );
  const payload = await response.json();
  return NextResponse.json(payload, { status: response.status });
}
