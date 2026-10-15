import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  buildQuotationPdf,
  formatQuotationDateInput,
  QUOTATION_DEFAULT_SECTION_ORDER,
  type QuotationDraft,
} from "@/lib/quotation";

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function normalizeTermsAndNotes(items: string[]) {
  const normalized: string[] = [];

  for (const item of items) {
    const text = String(item || "").trim();
    if (!text) continue;

    const looksLikeLegacyMetaRates =
      text.includes("Current Meta template rates for South Africa (USD)") &&
      text.includes("Marketing") &&
      text.includes("Utility") &&
      text.includes("Authentication");

    if (!looksLikeLegacyMetaRates) {
      normalized.push(text);
      continue;
    }

    const [header] = text.split(/Marketing/i);
    const headerText = header.trim().replace(/[:\s]*$/, ":");
    if (headerText) normalized.push(headerText);

    const matches = text.match(
      /(Marketing\s*:?\s*\$[0-9.]+|Utility\s*:?\s*\$[0-9.]+|Authentication International\s*:?\s*\$[0-9.]+|Authentication\s*:?\s*\$[0-9.]+)/gi
    );

    if (!matches || matches.length === 0) {
      normalized.push(text);
      continue;
    }

    for (const match of matches) {
      const cleaned = match
        .replace(/\s+/g, " ")
        .replace(/\s*:\s*/g, ": ")
        .replace(/\s+\$/g, ": $")
        .replace(/\.$/, "")
        .trim();
      if (cleaned) normalized.push(cleaned);
    }
  }

  return normalized;
}

function asSectionArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const format: "richtext" | "markdown" =
        record.format === "markdown" ? "markdown" : "richtext";
      return {
        id: asString(record.id),
        title: asString(record.title),
        content: asString(record.content),
        format,
      };
    })
    .filter((item): item is Exclude<typeof item, null> => Boolean(item))
    .filter((item) => Boolean(item.id));
}

function asPricingItems(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      return {
        description: asString(record.description),
        amount: asString(record.amount),
        billing: asString(record.billing),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function asNoteSections(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      return {
        id: asString(record.id),
        title: asString(record.title),
        items: Array.isArray(record.items)
          ? record.items.map((entry) => String(entry)).filter(Boolean)
          : [],
      };
    })
    .filter((item): item is Exclude<typeof item, null> => Boolean(item))
    .filter((item) => Boolean(item.id));
}

function asSectionOrder(value: unknown, customSections: Array<{ id: string }>) {
  const known = new Set([
    ...QUOTATION_DEFAULT_SECTION_ORDER,
    ...customSections.map((section) => `custom:${section.id}`),
  ]);
  const requested = Array.isArray(value) ? value.map((item) => String(item)) : [];
  const filtered = requested.filter((entry) => known.has(entry));
  const defaults = QUOTATION_DEFAULT_SECTION_ORDER.filter((entry) => !filtered.includes(entry));
  const customs = customSections
    .map((section) => `custom:${section.id}`)
    .filter((entry) => !filtered.includes(entry) && !defaults.includes(entry as (typeof defaults)[number]));
  return [...defaults, ...filtered, ...customs];
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  const customSections = asSectionArray(body.implementationSteps);
  const draft: QuotationDraft = {
    id: asString(body.id) || undefined,
    quoteRequestId: asString(body.quoteRequestId) || undefined,
    serviceType: asString(body.serviceType, "website_agent"),
    preparedFor: asString(body.businessName),
    contactPerson: asString(body.contactPerson),
    contactEmail: asString(body.contactEmail),
    contactPhone: asString(body.contactPhone),
    date: asString(body.date, formatQuotationDateInput(new Date())),
    title: asString(body.title),
    introduction: asString(body.introduction),
    scopeOfWork: asStringArray(body.scopeOfWork),
    deliverables: asStringArray(body.deliverables),
    customSections,
    sectionOrder: asSectionOrder(body.sectionOrder, customSections),
    maintenanceIncludes: asStringArray(body.maintenanceIncludes),
    termsAndNotes: normalizeTermsAndNotes(asStringArray(body.termsAndNotes)),
    noteSections: asNoteSections(body.noteSections),
    pricingItems: asPricingItems(body.pricingItems),
    validityDays: asString(body.validityDays, "14"),
    status: asString(body.status, "draft"),
  };

  const pdf = buildQuotationPdf(draft);
  return new NextResponse(pdf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Cache-Control": "no-store",
    },
  });
}
