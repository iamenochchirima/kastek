import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasiai/database";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { category, listings } = body;

  if (!category || !Array.isArray(listings) || listings.length === 0) {
    return NextResponse.json(
      { error: "category and listings[] are required" },
      { status: 400 }
    );
  }

  const result = await prisma.webServiceLead.createMany({
    data: listings.map(
      (l: { name: string; website?: string; address?: string; bizbayUrl?: string; phone?: string; email?: string }) => {
        // Auto-generate BizBay URL from business name if not provided
        const slug = l.name
          .replace(/[^a-zA-Z0-9\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-");
        const bizbayUrl = l.bizbayUrl || `https://bizbay.co.za/Company/${slug}`;

        return {
          businessName: l.name,
          website: l.website || null,
          address: l.address || null,
          bizbayUrl,
          phone: l.phone || null,
          email: l.email || null,
          category,
        };
      }
    ),
  });

  return NextResponse.json({ imported: result.count }, { status: 201 });
}
