/** Core API quotation records use snake_case; PDF draft models use camelCase. */
export interface CoreQuotationRecord {
  id: string;
  quote_request_id: string | null;
  business_name: string;
  contact_person: string;
  contact_email: string;
  contact_phone: string;
  date: string;
  service_type: string;
  title: string;
  introduction: string | null;
  scope_of_work: unknown;
  deliverables: unknown;
  implementation_steps: unknown;
  included_functionality: unknown;
  pricing_items: unknown;
  maintenance_includes: unknown;
  terms_and_notes: unknown;
  important_notes: unknown;
  validity_days: number;
  status: string;
}

export function coreQuotationDraftRecord(record: CoreQuotationRecord) {
  return {
    id: record.id,
    quoteRequestId: record.quote_request_id,
    businessName: record.business_name,
    contactPerson: record.contact_person,
    contactEmail: record.contact_email,
    contactPhone: record.contact_phone,
    date: record.date,
    serviceType: record.service_type,
    title: record.title,
    introduction: record.introduction,
    scopeOfWork: record.scope_of_work,
    deliverables: record.deliverables,
    implementationSteps: record.implementation_steps,
    includedFunctionality: record.included_functionality,
    pricingItems: record.pricing_items,
    maintenanceIncludes: record.maintenance_includes,
    termsAndNotes: record.terms_and_notes,
    importantNotes: record.important_notes,
    validityDays: record.validity_days,
    status: record.status,
  };
}
