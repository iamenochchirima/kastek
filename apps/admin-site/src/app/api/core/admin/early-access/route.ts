import { proxyToCore } from "@/lib/admin-auth";

export async function GET(req: Request) {
  return proxyToCore(req, "/api/admin/early-access");
}
