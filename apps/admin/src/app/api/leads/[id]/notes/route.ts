import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma, Prisma } from "@kasitek/database";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { text } = await req.json();

  if (!text?.trim()) {
    return NextResponse.json({ error: "Note text is required" }, { status: 400 });
  }

  const lead = await prisma.quoteRequest.findUnique({
    where: { id },
    select: { notes: true },
  });

  if (!lead) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const existingNotes = Array.isArray(lead.notes) ? lead.notes : [];

  const newNote = {
    text: text.trim(),
    timestamp: new Date().toISOString(),
    adminUserId: session.user.id!,
    adminUserName: session.user.name ?? "Admin",
  };

  const updatedNotes = [...existingNotes, newNote] as Prisma.InputJsonValue;

  const updated = await prisma.quoteRequest.update({
    where: { id },
    data: {
      notes: updatedNotes,
    },
  });

  return NextResponse.json(updated);
}
