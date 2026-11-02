import type { FastifyInstance } from "fastify";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import * as leads from "../services/website/leads.js";
import type { LeadOptions, QuoteInput, WaitlistInput } from "../services/website/leads.js";

type Row = Record<string, unknown>;
const bad = () => new ApiError(400, "bad_request", "Invalid request");
function leadInput(value: unknown, waitlist: boolean): QuoteInput | WaitlistInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad();
  const input = value as Row, output: Row = {};
  for (const key of ["businessName", "contactPerson", "phone", "email", "businessType", ...(waitlist ? ["companyWebsite", "notes", "website"] : ["description"])]) {
    if (input[key] != null && typeof input[key] !== "string") throw bad();
    output[key] = input[key] ?? null;
  }
  const key = waitlist ? "products" : "services";
  if (input[key] != null && (!Array.isArray(input[key]) || input[key].some(v => typeof v !== "string"))) throw bad();
  output[key] = input[key] ?? null;
  if (waitlist) {
    if (input.contactConsent != null && typeof input.contactConsent !== "boolean") throw bad();
    output.contactConsent = input.contactConsent ?? null;
  }
  return output;
}

export async function registerLeadRoutes(app: FastifyInstance, core: CoreContext, options: LeadOptions = {}): Promise<void> {
  const ports = { ...options, logger: options.logger ?? app.log };
  app.post("/api/quote-requests", async (request, reply) => reply.code(201).send(await leads.createQuoteRequest(core, leadInput(request.body, false) as QuoteInput, ports)));
  app.post("/api/waitlist", { bodyLimit: 32 * 1024 }, async (request, reply) => reply.code(201).send(await leads.createWaitlistEntry(core, leadInput(request.body, true) as WaitlistInput, ports)));
}
