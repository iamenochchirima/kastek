import { buildPdfFromOps, wrapText, type PdfOp } from "@/lib/pdf";

type QuoteLead = {
  id?: string;
  businessName: string;
  contactPerson: string;
  email: string;
  phone: string;
  services: string[];
};

export type QuotationLineItem = {
  description: string;
  amount: string;
  billing: string;
};

export type QuotationDraft = {
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
  implementationSteps: string[];
  maintenanceIncludes: string[];
  termsAndNotes: string[];
  pricingItems: QuotationLineItem[];
  validityDays: string;
  status: string;
};

export const QUOTATION_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
];

export const QUOTATION_SERVICE_TYPES = [
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
  pricingItems: QuotationLineItem[];
};

const SERVICE_TEMPLATES: Record<string, ServiceTemplate> = {
  website_agent: {
    label: "Website Agent",
    title: (businessName) => `Website AI Assistant for ${businessName || "Client"}`,
    summary: (businessName) =>
      `This quotation covers the deployment of a website AI assistant for ${businessName || "the client"}. ` +
      "The solution is designed to improve the customer experience on the website by helping visitors get fast, clear, and reliable answers without unnecessary friction.",
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
      "This quotation covers the website agent scope described above only.",
      "Monthly maintenance includes hosting, monitoring, normal AI usage, and minor knowledge-base updates.",
      "Additional features, integrations, or major revisions will be quoted separately.",
      "Final go-live is subject to testing and client approval.",
      "This quotation is based on the approved business information available at the time of deployment.",
    ],
    pricingItems: [
      { description: "Website assistant deployment and configuration", amount: "R3,500", billing: "Once-off" },
      { description: "Monthly maintenance and hosting", amount: "R300/month", billing: "Monthly" },
    ],
  },
  whatsapp_agent: {
    label: "WhatsApp Agent",
    title: (businessName) => `WhatsApp AI Agent for ${businessName || "Client"}`,
    summary: (businessName) =>
      `This quotation covers the setup of a WhatsApp AI agent for ${businessName || "the client"}. ` +
      "The solution is intended to answer customer messages faster, capture leads, and automate routine support on WhatsApp.",
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
    ],
    termsAndNotes: [
      "This quotation covers the WhatsApp agent scope described above only.",
      "Meta or third-party platform charges, where applicable, are excluded unless stated otherwise.",
      "Additional integrations or major revisions will be quoted separately.",
    ],
    pricingItems: [
      { description: "WhatsApp agent setup", amount: "R2,500", billing: "Once-off" },
      { description: "Maintenance and hosting", amount: "R300/month", billing: "Monthly" },
    ],
  },
  facebook_agent: {
    label: "Facebook Agent",
    title: (businessName) => `Facebook AI Agent for ${businessName || "Client"}`,
    summary: (businessName) =>
      `This quotation covers the setup of a Facebook page messaging agent for ${businessName || "the client"}. ` +
      "The solution is intended to improve first-response speed, handle common enquiries, and support lead capture through Facebook messaging.",
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
      "This quotation covers the Facebook messaging agent scope described above only.",
      "Platform limitations or account approval requirements remain subject to Meta policies.",
      "Additional integrations or major revisions will be quoted separately.",
    ],
    pricingItems: [
      { description: "Facebook agent setup", amount: "R2,500", billing: "Once-off" },
      { description: "Maintenance and hosting", amount: "R300/month", billing: "Monthly" },
    ],
  },
  voice_agent: {
    label: "Voice Agent",
    title: (businessName) => `AI Voice Agent for ${businessName || "Client"}`,
    summary: (businessName) =>
      `This quotation covers the setup of an AI voice agent for ${businessName || "the client"}. ` +
      "The solution is intended to help manage inbound calls, route enquiries, and improve coverage outside normal business hours.",
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
      "This quotation covers the voice agent scope described above only.",
      "Telephony usage and provider charges, where applicable, are excluded unless stated otherwise.",
      "Additional integrations or major revisions will be quoted separately.",
    ],
    pricingItems: [
      { description: "Voice agent setup", amount: "R5,000", billing: "Once-off" },
      { description: "Maintenance and hosting", amount: "R500/month", billing: "Monthly" },
    ],
  },
  custom_ai: {
    label: "Custom AI Solution",
    title: (businessName) => `Custom AI Solution for ${businessName || "Client"}`,
    summary: (businessName) =>
      `This quotation covers the design and implementation of a custom AI solution for ${businessName || "the client"}. ` +
      "The final scope can include automation, integrations, multi-channel support, or tailored AI workflows depending on project requirements.",
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
      "This quotation covers the custom AI scope described above only.",
      "Additional integrations, change requests, or scope expansions will be quoted separately.",
      "Technical dependencies and third-party charges are excluded unless stated otherwise.",
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

function cloneLineItems(items: QuotationLineItem[]) {
  return items.map((item) => ({ ...item }));
}

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

export function formatQuotationDateInput(date: Date, useUTC = false) {
  const year = useUTC ? date.getUTCFullYear() : date.getFullYear();
  const month = useUTC ? date.getUTCMonth() + 1 : date.getMonth() + 1;
  const day = useUTC ? date.getUTCDate() : date.getDate();
  return `${year}-${padDatePart(month)}-${padDatePart(day)}`;
}

export function parseQuotationDateInput(value?: string | null) {
  if (!value) return new Date();
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return new Date(value);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

export function getTemplateDraft(serviceType: string, lead?: Partial<QuoteLead>): QuotationDraft {
  const today = formatQuotationDateInput(new Date());
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
    implementationSteps: [...template.implementationSteps],
    maintenanceIncludes: [...template.maintenanceIncludes],
    termsAndNotes: [...template.termsAndNotes],
    pricingItems: cloneLineItems(template.pricingItems),
    validityDays: "14",
    status: "draft",
  };
}

export function applyTemplateToDraft(
  draft: QuotationDraft,
  serviceType: string
): QuotationDraft {
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
    implementationSteps: template.implementationSteps,
    maintenanceIncludes: template.maintenanceIncludes,
    termsAndNotes: template.termsAndNotes,
    pricingItems: template.pricingItems,
  };
}

export function getDefaultQuotationDraft(lead: QuoteLead): QuotationDraft {
  return getTemplateDraft(inferServiceTypeFromLead(lead.services), lead);
}

function asStringArray(value: unknown, fallback: string[]) {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : fallback;
}

function asLineItems(value: unknown, fallback: QuotationLineItem[]) {
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
    .filter((item): item is QuotationLineItem => Boolean(item));
}

export function quotationRecordToDraft(record: {
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
  pricingItems: unknown;
  maintenanceIncludes: unknown;
  termsAndNotes: unknown;
  validityDays: number;
  status: string;
}): QuotationDraft {
  const fallback = getTemplateDraft(record.serviceType, {
    businessName: record.businessName,
    contactPerson: record.contactPerson,
    email: record.contactEmail,
    phone: record.contactPhone,
    services: [],
  });

  return {
    id: record.id,
    quoteRequestId: record.quoteRequestId ?? undefined,
    serviceType: record.serviceType,
    preparedFor: record.businessName,
    contactPerson: record.contactPerson,
    contactEmail: record.contactEmail,
    contactPhone: record.contactPhone,
    date: formatQuotationDateInput(record.date, true),
    title: record.title,
    introduction: record.introduction || "",
    scopeOfWork: asStringArray(record.scopeOfWork, fallback.scopeOfWork),
    deliverables: asStringArray(record.deliverables, fallback.deliverables),
    implementationSteps: asStringArray(
      record.implementationSteps,
      fallback.implementationSteps
    ),
    maintenanceIncludes: asStringArray(
      record.maintenanceIncludes,
      fallback.maintenanceIncludes
    ),
    termsAndNotes: asStringArray(record.termsAndNotes, fallback.termsAndNotes),
    pricingItems: asLineItems(record.pricingItems, fallback.pricingItems),
    validityDays: String(record.validityDays),
    status: record.status,
  };
}

export function formatQuotationNumber(draft: Pick<QuotationDraft, "id" | "date">) {
  const datePart = draft.date.replace(/-/g, "");
  const suffix = (draft.id || "draft").replace(/[^a-zA-Z0-9]/g, "").slice(-6).toUpperCase();
  return `KQ-${datePart}-${suffix || "DRAFT"}`;
}

export function getPreparedByDetails() {
  return {
    company: "KasiAI",
    descriptor: "AI automation solutions",
    phone: "+27 73 123 1909",
    website: "kasiai.site",
  };
}

export function buildQuotationPdf(draft: QuotationDraft) {
  const pages: PdfOp[][] = [[]];
  let pageIndex = 0;
  let y = 802;

  const pageWidth = 595;
  const left = 40;
  const contentWidth = 515;
  const preparedBy = getPreparedByDetails();

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
    page.push({ type: "text", x: left + 54, y: 792, text: "AI", size: 28, font: "F2", color: COLORS.accent });
    page.push({ type: "text", x: left, y: 772, text: "Quotation", size: 12, font: "F1", color: "#d4d4d4" });
    page.push({
      type: "text",
      x: 360,
      y: 792,
      text: `Quotation No: ${formatQuotationNumber(draft)}`,
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
      text: `Service: ${getServiceLabel(draft.serviceType)}`,
      size: 10,
      font: "F1",
      color: "#d4d4d4",
    });
    page.push({
      type: "text",
      x: 360,
      y: 752,
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
        color: COLORS.accent,
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

  function addPricingTable(items: QuotationLineItem[]) {
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
        color: COLORS.accent,
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
          color: COLORS.accent,
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

  drawHeader();
  addInfoBox(left, 714, "Prepared For", [
    draft.preparedFor || "-",
    draft.contactEmail || "-",
  ]);

  y = 646;
  addTextBlock(draft.title, 15, contentWidth, { font: "F2", color: COLORS.ink, lineHeight: 19 });
  addSectionTitle("Project Summary");
  addTextBlock(draft.introduction, 10, contentWidth, { color: COLORS.muted, lineHeight: 16 });

  addSectionTitle("Included in Service");
  addBullets(draft.scopeOfWork);

  addSectionTitle("Assistant Features");
  addBullets(draft.deliverables);

  addSectionTitle("Pricing");
  addPricingTable(draft.pricingItems);

  addTwoColumnPanels(
    "Monthly Maintenance",
    draft.maintenanceIncludes,
    "Terms and Notes",
    draft.termsAndNotes
  );

  return buildPdfFromOps(pages);
}
