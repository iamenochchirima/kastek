import { proxyToCore } from "@/lib/admin-auth";

export async function GET(req: Request) {
  return proxyToCore(req, "/api/admin/access");
}

export async function POST(req: Request) {
  return proxyToCore(req, "/api/admin/access");
}
