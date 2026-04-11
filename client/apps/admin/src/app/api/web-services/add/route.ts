import { getAdminSession, proxyToCore } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const res = await proxyToCore(req, "/api/admin/web-services");
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
