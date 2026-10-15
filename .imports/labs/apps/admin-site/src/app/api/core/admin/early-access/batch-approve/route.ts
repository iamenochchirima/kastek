import { proxyToCore } from "@/lib/admin-auth";

export async function POST(req: Request) {
  return proxyToCore(req, "/api/admin/early-access/batch-approve");
}
