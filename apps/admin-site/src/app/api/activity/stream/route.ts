import { NextResponse } from "next/server";
import { getAdminSession, proxyToCore } from "@/lib/admin-auth";

export async function GET(req: Request) {
  if (!(await getAdminSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const response = await proxyToCore(req, "/api/admin/activity/stream");
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Activity stream is unavailable" }));
    return NextResponse.json(data, { status: response.status });
  }
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") ?? "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
