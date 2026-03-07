import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasitek/database";

function parseDateStart(value: string | null) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDateEnd(value: string | null) {
  if (!value) return null;
  const d = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildWhere(params: URLSearchParams) {
  const campaignId = params.get("campaignId") || "";
  const status = params.get("status") || "";
  const mode = params.get("mode") || "";
  const recipient = params.get("recipient") || "";
  const domain = (params.get("domain") || "").replace(/^@+/, "").trim().toLowerCase();
  const from = parseDateStart(params.get("dateFrom"));
  const to = parseDateEnd(params.get("dateTo"));

  const where: Record<string, unknown> = {};

  if (campaignId) where.campaignId = campaignId;
  if (status) where.status = status;
  if (mode === "test") where.campaign = { category: "system-test" };
  if (mode === "live") where.NOT = { campaign: { category: "system-test" } };
  if (recipient) {
    where.recipient = { contains: recipient, mode: "insensitive" };
  }
  if (domain) {
    where.recipient = {
      ...(typeof where.recipient === "object" && where.recipient ? (where.recipient as object) : {}),
      endsWith: `@${domain}`,
      mode: "insensitive",
    };
  }
  if (from || to) {
    where.attemptedAt = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
  }

  return where;
}

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const where = buildWhere(searchParams);

  const rows = await prisma.outreachEmailDeliveryLog.findMany({
    where,
    orderBy: { attemptedAt: "desc" },
    take: 20000,
    include: {
      campaign: { select: { name: true, category: true } },
      lead: { select: { businessName: true, website: true } },
    },
  });

  const headers = [
    "attempted_at",
    "campaign",
    "type",
    "business_name",
    "website",
    "recipient",
    "status",
    "subject",
    "provider",
    "provider_message_id",
    "provider_response",
    "error_message",
  ];

  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      [
        row.attemptedAt.toISOString(),
        row.campaign?.name || "",
        row.campaign?.category === "system-test" ? "test" : "live",
        row.lead?.businessName || "",
        row.lead?.website || "",
        row.recipient,
        row.status,
        row.subject,
        row.provider,
        row.providerMessageId || "",
        row.providerResponse || "",
        row.errorMessage || "",
      ]
        .map(csvEscape)
        .join(",")
    ),
  ];

  const csv = lines.join("\n");
  const dateTag = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=\"outreach-delivery-${dateTag}.csv\"`,
      "Cache-Control": "no-store",
    },
  });
}
