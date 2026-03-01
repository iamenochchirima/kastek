import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasiai/database";
import { parseQuotationDateInput } from "@/lib/quotation";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const quotations = await prisma.quotation.findMany({
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(quotations);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  const quotation = await prisma.quotation.create({
    data: {
      quoteRequestId: body.quoteRequestId || null,
      serviceType: body.serviceType || "website_agent",
      businessName: body.businessName,
      contactPerson: body.contactPerson,
      contactEmail: body.contactEmail,
      contactPhone: body.contactPhone,
      date: parseQuotationDateInput(body.date),
      title: body.title,
      introduction: body.introduction || null,
      scopeOfWork: body.scopeOfWork || [],
      deliverables: body.deliverables || [],
      implementationSteps: body.implementationSteps || [],
      pricingItems: body.pricingItems || [],
      maintenanceIncludes: body.maintenanceIncludes || [],
      termsAndNotes: body.termsAndNotes || [],
      includedFunctionality: [],
      knowledgeBaseScope: [],
      importantNotes: [],
      supportIncludes: [],
      setupFee: "",
      monthlyFee: "",
      deliveryTimeline: null,
      validityDays: body.validityDays ? Number(body.validityDays) : 14,
      status: body.status || "draft",
    },
  });

  return NextResponse.json(quotation, { status: 201 });
}
