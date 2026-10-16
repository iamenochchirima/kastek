import { getAdminSession, proxyToTenants } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const res = await proxyToTenants(req, "/api/admin/workspaces");
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

export async function POST(req: Request) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const res = await proxyToTenants(req, "/api/admin/workspaces");
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
