import { getAdminSession, proxyToCore } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json();

  if (!body.text?.trim()) {
    return NextResponse.json({ error: "Note text is required" }, { status: 400 });
  }

  // Forward to Rust with adminUserName included
  const rustReq = new Request(req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: body.text, adminUserName: admin.name }),
  });

  const res = await proxyToCore(rustReq, `/api/admin/leads/${id}/notes`);
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
