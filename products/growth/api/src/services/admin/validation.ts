import { RequestExtractionError } from '../../error.js';
import { validCalendarDate, type ObjectValue } from './common.js';
const structs: Record<string, [string, string, boolean][]> = {
  'leads.ListLeadsQuery': [
    ['status', 'string', true],
    ['source', 'string', true],
    ['search', 'string', true],
  ],
  'leads.CreateLeadBody': [
    ['businessName', 'string', false],
    ['contactPerson', 'string', false],
    ['phone', 'string', false],
    ['email', 'string', false],
    ['businessType', 'string', false],
    ['services', 'array-value:string', true],
    ['description', 'string', true],
    ['source', 'string', true],
    ['status', 'string', true],
    ['quoteAmount', 'number', true],
    ['assignedToId', 'string', true],
  ],
  'leads.UpdateLeadBody': [
    ['businessName', 'string', true],
    ['contactPerson', 'string', true],
    ['phone', 'string', true],
    ['email', 'string', true],
    ['businessType', 'string', true],
    ['services', 'array-value:string', true],
    ['description', 'string', true],
    ['source', 'string', true],
    ['status', 'string', true],
    ['quoteAmount', 'number', true],
    ['followUpDate', 'string', true],
    ['notes', 'any', true],
    ['assignedToId', 'string', true],
  ],
  'leads.AddNoteBody': [
    ['text', 'string', false],
    ['adminUserName', 'string', true],
  ],
  'quotations.CreateBody': [
    ['businessName', 'string', false],
    ['contactPerson', 'string', false],
    ['contactEmail', 'string', false],
    ['contactPhone', 'string', false],
    ['date', 'string', false],
    ['serviceType', 'string', true],
    ['title', 'string', false],
    ['introduction', 'string', true],
    ['scopeOfWork', 'any', true],
    ['deliverables', 'any', true],
    ['implementationSteps', 'any', true],
    ['pricingItems', 'any', true],
    ['maintenanceIncludes', 'any', true],
    ['termsAndNotes', 'any', true],
    ['sectionOrder', 'any', true],
    ['noteSections', 'any', true],
    ['validityDays', 'any', true],
    ['status', 'string', true],
    ['quoteRequestId', 'string', true],
  ],
  'quotations.UpdateBody': [
    ['businessName', 'string', true],
    ['contactPerson', 'string', true],
    ['contactEmail', 'string', true],
    ['contactPhone', 'string', true],
    ['date', 'string', true],
    ['serviceType', 'string', true],
    ['title', 'string', true],
    ['introduction', 'string', true],
    ['scopeOfWork', 'any', true],
    ['deliverables', 'any', true],
    ['implementationSteps', 'any', true],
    ['pricingItems', 'any', true],
    ['maintenanceIncludes', 'any', true],
    ['termsAndNotes', 'any', true],
    ['sectionOrder', 'any', true],
    ['noteSections', 'any', true],
    ['validityDays', 'any', true],
    ['status', 'string', true],
    ['quoteRequestId', 'any', true],
  ],
  'invoices.CreateBody': [
    ['businessName', 'string', false],
    ['contactPerson', 'string', false],
    ['contactEmail', 'string', false],
    ['contactPhone', 'string', false],
    ['date', 'string', false],
    ['serviceType', 'string', true],
    ['billingMode', 'string', true],
    ['recurringActive', 'bool', true],
    ['billingAnchorDay', 'any', true],
    ['reminderDaysAfterDue', 'any', true],
    ['title', 'string', false],
    ['introduction', 'string', true],
    ['scopeOfWork', 'any', true],
    ['deliverables', 'any', true],
    ['implementationSteps', 'any', true],
    ['pricingItems', 'any', true],
    ['maintenanceIncludes', 'any', true],
    ['termsAndNotes', 'any', true],
    ['sectionOrder', 'any', true],
    ['noteSections', 'any', true],
    ['validityDays', 'any', true],
    ['status', 'string', true],
    ['quoteRequestId', 'string', true],
  ],
  'invoices.UpdateBody': [
    ['businessName', 'string', true],
    ['contactPerson', 'string', true],
    ['contactEmail', 'string', true],
    ['contactPhone', 'string', true],
    ['date', 'string', true],
    ['serviceType', 'string', true],
    ['billingMode', 'string', true],
    ['recurringActive', 'bool', true],
    ['billingAnchorDay', 'any', true],
    ['reminderDaysAfterDue', 'any', true],
    ['title', 'string', true],
    ['introduction', 'string', true],
    ['scopeOfWork', 'any', true],
    ['deliverables', 'any', true],
    ['implementationSteps', 'any', true],
    ['pricingItems', 'any', true],
    ['maintenanceIncludes', 'any', true],
    ['termsAndNotes', 'any', true],
    ['sectionOrder', 'any', true],
    ['noteSections', 'any', true],
    ['validityDays', 'any', true],
    ['status', 'string', true],
    ['quoteRequestId', 'any', true],
  ],
  'invoices.RunActionBody': [['action', 'string', false]],
  'outreach.CreateCampaignBody': [
    ['name', 'string', false],
    ['category', 'string', false],
    ['status', 'string', true],
  ],
  'outreach.UpdateCampaignBody': [
    ['name', 'string', true],
    ['category', 'string', true],
    ['status', 'string', true],
  ],
  'outreach.LeadQuery': [
    ['emailStatus', 'string', true],
    ['search', 'string', true],
  ],
  'outreach.CreateLeadBody': [
    ['businessName', 'string', false],
    ['website', 'string', true],
    ['address', 'string', true],
    ['bizbayUrl', 'string', true],
    ['category', 'string', false],
    ['phone', 'string', true],
    ['emailAddress', 'string', true],
    ['emailTemplate', 'string', true],
    ['notes', 'string', true],
  ],
  'outreach.UpdateLeadBody': [
    ['emailStatus', 'string', true],
    ['phone', 'string', true],
    ['emailAddress', 'string', true],
    ['emailSentAt', 'string', true],
    ['emailTemplate', 'string', true],
    ['followUpCount', 'i32', true],
    ['lastFollowUp', 'string', true],
    ['nextFollowUp', 'any', true],
    ['notes', 'string', true],
  ],
  'outreach.ImportBody': [
    ['name', 'string', false],
    ['category', 'string', false],
    ['listings', 'array:outreach.ImportListing', false],
  ],
  'outreach.ImportListing': [
    ['name', 'string', false],
    ['website', 'string', true],
    ['address', 'string', true],
    ['bizbayUrl', 'string', true],
    ['phone', 'string', true],
  ],
  'outreach.CreateDeliveryLogEntry': [
    ['campaignId', 'string', true],
    ['leadId', 'string', true],
    ['recipient', 'string', false],
    ['subject', 'string', false],
    ['status', 'string', false],
    ['provider', 'string', false],
    ['providerMessageId', 'string', true],
    ['providerResponse', 'string', true],
    ['errorMessage', 'string', true],
  ],
  'outreach.CreateDeliveryLogsBody': [
    ['logs', 'array:outreach.CreateDeliveryLogEntry', false],
  ],
  'outreach.DeliveryQuery': [
    ['campaignId', 'string', true],
    ['status', 'string', true],
    ['mode', 'string', true],
    ['recipient', 'string', true],
    ['domain', 'string', true],
    ['dateFrom', 'string', true],
    ['dateTo', 'string', true],
    ['format', 'string', true],
    ['limit', 'i64', true],
  ],
  'web_services.ListQuery': [
    ['callStatus', 'string', true],
    ['category', 'string', true],
    ['search', 'string', true],
  ],
  'web_services.CreateBody': [
    ['businessName', 'string', false],
    ['website', 'string', true],
    ['address', 'string', true],
    ['category', 'string', false],
    ['bizbayUrl', 'string', true],
    ['phone', 'string', true],
    ['email', 'string', true],
    ['callStatus', 'string', true],
    ['notes', 'string', true],
  ],
  'web_services.UpdateBody': [
    ['businessName', 'string', true],
    ['website', 'string', true],
    ['address', 'string', true],
    ['category', 'string', true],
    ['bizbayUrl', 'string', true],
    ['phone', 'string', true],
    ['email', 'string', true],
    ['callStatus', 'string', true],
    ['notes', 'string', true],
    ['callbackDate', 'string', true],
  ],
  'web_services.ImportBody': [
    ['leads', 'array:web_services.CreateBody', false],
  ],

};
function reject(): never {
  throw new RequestExtractionError('json');
}
function field(value: unknown, kind: string): unknown {
  if (kind === 'any') return value;
  if (kind === 'number') {
    const number = typeof value === 'bigint' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) reject();
    return number;
  }
  if (kind.startsWith('array-value:')) {
    if (!Array.isArray(value)) reject();
    return value.map((v) => field(v, kind.slice(12)));
  }
  if (kind === 'string') {
    if (typeof value !== 'string') reject();
    return value;
  }
  if (kind === 'bool') {
    if (typeof value !== 'boolean') reject();
    return value;
  }
  if (kind === 'date') {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
      !validCalendarDate(value) ||
      !Number.isFinite(Date.parse(value))
    )
      reject();
    return new Date(value);
  }
  if (kind === 'i32' || kind === 'i64' || kind === 'u32') {
    if (
      typeof value !== 'bigint' &&
      (typeof value !== 'number' || !Number.isSafeInteger(value))
    )
      reject();
    const integer = BigInt(value as number | bigint),
      min = kind === 'u32' ? 0n : kind === 'i32' ? -(1n << 31n) : -(1n << 63n),
      max =
        kind === 'i64'
          ? (1n << 63n) - 1n
          : kind === 'i32'
            ? (1n << 31n) - 1n
            : (1n << 32n) - 1n;
    if (integer < min || integer > max) reject();
    return kind === 'i64' ? integer : Number(integer);
  }
  if (kind.startsWith('array:')) {
    if (!Array.isArray(value)) reject();
    return value.map((v) => validateBody(kind.slice(6), v));
  }
  return validateBody(kind.slice(7), value);
}
export function validateBody(name: string, input: unknown): ObjectValue {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) reject();
    const source = input as ObjectValue,
      output: ObjectValue = {};
    for (const [key, kind, optional] of structs[name] ?? reject()) {
      const value = source[key];
      if (value === null && kind === "any" && !optional) {
        output[key] = null;
        continue;
      }
      if (value == null) {
        if (!optional) reject();
        output[key] = null;
      } else output[key] = field(value, kind);
    }
    return output;
  } catch (error) {
    if (error instanceof RequestExtractionError && name.endsWith("Query"))
      throw new RequestExtractionError("query");
    throw error;
  }
}
export function queryInteger(value: unknown, kind: "i64" | "u32" = "i64") {
  try {
    if (value == null) return null;
    if (typeof value !== "string" || !/^[+-]?\d+$/.test(value)) reject();
    return field(BigInt(value), kind) as number | bigint;
  } catch (error) {
    if (error instanceof RequestExtractionError)
      throw new RequestExtractionError("query");
    throw error;
  }
}
