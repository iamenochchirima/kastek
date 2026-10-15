import { proxyToCore } from "@/lib/admin-auth";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyToCore(req, `/api/admin/early-access/${encodeURIComponent(id)}`);
}
