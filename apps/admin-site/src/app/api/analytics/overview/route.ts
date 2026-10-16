import { getAdminSession, proxyToCore } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const response = await proxyToCore(req, "/api/admin/analytics/overview");
  const data = await response.json().catch(() => ({ error: "Analytics response was invalid" }));
  return NextResponse.json(data, { status: response.status });
}
