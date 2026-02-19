import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasiai/database";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const lead = await prisma.quoteRequest.findUnique({ where: { id } });

  if (!lead) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(lead);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json();

  // Handle date conversion
  if (body.followUpDate) {
    body.followUpDate = new Date(body.followUpDate);
  } else if (body.followUpDate === null || body.followUpDate === "") {
    body.followUpDate = null;
  }

  const lead = await prisma.quoteRequest.update({
    where: { id },
    data: body,
  });

  return NextResponse.json(lead);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  await prisma.quoteRequest.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
