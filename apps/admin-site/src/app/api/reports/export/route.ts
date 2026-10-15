import { NextResponse } from "next/server";
import { getAdminSession, proxyToCore } from "@/lib/admin-auth";

export async function GET(req: Request) {
  if (!(await getAdminSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const response = await proxyToCore(req, "/api/admin/reports/export");
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Report export failed" }));
    return NextResponse.json(data, { status: response.status });
  }
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") ?? "text/csv; charset=utf-8",
      "Content-Disposition": response.headers.get("content-disposition") ?? "attachment",
      "Cache-Control": "no-store",
    },
  });
}
