import { getAdminSession, proxyToCore } from "@/lib/admin-auth";

export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  if (!(await getAdminSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { orgId } = await params;
  return proxyToCore(req, `/api/admin/billing/orgs/${encodeURIComponent(orgId)}/credits/balance`);
}
