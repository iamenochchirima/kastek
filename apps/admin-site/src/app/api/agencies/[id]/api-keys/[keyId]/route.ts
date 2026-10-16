import { getAdminSession, proxyToTenants } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; keyId: string }> }
) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, keyId } = await params;
  const res = await proxyToTenants(req, `/api/admin/workspaces/${id}/api-keys/${keyId}`);
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
