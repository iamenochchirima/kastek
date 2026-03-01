import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const query = searchParams.get("q")?.trim() || "";
    const optIn = searchParams.get("optIn") || "all";
    const excluded = searchParams.get("excluded") || "all";
    const tag = searchParams.get("tag")?.trim() || "";
    const location = searchParams.get("location")?.trim() || "";

    const where = {
      userId,
      ...(query
        ? {
            OR: [
              { fullName: { contains: query, mode: "insensitive" as const } },
              { phone: { contains: query, mode: "insensitive" as const } },
              { location: { contains: query, mode: "insensitive" as const } },
              { tags: { has: query } },
            ],
          }
        : {}),
      ...(optIn === "true" ? { optIn: true } : {}),
      ...(optIn === "false" ? { optIn: false } : {}),
      ...(excluded === "true" ? { excluded: true } : {}),
      ...(excluded === "false" ? { excluded: false } : {}),
      ...(tag ? { tags: { has: tag } } : {}),
      ...(location
        ? {
            location: {
              contains: location,
              mode: "insensitive" as const,
            },
          }
        : {}),
    };

    const contacts = await prisma.whatsappContact.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    return NextResponse.json({ contacts });
  } catch {
    return NextResponse.json({ error: "Failed to list contacts" }, { status: 500 });
  }
}
