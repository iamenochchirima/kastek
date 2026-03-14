import { buildPdfFromOps, wrapText, type PdfOp } from "@/lib/pdf";

type QuoteLead = {
  id?: string;
  businessName: string;
  contactPerson: string;
  email: string;
  phone: string;
  services: string[];
};

export type InvoiceLineItem = {
  description: string;
  amount: string;
  billing: string;
};

export type InvoiceSection = {
  id: string;
  title: string;
  content: string;
  format?: "richtext" | "markdown";
};

export type InvoiceNoteSection = {
  id: string;
  title: string;
  items: string[];
};

export const INVOICE_DEFAULT_SECTION_ORDER = [
  "scopeOfWork",
  "deliverables",
  "maintenanceIncludes",
] as const;

export type InvoiceDraft = {
  id?: string;
  quoteRequestId?: string;
  serviceType: string;
  preparedFor: string;
  contactPerson: string;
  contactEmail: string;
  contactPhone: string;
  date: string;
  title: string;
  introduction: string;
  scopeOfWork: string[];
  deliverables: string[];
  customSections: InvoiceSection[];
  sectionOrder: string[];
  maintenanceIncludes: string[];
  termsAndNotes: string[];
  noteSections: InvoiceNoteSection[];
  pricingItems: InvoiceLineItem[];
  validityDays: string;
  status: string;
};

export const INVOICE_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "paid", label: "Paid" },
  { value: "overdue", label: "Overdue" },
  { value: "cancelled", label: "Cancelled" },
];

export const INVOICE_SERVICE_TYPES = [
  { value: "website_agent", label: "Website Agent" },
  { value: "whatsapp_agent", label: "WhatsApp Agent" },
  { value: "facebook_agent", label: "Facebook Agent" },
  { value: "voice_agent", label: "Voice Agent" },
  { value: "custom_ai", label: "Custom AI Solution" },
];

const COLORS = {
  ink: "#111111",
  muted: "#5f5f5f",
  faint: "#8b8b8b",
  border: "#d9d9d9",
  panel: "#f5f5f5",
  accent: "#c4f04d",
  bulletAccent: "#6f9900",
  accentSoft: "#eff8cf",
  bgDark: "#0c0c0c",
  white: "#ffffff",
};

type ServiceTemplate = {
  label: string;
  title: (businessName: string) => string;
  summary: (businessName: string) => string;
  scopeOfWork: string[];
  deliverables: string[];
  implementationSteps: string[];
  maintenanceIncludes: string[];
  termsAndNotes: string[];
  pricingItems: InvoiceLineItem[];
};

const SERVICE_TEMPLATES: Record<string, ServiceTemplate> = {
  website_agent: {
    label: "Website Agent",
    title: (businessName) => `Invoice - Website AI Assistant - ${businessName || "Client"}`,
    summary: (businessName) =>
      `This invoice is issued for the completed setup and delivery of a website AI assistant for ${businessName || "the client"}.`,
    scopeOfWork: [
      "Website assistant configuration",
      "Knowledge base preparation",
      "Customer enquiry response setup",
      "Menu and ordering guidance",
      "Testing and refinement",
      "Launch support",
    ],
    deliverables: [
      "Handles frequently asked questions from website visitors",
      "Provides quick answers to menu, pricing, store, and support enquiries",
      "Helps customers find the right information with less effort",
      "Supports catering, platter, and general customer queries",
      "Guides visitors to the correct menu and ordering links",
      "Delivers consistent responses based on approved business information",
      "Improves response speed and overall website user experience",
      "Escalates unresolved or sensitive enquiries to the appropriate contact path",
    ],
    implementationSteps: [],
    maintenanceIncludes: [
      "Hosting and assistant availability",
      "Routine knowledge-base updates",
      "Minor wording and content adjustments",
      "Basic monitoring and support",
      "Normal AI usage for standard website traffic",
    ],
    termsAndNotes: [
      "This invoice is for the completed website AI assistant setup and delivery.",
      "Due: 17 March 2026.",
    ],
    pricingItems: [
      { description: "Website assistant development and configuration", amount: "R3,500", billing: "Once-off" },
      { description: "Monthly maintenance and hosting", amount: "R300/month", billing: "Monthly" },
    ],
  },
  whatsapp_agent: {
    label: "WhatsApp Agent",
    title: (businessName) => `Invoice - WhatsApp AI Agent - ${businessName || "Client"}`,
    summary: (businessName) =>
      `This invoice is issued for the completed setup and delivery of a WhatsApp AI agent for ${businessName || "the client"}.`,
    scopeOfWork: [
      "Discovery of WhatsApp support and lead capture use cases",
      "Knowledge-base setup from approved business information",
      "Conversation flow setup for common inbound enquiries",
      "WhatsApp assistant configuration and testing",
      "Launch preparation and go-live support",
    ],
    deliverables: [
      "Answers common customer questions on WhatsApp",
      "Captures leads and structured enquiry details",
      "Supports FAQ, booking, or enquiry response flows",
      "Uses approved business knowledge for consistent replies",
      "Escalates unresolved cases to a human contact path",
    ],
    implementationSteps: [],
    maintenanceIncludes: [
      "Hosting and assistant availability",
      "Routine knowledge-base updates",
      "Minor flow adjustments",
      "Basic monitoring and support",
      "Meta template message fees are billed separately per delivered template message",
    ],
    termsAndNotes: [
      "This invoice is for the completed WhatsApp AI agent setup and delivery.",
      "Monthly maintenance and hosting, where included, are billed separately on the agreed recurring schedule.",
      "Meta template message charges apply separately to recurring maintenance or usage billing where applicable.",
      "Current Meta template rates for South Africa (USD), effective October 1, 2025:",
      "Marketing: $0.0379",
      "Utility: $0.0076",
      "Authentication: $0.0076",
      "Authentication International: $0.0200",
      "Utility templates sent within an open 24-hour customer service window are typically free under Meta's pricing rules.",
      "Meta may revise rates in future; final billing follows Meta's active rate card at send time.",
      "Additional integrations, revisions, or out-of-scope work are billed separately.",
      "Payment is due within the agreed invoice term.",
    ],
    pricingItems: [
      { description: "WhatsApp agent setup", amount: "R2,500", billing: "Once-off" },
      { description: "Maintenance and hosting", amount: "R300/month", billing: "Monthly" },
      { description: "+ Meta template message charges", amount: "Per Meta rate card", billing: "Usage-based" },
    ],
  },
  facebook_agent: {
    label: "Facebook Agent",
    title: (businessName) => `Invoice - Facebook AI Agent - ${businessName || "Client"}`,
    summary: (businessName) =>
      `This invoice is issued for the completed setup and delivery of a Facebook messaging agent for ${businessName || "the client"}.`,
    scopeOfWork: [
      "Discovery of Facebook messaging support requirements",
      "Knowledge-base setup from approved business information",
      "Conversation flow setup for inbox and page enquiries",
      "Facebook assistant configuration and testing",
      "Launch preparation and go-live support",
    ],
    deliverables: [
      "Answers common customer questions through Facebook messaging",
      "Captures leads and enquiry details from incoming messages",
      "Supports page inbox response flows for routine queries",
      "Uses approved business knowledge for consistent replies",
      "Escalates unresolved cases to a human contact path",
    ],
    implementationSteps: [],
    maintenanceIncludes: [
      "Hosting and assistant availability",
      "Routine knowledge-base updates",
      "Minor flow adjustments",
      "Basic monitoring and support",
    ],
    termsAndNotes: [
      "This invoice is for the completed Facebook messaging agent setup and delivery.",
      "Monthly maintenance and hosting, where included, are billed separately on the agreed recurring schedule.",
      "Platform limitations or account approval requirements remain subject to Meta policies.",
      "Additional integrations, revisions, or out-of-scope work are billed separately.",
      "Payment is due within the agreed invoice term.",
    ],
    pricingItems: [
      { description: "Facebook agent setup", amount: "R2,500", billing: "Once-off" },
      { description: "Maintenance and hosting", amount: "R300/month", billing: "Monthly" },
    ],
  },
  voice_agent: {
    label: "Voice Agent",
    title: (businessName) => `Invoice - AI Voice Agent - ${businessName || "Client"}`,
    summary: (businessName) =>
      `This invoice is issued for the completed setup and delivery of an AI voice agent for ${businessName || "the client"}.`,
    scopeOfWork: [
      "Discovery of call handling requirements and call flows",
      "Call script and routing design",
      "Knowledge-base configuration for call responses",
      "Voice agent setup and test scenarios",
      "Launch preparation and go-live support",
    ],
    deliverables: [
      "Answers inbound calls for routine customer enquiries",
      "Routes or escalates calls based on the agreed flow",
      "Uses approved scripts and business knowledge",
      "Supports after-hours or overflow call handling",
      "Captures enquiry details for follow-up where required",
    ],
    implementationSteps: [],
    maintenanceIncludes: [
      "Hosting and assistant availability",
      "Routine script and knowledge updates",
      "Minor call flow adjustments",
      "Basic monitoring and support",
    ],
    termsAndNotes: [
      "This invoice is for the completed voice agent setup and delivery.",
      "Monthly maintenance and hosting, where included, are billed separately on the agreed recurring schedule.",
      "Telephony usage and provider charges, where applicable, are excluded unless stated otherwise.",
      "Additional integrations, revisions, or out-of-scope work are billed separately.",
      "Payment is due within the agreed invoice term.",
    ],
    pricingItems: [
      { description: "Voice agent setup", amount: "R5,000", billing: "Once-off" },
      { description: "Maintenance and hosting", amount: "R500/month", billing: "Monthly" },
    ],
  },
  custom_ai: {
    label: "Custom AI Solution",
    title: (businessName) => `Invoice - Custom AI Solution - ${businessName || "Client"}`,
    summary: (businessName) =>
      `This invoice is issued for the completed delivery of a custom AI solution for ${businessName || "the client"}.`,
    scopeOfWork: [
      "Discovery and solution design workshop",
      "Definition of project scope, workflows, and integrations",
      "Configuration and development of the agreed AI solution",
      "Testing and refinement before deployment",
      "Launch preparation and go-live support",
    ],
    deliverables: [
      "Custom AI workflow or assistant aligned to the agreed business process",
      "Configured automation logic for the approved use case",
      "Response logic or decision flows tailored to the project",
      "Deployment-ready configuration for the agreed scope",
      "Handover of the implemented solution scope",
    ],
    implementationSteps: [],
    maintenanceIncludes: [
      "Hosting where applicable",
      "Routine monitoring and maintenance",
      "Minor agreed adjustments",
      "Basic support",
    ],
    termsAndNotes: [
      "This invoice is for the completed custom AI delivery described in the agreed scope.",
      "Monthly maintenance and hosting, where included, are billed separately on the agreed recurring schedule.",
      "Additional integrations, change requests, revisions, or scope expansions are billed separately.",
      "Technical dependencies and third-party charges are excluded unless stated otherwise.",
      "Payment is due within the agreed invoice term.",
    ],
    pricingItems: [
      { description: "Custom AI setup", amount: "R6,000", billing: "Once-off" },
      { description: "Maintenance and hosting", amount: "R600/month", billing: "Monthly" },
    ],
  },
};

const LEAD_SERVICE_TO_QUOTE_SERVICE: Record<string, string> = {
  website_chatbot: "website_agent",
  whatsapp_chatbot: "whatsapp_agent",
  voice_agent: "voice_agent",
  custom_agent: "custom_ai",
};

function getServiceTemplate(serviceType: string) {
  return SERVICE_TEMPLATES[serviceType] || SERVICE_TEMPLATES.website_agent;
}

export function getServiceLabel(serviceType: string) {
  return getServiceTemplate(serviceType).label;
}

export function inferServiceTypeFromLead(services: string[]) {
  const mapped = services
    .map((service) => LEAD_SERVICE_TO_QUOTE_SERVICE[service])
    .find(Boolean);
  return mapped || "website_agent";
}

function cloneLineItems(items: InvoiceLineItem[]) {
  return items.map((item) => ({ ...item }));
}

function cloneSections(items: InvoiceSection[]) {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    content: item.content,
    format: item.format || "richtext",
  }));
}

function cloneNoteSections(items: InvoiceNoteSection[]) {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    items: [...item.items],
  }));
}

function parseMoneyAmount(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const normalized = raw.replace(/[^0-9,.-]/g, "");
  if (!normalized) return null;

  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");

  if (hasComma && hasDot) {
    const cleaned = normalized.replace(/,/g, "");
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (hasComma && !hasDot) {
    const cleaned = normalized.replace(/,/g, "");
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function getInvoiceTotal(items: InvoiceLineItem[]) {
  let total = 0;
  let counted = 0;
  for (const item of items) {
    const amount = parseMoneyAmount(item.amount);
    if (amount === null) continue;
    total += amount;
    counted += 1;
  }

  if (counted < 1) return null;
  return total;
}

function formatZar(value: number) {
  const [whole, decimal] = value.toFixed(2).split(".");
  const withSpaces = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `R${withSpaces}.${decimal}`;
}

function normalizeSectionOrder(value: unknown, sections: InvoiceSection[]) {
  const defaultOrder = [...INVOICE_DEFAULT_SECTION_ORDER];
  const customIds = sections.map((section) => `custom:${section.id}`);
  const requested = Array.isArray(value) ? value.map((item) => String(item)) : [];
  const known = new Set([...defaultOrder, ...customIds]);
  const filtered = requested.filter((entry) => known.has(entry));

  const withDefaults = [...defaultOrder.filter((entry) => !filtered.includes(entry)), ...filtered];
  const withCustom = [...withDefaults, ...customIds.filter((entry) => !withDefaults.includes(entry))];
  return withCustom;
}

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

export function formatInvoiceDateInput(date: Date, useUTC = false) {
  const year = useUTC ? date.getUTCFullYear() : date.getFullYear();
  const month = useUTC ? date.getUTCMonth() + 1 : date.getMonth() + 1;
  const day = useUTC ? date.getUTCDate() : date.getDate();
  return `${year}-${padDatePart(month)}-${padDatePart(day)}`;
}

export function parseInvoiceDateInput(value?: string | null) {
  if (!value) return new Date();
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return new Date(value);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

export function getTemplateDraft(serviceType: string, lead?: Partial<QuoteLead>): InvoiceDraft {
  const today = formatInvoiceDateInput(new Date());
  const businessName = lead?.businessName || "";
  const template = getServiceTemplate(serviceType);

  return {
    id: undefined,
    quoteRequestId: lead?.id,
    serviceType,
    preparedFor: businessName,
    contactPerson: lead?.contactPerson || "",
    contactEmail: lead?.email || "",
    contactPhone: lead?.phone || "",
    date: today,
    title: template.title(businessName),
    introduction: template.summary(businessName),
    scopeOfWork: [...template.scopeOfWork],
    deliverables: [...template.deliverables],
    customSections: [],
    sectionOrder: [...INVOICE_DEFAULT_SECTION_ORDER],
    maintenanceIncludes: [...template.maintenanceIncludes],
    termsAndNotes: [...template.termsAndNotes],
    noteSections: [],
    pricingItems: cloneLineItems(template.pricingItems),
    validityDays: "14",
    status: "draft",
  };
}

export function applyTemplateToDraft(
  draft: InvoiceDraft,
  serviceType: string
): InvoiceDraft {
  const template = getTemplateDraft(serviceType, {
    id: draft.quoteRequestId,
    businessName: draft.preparedFor,
    contactPerson: draft.contactPerson,
    email: draft.contactEmail,
    phone: draft.contactPhone,
    services: [],
  });

  return {
    ...draft,
    serviceType,
    title: template.title,
    introduction: template.introduction,
    scopeOfWork: template.scopeOfWork,
    deliverables: template.deliverables,
    customSections: cloneSections(draft.customSections),
    sectionOrder: normalizeSectionOrder(draft.sectionOrder, draft.customSections),
    maintenanceIncludes: template.maintenanceIncludes,
    termsAndNotes: template.termsAndNotes,
    noteSections: cloneNoteSections(draft.noteSections),
    pricingItems: template.pricingItems,
  };
}

export function getDefaultInvoiceDraft(lead: QuoteLead): InvoiceDraft {
  return getTemplateDraft(inferServiceTypeFromLead(lead.services), lead);
}

function asStringArray(value: unknown, fallback: string[]) {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : fallback;
}

function asLineItems(value: unknown, fallback: InvoiceLineItem[]) {
  if (!Array.isArray(value)) return cloneLineItems(fallback);
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      return {
        description: String(record.description || ""),
        amount: String(record.amount || ""),
        billing: String(record.billing || ""),
      };
    })
    .filter((item): item is InvoiceLineItem => Boolean(item));
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

function asNoteSections(value: unknown): InvoiceNoteSection[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const id = String(record.id || "").trim() || `note_${Math.random().toString(36).slice(2, 10)}`;
      const title = String(record.title || "").trim();
      const items = Array.isArray(record.items)
        ? record.items.map((entry) => String(entry).trim()).filter(Boolean)
        : [];
      if (!title && items.length === 0) return null;
      return { id, title, items };
    })
    .filter((item): item is Exclude<typeof item, null> => Boolean(item));
}

function asSections(value: unknown): InvoiceSection[] {
  if (!Array.isArray(value)) return [];

  const objectSections = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const id = String(record.id || "").trim() || `section_${Math.random().toString(36).slice(2, 10)}`;
      const title = String(record.title || "").trim();
      const content = String(record.content || "").trim();
      const format: InvoiceSection["format"] =
        record.format === "markdown" ? "markdown" : "richtext";
      const items = Array.isArray(record.items)
        ? record.items.map((entry) => String(entry).trim()).filter(Boolean)
        : [];
      const fallbackContent =
        content || (items.length > 0 ? `<ul>${items.map((entry) => `<li>${entry}</li>`).join("")}</ul>` : "");
      if (!title && !fallbackContent) return null;
      return { id, title, content: fallbackContent, format };
    })
    .filter((item): item is Exclude<typeof item, null> => Boolean(item));

  if (objectSections.length > 0) return objectSections;

  const textLines = value.map((item) => String(item).trim()).filter(Boolean);
  if (textLines.length === 0) return [];
  return [
    {
      id: `legacy_${Math.random().toString(36).slice(2, 10)}`,
      title: "Additional Section",
      content: `<ul>${textLines.map((entry) => `<li>${entry}</li>`).join("")}</ul>`,
      format: "richtext",
    },
  ];
}

function htmlToTextLines(content: string) {
  if (!content) return [];

  const normalized = content
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<li>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');

  return normalized
    .split("\n")
    .map((line) => line.trim().replace(/^(?:[-*•]\s+)+/, ""))
    .filter(Boolean);
}

function markdownToTextLines(content: string) {
  if (!content) return [];

  const lines = content
    .split("\n")
    .map((line) =>
      line
        .replace(/^#{1,6}\s*/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+\.\s+/, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/__(.*?)__/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/_(.*?)_/g, "$1")
        .replace(/`(.*?)`/g, "$1")
        .trim()
        .replace(/^(?:[-*•]\s+)+/, "")
    )
    .filter(Boolean);

  return lines;
}

function summaryToLines(content: string) {
  const raw = String(content || "").trim();
  if (!raw) return [];

  if (/<[^>]+>/.test(raw)) {
    const prepared = raw
      .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_match, inner) => {
        let index = 0;
        return String(inner).replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_liMatch, liContent) => {
          index += 1;
          return `<p>${index}. ${liContent}</p>`;
        });
      })
      .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_match, inner) =>
        String(inner).replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "<p>$1</p>")
      );
    return htmlToTextLines(prepared);
  }

  const numbered = raw.split(/\s+(?=\d+\.\s)/g).map((line) => line.trim()).filter(Boolean);
  if (numbered.length > 1) return numbered;

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function invoiceRecordToDraft(record: {
  id: string;
  quoteRequestId: string | null;
  businessName: string;
  contactPerson: string;
  contactEmail: string;
  contactPhone: string;
  date: Date;
  serviceType: string;
  title: string;
  introduction: string | null;
  scopeOfWork: unknown;
  deliverables: unknown;
  implementationSteps: unknown;
  includedFunctionality: unknown;
  pricingItems: unknown;
  maintenanceIncludes: unknown;
  termsAndNotes: unknown;
  importantNotes: unknown;
  validityDays: number;
  status: string;
}): InvoiceDraft {
  const fallback = getTemplateDraft(record.serviceType, {
    businessName: record.businessName,
    contactPerson: record.contactPerson,
    email: record.contactEmail,
    phone: record.contactPhone,
    services: [],
  });

  const customSections = asSections(record.implementationSteps);
  const noteSections = asNoteSections(record.importantNotes);

  return {
    id: record.id,
    quoteRequestId: record.quoteRequestId ?? undefined,
    serviceType: record.serviceType,
    preparedFor: record.businessName,
    contactPerson: record.contactPerson,
    contactEmail: record.contactEmail,
    contactPhone: record.contactPhone,
    date: formatInvoiceDateInput(record.date, true),
    title: record.title,
    introduction: record.introduction || "",
    scopeOfWork: asStringArray(record.scopeOfWork, fallback.scopeOfWork),
    deliverables: asStringArray(record.deliverables, fallback.deliverables),
    customSections,
    sectionOrder: normalizeSectionOrder(record.includedFunctionality, customSections),
    maintenanceIncludes: asStringArray(
      record.maintenanceIncludes,
      fallback.maintenanceIncludes
    ),
    termsAndNotes: normalizeTermsAndNotes(
      asStringArray(record.termsAndNotes, fallback.termsAndNotes)
    ),
    noteSections,
    pricingItems: asLineItems(record.pricingItems, fallback.pricingItems),
    validityDays: String(record.validityDays),
    status: record.status,
  };
}

export function formatInvoiceNumber(draft: Pick<InvoiceDraft, "id" | "date">) {
  const datePart = draft.date.replace(/-/g, "");
  const suffix = (draft.id || "draft").replace(/[^a-zA-Z0-9]/g, "").slice(-6).toUpperCase();
  return `KI-${datePart}-${suffix || "DRAFT"}`;
}

export function getPreparedByDetails(serviceType?: string) {
  return {
    company: "KasiTek",
    descriptor: "AI automation solutions",
    accountName: "Enock Chirima",
    bankName: "FNB",
    accountType: "Savings",
    accountNumber: "63093955012",
    branchCode: "250655",
    phone: "+27 73 123 1909",
    website: "kasitek.co.za",
  };
}

export function buildInvoicePdf(draft: InvoiceDraft) {
  const pages: PdfOp[][] = [[]];
  let pageIndex = 0;
  let y = 802;

  const pageWidth = 595;
  const left = 40;
  const contentWidth = 515;
  const preparedBy = getPreparedByDetails(draft.serviceType);

  function currentPage() {
    return pages[pageIndex];
  }

  function addPage() {
    pages.push([]);
    pageIndex += 1;
    y = 802;
  }

  function ensureSpace(required: number) {
    if (y - required < 50) addPage();
  }

  function drawHeader() {
    const page = currentPage();
    page.push({ type: "rect", x: 0, y: 834, width: pageWidth, height: 8, fill: COLORS.accent });
    page.push({ type: "rect", x: 0, y: 742, width: pageWidth, height: 92, fill: COLORS.bgDark });
    page.push({ type: "text", x: left, y: 792, text: "Kasi", size: 28, font: "F2", color: COLORS.white });
    page.push({
      type: "text",
      x: left + 54,
      y: 792,
      text: "Tek",
      size: 28,
      font: "F2",
      color: COLORS.accent,
    });
    page.push({ type: "text", x: left, y: 772, text: "Invoice", size: 12, font: "F1", color: "#d4d4d4" });
    page.push({
      type: "text",
      x: 360,
      y: 792,
      text: `Invoice No: ${formatInvoiceNumber(draft)}`,
      size: 11,
      font: "F2",
      color: COLORS.white,
    });
    page.push({
      type: "text",
      x: 360,
      y: 776,
      text: `Date: ${draft.date}`,
      size: 10,
      font: "F1",
      color: "#d4d4d4",
    });
    page.push({
      type: "text",
      x: 360,
      y: 760,
      text: `${preparedBy.company}  |  ${preparedBy.phone}  |  ${preparedBy.website}`,
      size: 9,
      font: "F1",
      color: "#d4d4d4",
    });
  }

  function addSectionTitle(title: string) {
    ensureSpace(26);
    currentPage().push({
      type: "line",
      x1: left,
      y1: y + 6,
      x2: left + 28,
      y2: y + 6,
      stroke: COLORS.accent,
      lineWidth: 2,
    });
    currentPage().push({
      type: "text",
      x: left + 34,
      y,
      text: title,
      size: 12,
      font: "F2",
      color: COLORS.ink,
    });
    y -= 20;
  }

  function addTextBlock(
    text: string,
    size: number,
    width: number,
    options?: { font?: "F1" | "F2"; color?: string; lineHeight?: number; x?: number }
  ) {
    const lines = wrapText(text, width, size);
    const lineHeight = options?.lineHeight || size + 4;
    ensureSpace(lines.length * lineHeight + 6);

    for (const line of lines) {
      currentPage().push({
        type: "text",
        x: options?.x ?? left,
        y,
        text: line,
        size,
        font: options?.font || "F1",
        color: options?.color || COLORS.ink,
      });
      y -= lineHeight;
    }
    y -= 4;
  }

  function addBullets(items: string[]) {
    for (const item of items) {
      ensureSpace(24);
      currentPage().push({
        type: "text",
        x: left + 2,
        y,
        text: "-",
        size: 11,
        font: "F2",
        color: COLORS.bulletAccent,
      });
      const lines = wrapText(item, contentWidth - 22, 10);
      for (const line of lines) {
        currentPage().push({
          type: "text",
          x: left + 16,
          y,
          text: line,
          size: 10,
          font: "F1",
          color: COLORS.ink,
        });
        y -= 14;
      }
      y -= 3;
    }
  }

  function addInfoBox(x: number, topY: number, title: string, lines: string[]) {
    const boxWidth = 515;
    const boxHeight = 56;
    currentPage().push({
      type: "rect",
      x,
      y: topY - boxHeight + 12,
      width: boxWidth,
      height: boxHeight,
      fill: "#fbfbfb",
      stroke: COLORS.border,
      lineWidth: 1,
    });
    currentPage().push({
      type: "text",
      x: x + 14,
      y: topY,
      text: title,
      size: 9,
      font: "F2",
      color: COLORS.ink,
    });
    let lineY = topY - 15;
    const compactLines = lines.filter(Boolean).slice(0, 4);
    compactLines.forEach((line, index) => {
      currentPage().push({
        type: "text",
        x: x + 14 + (index % 2 === 1 ? 250 : 0),
        y: lineY - Math.floor(index / 2) * 13,
        text: line,
        size: 9,
        font: index === 0 ? "F2" : "F1",
        color: index === 0 ? COLORS.ink : COLORS.muted,
      });
    });
    if (compactLines.length <= 2) {
      currentPage().push({
        type: "text",
        x: x + 264,
        y: lineY,
        text: "",
        size: 9,
        font: "F1",
        color: COLORS.muted,
      });
    }
  }

  function addPricingTable(items: InvoiceLineItem[]) {
    ensureSpace(72 + items.length * 24);
    const topY = y;
    currentPage().push({
      type: "rect",
      x: left,
      y: topY - (44 + items.length * 24),
      width: contentWidth,
      height: 44 + items.length * 24,
      fill: "#ffffff",
      stroke: COLORS.border,
      lineWidth: 1,
    });
    currentPage().push({
      type: "rect",
      x: left,
      y: topY - 28,
      width: contentWidth,
      height: 28,
      fill: COLORS.accentSoft,
    });

    const cols = [left + 14, left + 300, left + 412];
    const headers = ["Description", "Amount", "Billing"];
    headers.forEach((header, index) => {
      currentPage().push({
        type: "text",
        x: cols[index],
        y: topY - 18,
        text: header,
        size: 10,
        font: "F2",
        color: COLORS.ink,
      });
    });

    items.forEach((item, index) => {
      const rowY = topY - 42 - index * 24;
      currentPage().push({
        type: "line",
        x1: left,
        y1: rowY + 12,
        x2: left + contentWidth,
        y2: rowY + 12,
        stroke: COLORS.border,
        lineWidth: 1,
      });
      [item.description, item.amount, item.billing].forEach((cell, cellIndex) => {
        currentPage().push({
          type: "text",
          x: cols[cellIndex],
          y: rowY,
          text: cell,
          size: 10,
          font: cellIndex === 1 ? "F2" : "F1",
          color: COLORS.ink,
        });
      });
    });

    y -= 60 + items.length * 24;
  }

  function addPanelSection(title: string, items: string[]) {
    const estimatedHeight = 34 + items.length * 18 + 18;
    ensureSpace(estimatedHeight);
    const topY = y;

    currentPage().push({
      type: "rect",
      x: left,
      y: topY - estimatedHeight + 10,
      width: contentWidth,
      height: estimatedHeight,
      fill: COLORS.panel,
      stroke: COLORS.border,
      lineWidth: 1,
    });

    currentPage().push({
      type: "rect",
      x: left,
      y: topY - 26,
      width: contentWidth,
      height: 26,
      fill: COLORS.accentSoft,
    });

    currentPage().push({
      type: "text",
      x: left + 14,
      y: topY - 16,
      text: title,
      size: 11,
      font: "F2",
      color: COLORS.ink,
    });

    let itemY = topY - 42;
    for (const item of items) {
      currentPage().push({
        type: "text",
        x: left + 14,
        y: itemY,
        text: "-",
        size: 11,
        font: "F2",
        color: COLORS.bulletAccent,
      });

      const lines = wrapText(item, contentWidth - 34, 10);
      for (const line of lines) {
        currentPage().push({
          type: "text",
          x: left + 28,
          y: itemY,
          text: line,
          size: 10,
          font: "F1",
          color: COLORS.ink,
        });
        itemY -= 14;
      }
      itemY -= 4;
    }

    y -= estimatedHeight + 12;
  }

  function estimatePanelHeight(width: number, items: string[]) {
    let lines = 0;
    for (const item of items) {
      lines += wrapText(item, width - 30, 8).length;
    }
    return 28 + lines * 11 + items.length * 2 + 14;
  }

  function addTwoColumnPanels(
    leftTitle: string,
    leftItems: string[],
    rightTitle: string,
    rightItems: string[]
  ) {
    const gap = 12;
    const colWidth = (contentWidth - gap) / 2;
    const leftHeight = estimatePanelHeight(colWidth, leftItems);
    const rightHeight = estimatePanelHeight(colWidth, rightItems);
    const panelHeight = Math.max(leftHeight, rightHeight);

    ensureSpace(panelHeight);
    const topY = y;

    function drawPanel(x: number, title: string, items: string[]) {
      currentPage().push({
        type: "rect",
        x,
        y: topY - panelHeight + 10,
        width: colWidth,
        height: panelHeight,
        fill: COLORS.panel,
        stroke: COLORS.border,
        lineWidth: 1,
      });

      currentPage().push({
        type: "rect",
        x,
        y: topY - 22,
        width: colWidth,
        height: 22,
        fill: COLORS.accentSoft,
      });

      currentPage().push({
        type: "text",
        x: x + 14,
        y: topY - 14,
        text: title,
        size: 9,
        font: "F2",
        color: COLORS.ink,
      });

      let itemY = topY - 34;
      for (const item of items) {
        currentPage().push({
          type: "text",
          x: x + 14,
          y: itemY,
          text: "-",
          size: 9,
          font: "F2",
          color: COLORS.bulletAccent,
        });

        const lines = wrapText(item, colWidth - 30, 8);
        for (const line of lines) {
          currentPage().push({
            type: "text",
            x: x + 28,
            y: itemY,
            text: line,
            size: 8,
            font: "F1",
            color: COLORS.ink,
          });
          itemY -= 11;
        }
        itemY -= 2;
      }
    }

    drawPanel(left, leftTitle, leftItems);
    drawPanel(left + colWidth + gap, rightTitle, rightItems);

    y -= panelHeight + 12;
  }

  function addThreeColumnPanels(
    firstTitle: string,
    firstItems: string[],
    secondTitle: string,
    secondItems: string[],
    thirdTitle: string,
    thirdItems: string[]
  ) {
    const gap = 10;
    const colWidth = (contentWidth - gap * 2) / 3;
    const firstHeight = estimatePanelHeight(colWidth, firstItems);
    const secondHeight = estimatePanelHeight(colWidth, secondItems);
    const thirdHeight = estimatePanelHeight(colWidth, thirdItems);
    const panelHeight = Math.max(firstHeight, secondHeight, thirdHeight);

    ensureSpace(panelHeight);
    const topY = y;

    function drawPanel(x: number, title: string, items: string[]) {
      currentPage().push({
        type: "rect",
        x,
        y: topY - panelHeight + 10,
        width: colWidth,
        height: panelHeight,
        fill: COLORS.panel,
        stroke: COLORS.border,
        lineWidth: 1,
      });

      currentPage().push({
        type: "rect",
        x,
        y: topY - 22,
        width: colWidth,
        height: 22,
        fill: COLORS.accentSoft,
      });

      currentPage().push({
        type: "text",
        x: x + 10,
        y: topY - 14,
        text: title,
        size: 9,
        font: "F2",
        color: COLORS.ink,
      });

      let itemY = topY - 34;
      for (const item of items) {
        currentPage().push({
          type: "text",
          x: x + 10,
          y: itemY,
          text: "-",
          size: 9,
          font: "F2",
          color: COLORS.bulletAccent,
        });

        const lines = wrapText(item, colWidth - 24, 8);
        for (const line of lines) {
          currentPage().push({
            type: "text",
            x: x + 20,
            y: itemY,
            text: line,
            size: 8,
            font: "F1",
            color: COLORS.ink,
          });
          itemY -= 11;
        }
        itemY -= 2;
      }
    }

    drawPanel(left, firstTitle, firstItems);
    drawPanel(left + colWidth + gap, secondTitle, secondItems);
    drawPanel(left + (colWidth + gap) * 2, thirdTitle, thirdItems);
    y -= panelHeight + 12;
  }

  drawHeader();
  addInfoBox(left, 714, "Billed To", [
    draft.preparedFor || "-",
    draft.contactEmail || "-",
  ]);

  y = 646;
  addTextBlock(draft.title, 15, contentWidth, { font: "F2", color: COLORS.ink, lineHeight: 19 });
  const summaryLines = summaryToLines(draft.introduction);
  if (summaryLines.length > 0) {
    addSectionTitle("Project Summary");
    for (const line of summaryLines) {
      addTextBlock(line, 10, contentWidth, { color: COLORS.ink, lineHeight: 16 });
    }
  }

  const customSectionMap = new Map(draft.customSections.map((section) => [section.id, section]));
  const orderedSections = normalizeSectionOrder(draft.sectionOrder, draft.customSections);

  const SERVICE_ONE_TITLE_ID = "service_1_title";
  const SERVICE_TWO_INCLUDED_ID = "service_2_included";
  const SERVICE_TWO_FEATURES_ID = "service_2_features";
  const SERVICE_TWO_MAINTENANCE_ID = "service_2_maintenance";

  function customSectionLines(sectionId: string) {
    const section = customSectionMap.get(sectionId);
    if (!section) return [];
    return section.format === "markdown"
      ? markdownToTextLines(section.content)
      : htmlToTextLines(section.content);
  }

  const serviceOneIncluded = draft.scopeOfWork;
  const serviceOneFeatures = draft.deliverables;
  const serviceOneMaintenance = draft.maintenanceIncludes;
  const serviceOneTitle = customSectionMap.get(SERVICE_ONE_TITLE_ID)?.title?.trim() || "Service 1";

  const serviceTwoIncluded = customSectionLines(SERVICE_TWO_INCLUDED_ID);
  const serviceTwoFeatures = customSectionLines(SERVICE_TWO_FEATURES_ID);
  const serviceTwoMaintenance = customSectionLines(SERVICE_TWO_MAINTENANCE_ID);

  if (serviceOneIncluded.length || serviceOneFeatures.length || serviceOneMaintenance.length) {
    addSectionTitle(serviceOneTitle);
    addThreeColumnPanels(
      "Included Services",
      serviceOneIncluded,
      "Features",
      serviceOneFeatures,
      "Maintenance",
      serviceOneMaintenance
    );
  }

  if (serviceTwoIncluded.length || serviceTwoFeatures.length || serviceTwoMaintenance.length) {
    const serviceTwoSection = customSectionMap.get(SERVICE_TWO_INCLUDED_ID);
    const serviceTwoTitle = serviceTwoSection?.title?.split(" - ")[0]?.trim() || "Service 2";
    addSectionTitle(serviceTwoTitle);
    addThreeColumnPanels(
      "Included Services",
      serviceTwoIncluded,
      "Features",
      serviceTwoFeatures,
      "Maintenance",
      serviceTwoMaintenance
    );
  }

  for (const sectionId of orderedSections) {
    if (sectionId === "scopeOfWork") continue;
    if (sectionId === "deliverables") continue;
    if (sectionId === "maintenanceIncludes") continue;
    if (!sectionId.startsWith("custom:")) continue;
    const rawCustomId = sectionId.replace("custom:", "");
    if (
      rawCustomId === SERVICE_ONE_TITLE_ID ||
      rawCustomId === SERVICE_TWO_INCLUDED_ID ||
      rawCustomId === SERVICE_TWO_FEATURES_ID ||
      rawCustomId === SERVICE_TWO_MAINTENANCE_ID
    ) {
      continue;
    }
    const section = customSectionMap.get(rawCustomId);
    if (!section) continue;
    const title = section.title.trim();
    const lines =
      section.format === "markdown"
        ? markdownToTextLines(section.content)
        : htmlToTextLines(section.content);
    if (!title || lines.length === 0) continue;
    addSectionTitle(title);
    addBullets(lines);
  }

  addSectionTitle("Pricing");
  addPricingTable(draft.pricingItems);

  y -= 8;

  const invoiceTotal = getInvoiceTotal(draft.pricingItems);
  if (invoiceTotal !== null) {
    addTextBlock(`Total Due: ${formatZar(invoiceTotal)}`, 13, contentWidth, {
      font: "F2",
      color: COLORS.ink,
    });
  }

  y -= 20;

  addSectionTitle("Payment Details");
  addBullets([
    `Account Name: ${preparedBy.accountName}`,
    `Bank: ${preparedBy.bankName}`,
    `Account Type: ${preparedBy.accountType}`,
    `Account Number: ${preparedBy.accountNumber}`,
    `Branch Code: ${preparedBy.branchCode}`,
  ]);

  y -= 10;

  addSectionTitle("Terms and Notes");
  addBullets(draft.termsAndNotes);

  for (const noteSection of draft.noteSections) {
    const title = noteSection.title.trim();
    const items = noteSection.items.map((item) => item.trim()).filter(Boolean);
    if (!title || items.length === 0) continue;
    addSectionTitle(title);
    addBullets(items);
  }

  return buildPdfFromOps(pages);
}
