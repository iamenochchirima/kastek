import { getAdminSession, proxyToTenants } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; domainId: string }> }
) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, domainId } = await params;
  const res = await proxyToTenants(
    req,
    `/api/admin/workspaces/${id}/domains/${domainId}/primary`
  );
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
