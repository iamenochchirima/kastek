import { NextResponse } from "next/server";
import { getAdminSession, proxyToCore } from "@/lib/admin-auth";

export async function GET(req: Request) {
  if (!(await getAdminSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const response = await proxyToCore(req, "/api/admin/reports");
  const data = await response.json().catch(() => ({ error: "Reports are unavailable" }));
  return NextResponse.json(data, { status: response.status });
}

export async function POST(req: Request) {
  if (!(await getAdminSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const response = await proxyToCore(req, "/api/admin/reports");
  const data = await response.json().catch(() => ({ error: "Report could not be saved" }));
  return NextResponse.json(data, { status: response.status });
}
