import { proxyToCore } from "@/lib/admin-auth";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyToCore(req, `/api/admin/early-access/${encodeURIComponent(id)}/review`);
}
