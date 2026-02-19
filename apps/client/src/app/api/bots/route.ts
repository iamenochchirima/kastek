import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { name, type, language, businessDetails } = body;

    if (!name || !type) {
      return NextResponse.json(
        { error: "Name and type are required" },
        { status: 400 }
      );
    }

    if (!["starter", "growth"].includes(type)) {
      return NextResponse.json(
        { error: "Type must be 'starter' or 'growth'" },
        { status: 400 }
      );
    }

    const bot = await prisma.botConfiguration.create({
      data: {
        userId: session.user.id,
        name,
        type,
        language: language || "en",
        knowledgeBase: businessDetails || null,
      },
    });

    return NextResponse.json({ bot }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
