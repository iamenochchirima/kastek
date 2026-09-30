import { getAdminSession, proxyToCore } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { category, listings } = body;

  if (!category || !Array.isArray(listings) || listings.length === 0) {
    return NextResponse.json(
      { error: "category and listings[] are required" },
      { status: 400 }
    );
  }

  // Transform listings into the format the Rust backend expects
  const leads = listings.map(
    (l: { name: string; website?: string; address?: string; bizbayUrl?: string; phone?: string; email?: string }) => {
      const slug = l.name
        .replace(/[^a-zA-Z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
      const bizbayUrl = l.bizbayUrl || `https://bizbay.co.za/Company/${slug}`;
      return {
        businessName: l.name,
        website: l.website ?? null,
        address: l.address ?? null,
        bizbayUrl,
        phone: l.phone ?? null,
        email: l.email ?? null,
        category,
      };
    }
  );

  const rustReq = new Request(req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leads }),
  });

  const res = await proxyToCore(rustReq, "/api/admin/web-services/import");
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
