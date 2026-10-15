import { getAdminSession, proxyToCore } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; runId: string }> }
) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, runId } = await params;
  const res = await proxyToCore(req, `/api/admin/invoices/${id}/runs/${runId}/actions`);
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
