import { getAdminSession, proxyToCore } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { path } = await params;
  const safePath = path.map((segment) => encodeURIComponent(segment)).join("/");
  const response = await proxyToCore(req, `/api/admin/operations/${safePath}`);
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { path } = await params;
  const safePath = path.map((segment) => encodeURIComponent(segment)).join("/");
  const response = await proxyToCore(req, `/api/admin/operations/${safePath}`);
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
