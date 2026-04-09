import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasitek/database";
import { parseInvoiceDateInput } from "@/lib/invoice";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({ where: { id } });

  if (!invoice) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(invoice);
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

  const invoice = await prisma.invoice.update({
    where: { id },
    data: {
      quoteRequestId: body.quoteRequestId ?? undefined,
      serviceType: body.serviceType,
      businessName: body.businessName,
      contactPerson: body.contactPerson,
      contactEmail: body.contactEmail,
      contactPhone: body.contactPhone,
      date: body.date ? parseInvoiceDateInput(body.date) : undefined,
      title: body.title,
      introduction: body.introduction ?? undefined,
      scopeOfWork: body.scopeOfWork,
      deliverables: body.deliverables,
      implementationSteps: body.implementationSteps,
      pricingItems: body.pricingItems,
      maintenanceIncludes: body.maintenanceIncludes,
      termsAndNotes: body.termsAndNotes,
      includedFunctionality: body.sectionOrder ?? undefined,
      importantNotes: body.noteSections ?? undefined,
      validityDays: body.validityDays ? Number(body.validityDays) : undefined,
      status: body.status,
    },
  });

  return NextResponse.json(invoice);
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
  await prisma.invoice.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
