import { createId } from "@paralleldrive/cuid2";
import type { CoreContext } from "../../context.js";
import { ApiError } from "../../error.js";
import { publishAdminNotification } from "../admin-notification-publisher.js";
import { recordSubmission } from "../early-access.js";
import { sendOrganizationEmail } from "../org-support.js";
import { bad, optionalUrl } from "./lead-validation.js";
import { WEBSITE_SQL as sql } from "./sql.js";
const BUSINESS_TYPES = [
  "individual",
  "restaurant",
  "retail",
  "healthcare",
  "real_estate",
  "automotive",
  "professional_services",
  "salon_spa",
  "construction",
  "logistics",
  "other",
];
const SERVICES = [
  "custom_ai_chatbots",
  "voice_agents",
  "growth_workflows",
  "system_integrations",
  "digital_infrastructure",
  "managed_retainers",
];
const PRODUCTS = [
  "kasitek_growth",
  "kasitek_agency",
  "kasitek_agents",
  "kasitek_suite",
  "kasitek_product_basic",
  "kasitek_product_growth",
  "kasitek_product_scale",
  "feature_agents",
  "feature_campaigns",
  "feature_content",
  "kasiagents",
  "kasireach",
  "kasisocial",
];
export interface QuoteInput {
  businessName?: string | null;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  businessType?: string | null;
  services?: string[] | null;
  description?: string | null;
}
export interface WaitlistInput
  extends Omit<QuoteInput, "services" | "description"> {
  companyWebsite?: string | null;
  products?: string[] | null;
  notes?: string | null;
  contactConsent?: boolean | null;
  website?: string | null;
}
export interface LeadOptions {
  sendEmail?: (
    core: CoreContext,
    to: string,
    subject: string,
    text: string,
  ) => Promise<void>;
  logger?: { error(fields: Record<string, unknown>, message: string): void };
}
const optional = (value: string | null | undefined) => value?.trim() || null;
function bounded(
  value: string | null | undefined,
  field: string,
  max: number,
): string | null {
  const clean = optional(value);
  if (clean && Array.from(clean).length > max)
    throw bad(`${field} must be at most ${max} characters`);
  return clean;
}
function required(
  value: string | null | undefined,
  field: string,
  max?: number,
): string {
  const clean =
    max === undefined ? optional(value) : bounded(value, field, max);
  if (!clean) throw bad(`${field} is required`);
  return clean;
}
function email(value: string): void {
  if (
    !value.includes("@") ||
    value.split("@").length !== 2 ||
    !value.includes(".")
  )
    throw bad("Please enter a valid email address");
}
const strings = (values?: string[] | null) =>
  (values ?? []).map((value) => value.trim()).filter(Boolean);
export async function createQuoteRequest(
  core: CoreContext,
  input: QuoteInput,
  options: LeadOptions = {},
): Promise<Record<string, unknown>> {
  const business = required(input.businessName, "Business name"),
    contact = required(input.contactPerson, "Contact person"),
    phone = required(input.phone, "Phone"),
    address = required(input.email, "Email").toLowerCase(),
    type = required(input.businessType, "Business type");
  email(address);
  if (!BUSINESS_TYPES.includes(type)) throw bad("Invalid business type");
  const services = strings(input.services);
  if (
    !services.length ||
    services.some(
      (service) =>
        !SERVICES.includes(service) && Buffer.byteLength(service) > 120,
    )
  )
    throw bad("Invalid service selection");
  const id = createId();
  await core.pool.query(sql.create_quote_request[0], [
    id,
    business,
    contact,
    phone,
    address,
    type,
    services,
    optional(input.description),
  ]);
  await publishAdminNotification(
    core.pool,
    "quote_request.created",
    "New quote request",
    `${business} submitted a new quote request for ${services.length} service${services.length === 1 ? "" : "s"}.`,
    "quote_request",
    id,
    {
      businessName: business,
      contactPerson: contact,
      phone,
      email: address,
      businessType: type,
      services,
    },
    `quote_request.created:${id}`,
  ).catch(() => {});
  await (options.sendEmail ?? sendOrganizationEmail)(
    core,
    core.config.env.ADMIN_EMAIL ?? "iamenochchirima@gmail.com",
    `New Quote Request: ${business}`,
    `Business: ${business}\nContact: ${contact}\nPhone: ${phone}\nEmail: ${address}\nType: ${type}\nServices: ${services.join(", ")}`,
  ).catch(() => {});
  return { message: "Quote request submitted successfully", id };
}
export async function createWaitlistEntry(
  core: CoreContext,
  input: WaitlistInput,
  options: LeadOptions = {},
): Promise<Record<string, unknown>> {
  const business = bounded(input.businessName, "Company name", 160),
    contact = required(input.contactPerson, "Contact person", 160),
    label = business ?? contact,
    address = required(input.email, "Email", 320).toLowerCase(),
    type = bounded(input.businessType, "Business type", 80);
  email(address);
  if (type && !BUSINESS_TYPES.includes(type))
    throw bad("Invalid business type");
  const products = strings(input.products);
  if (
    !products.length ||
    products.length > 10 ||
    products.some(
      (value) => Array.from(value).length > 80 || !PRODUCTS.includes(value),
    )
  )
    throw bad("Invalid product selection");
  if (input.contactConsent !== true)
    throw bad("Consent to be contacted is required");
  if (optional(input.website)) throw bad("Invalid application");
  const website = optionalUrl(
      bounded(input.companyWebsite, "Company website", 320),
      "Company website",
    ),
    phone = bounded(input.phone, "Phone", 40),
    notes = bounded(input.notes, "Primary use case", 4000);
  const existing = async (): Promise<string | null> => {
    const row = (
      await core.pool.query(sql.existing_early_access_application_id[0], [
        address,
      ])
    ).rows[0];
    return row?.id ?? null;
  };
  const prior = await existing();
  if (prior) return { message: "Early-access application received", id: prior };
  const id = createId();
  try {
    await core.pool.query(sql.create_waitlist_entry[0], [
      id,
      business,
      contact,
      phone,
      address,
      type,
      website,
      products,
      notes,
    ]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      const duplicate = await existing();
      if (duplicate)
        return { message: "Early-access application received", id: duplicate };
      throw new ApiError(
        409,
        "conflict",
        "An active early-access application already exists",
      );
    }
    throw error;
  }
  await publishAdminNotification(
    core.pool,
    "early_access.submitted",
    "New early-access application",
    `${label} applied for early access to ${products.join(", ")}.`,
    "product_waitlist_entry",
    id,
    {
      businessName: business,
      contactPerson: contact,
      email: address,
      companyWebsite: website,
      products,
    },
    `early_access.submitted:${id}`,
  ).catch(() => {});
  await recordSubmission(core.pool, id).catch(() => {
    options.logger?.error(
      {
        event: "operation.failed",
        operation: "early_access.submission_audit",
        application_id: id,
      },
      "early-access submission audit failed",
    );
  });
  await (options.sendEmail ?? sendOrganizationEmail)(
    core,
    core.config.env.ADMIN_EMAIL ?? "iamenochchirima@gmail.com",
    `New Product Waitlist Signup: ${label}`,
    `Company: ${label}\nContact: ${contact}\nEmail: ${address}\nWebsite: ${website ?? "Not provided"}\nProducts: ${products.join(", ")}`,
  ).catch(() => {});
  return { message: "Early-access application received", id };
}
