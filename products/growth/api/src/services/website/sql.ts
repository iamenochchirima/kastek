export const WEBSITE_SQL = {
  existing_early_access_application_id: [
    "SELECT id FROM \"ProductWaitlistEntry\"\n           WHERE lower(email) = lower($1)\n             AND status IN ('new', 'approved', 'invited', 'active')\n           ORDER BY \"createdAt\" DESC LIMIT 1",
  ],
  create_quote_request: [
    '\n        INSERT INTO "QuoteRequest" (\n            id, "businessName", "contactPerson", phone, email, "businessType",\n            services, description, source, status, notes, "createdAt", "updatedAt"\n        )\n        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, \'website\', \'new\', \'[]\'::jsonb, NOW(), NOW())\n        ',
  ],
  create_waitlist_entry: [
    '\n        INSERT INTO "ProductWaitlistEntry" (\n            id, "businessName", "contactPerson", phone, email, "businessType",\n            website, products, notes, source, status, "contactConsentAt", "createdAt", "updatedAt"\n        )\n        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, \'website\', \'new\', NOW(), NOW(), NOW())\n        ',
  ],
} as const;
