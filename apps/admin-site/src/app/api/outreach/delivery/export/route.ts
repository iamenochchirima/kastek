import { getAdminSession, fetchFromCore } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Forward all query params plus force CSV format
  const { searchParams } = new URL(req.url);
  searchParams.set("format", "csv");
  searchParams.set("limit", "20000");
  searchParams.delete("page");
  searchParams.delete("paginate");
  const res = await fetchFromCore(`/api/admin/outreach/delivery?${searchParams.toString()}`);

  const text = await res.text();
  const dateTag = new Date().toISOString().slice(0, 10);

  return new NextResponse(text, {
    status: res.status,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="outreach-delivery-${dateTag}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
