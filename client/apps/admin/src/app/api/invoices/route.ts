import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasitek/database";
import { parseInvoiceDateInput } from "@/lib/invoice";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const invoices = await prisma.invoice.findMany({
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(invoices);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  const invoice = await prisma.invoice.create({
    data: {
      quoteRequestId: body.quoteRequestId || null,
      serviceType: body.serviceType || "website_agent",
      businessName: body.businessName,
      contactPerson: body.contactPerson,
      contactEmail: body.contactEmail,
      contactPhone: body.contactPhone,
      date: parseInvoiceDateInput(body.date),
      title: body.title,
      introduction: body.introduction || null,
      scopeOfWork: body.scopeOfWork || [],
      deliverables: body.deliverables || [],
      implementationSteps: body.implementationSteps || [],
      pricingItems: body.pricingItems || [],
      maintenanceIncludes: body.maintenanceIncludes || [],
      termsAndNotes: body.termsAndNotes || [],
      includedFunctionality: body.sectionOrder || [],
      knowledgeBaseScope: [],
      importantNotes: body.noteSections || [],
      supportIncludes: [],
      setupFee: "",
      monthlyFee: "",
      deliveryTimeline: null,
      validityDays: body.validityDays ? Number(body.validityDays) : 14,
      status: body.status || "draft",
    },
  });

  return NextResponse.json(invoice, { status: 201 });
}
