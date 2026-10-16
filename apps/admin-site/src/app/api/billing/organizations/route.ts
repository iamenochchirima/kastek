import { getAdminSession, proxyToCore } from "@/lib/admin-auth";

export async function GET(req: Request) {
  if (!(await getAdminSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return proxyToCore(req, "/api/admin/billing/organizations");
}
