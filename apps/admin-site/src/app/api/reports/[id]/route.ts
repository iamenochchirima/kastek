import { NextResponse } from "next/server";
import { getAdminSession, proxyToCore } from "@/lib/admin-auth";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const response = await proxyToCore(req, `/api/admin/reports/${encodeURIComponent(id)}`);
  if (response.status === 204) return new Response(null, { status: 204 });
  const data = await response.json().catch(() => ({ error: "Report could not be deleted" }));
  return NextResponse.json(data, { status: response.status });
}
