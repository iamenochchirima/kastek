import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasiai/database";

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

  const lead = await prisma.webServiceLead.update({
    where: { id },
    data: {
      ...(body.callStatus && { callStatus: body.callStatus }),
      ...(body.phone !== undefined && { phone: body.phone }),
      ...(body.email !== undefined && { email: body.email }),
      ...(body.notes !== undefined && { notes: body.notes }),
      ...(body.callbackDate !== undefined && {
        callbackDate: body.callbackDate ? new Date(body.callbackDate) : null,
      }),
    },
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
  await prisma.webServiceLead.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
