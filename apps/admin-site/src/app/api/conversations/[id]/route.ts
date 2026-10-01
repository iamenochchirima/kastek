import { getAdminSession, proxyToCore } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const res = await proxyToCore(req, `/api/admin/conversations/${id}`);
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
