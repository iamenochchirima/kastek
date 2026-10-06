export const SELECT_COLS = `id, "businessName", "contactPerson", "contactEmail", "contactPhone",
    date AT TIME ZONE 'UTC' AS date, "serviceType", title, introduction,
    "scopeOfWork", deliverables, "implementationSteps", "pricingItems",
    "maintenanceIncludes", "termsAndNotes", "includedFunctionality",
    "knowledgeBaseScope", "importantNotes", "supportIncludes",
    "setupFee", "monthlyFee", "deliveryTimeline", "validityDays", status,
    "quoteRequestId",
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"`;

export const LIST_QUOTATIONS_0 = `SELECT id, "businessName", "contactPerson", "contactEmail", "contactPhone",
    date AT TIME ZONE 'UTC' AS date, "serviceType", title, introduction,
    "scopeOfWork", deliverables, "implementationSteps", "pricingItems",
    "maintenanceIncludes", "termsAndNotes", "includedFunctionality",
    "knowledgeBaseScope", "importantNotes", "supportIncludes",
    "setupFee", "monthlyFee", "deliveryTimeline", "validityDays", status,
    "quoteRequestId",
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt" FROM "Quotation" ORDER BY "createdAt" DESC`;

export const GET_QUOTATION_0 = `SELECT id, "businessName", "contactPerson", "contactEmail", "contactPhone",
    date AT TIME ZONE 'UTC' AS date, "serviceType", title, introduction,
    "scopeOfWork", deliverables, "implementationSteps", "pricingItems",
    "maintenanceIncludes", "termsAndNotes", "includedFunctionality",
    "knowledgeBaseScope", "importantNotes", "supportIncludes",
    "setupFee", "monthlyFee", "deliveryTimeline", "validityDays", status,
    "quoteRequestId",
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt" FROM "Quotation" WHERE id = $1 LIMIT 1`;

export const CREATE_QUOTATION_0 = `INSERT INTO "Quotation" (
            id, "businessName", "contactPerson", "contactEmail", "contactPhone",
            date, "serviceType", title, introduction,
            "scopeOfWork", deliverables, "implementationSteps", "pricingItems",
            "maintenanceIncludes", "termsAndNotes", "includedFunctionality",
            "knowledgeBaseScope", "importantNotes", "supportIncludes",
            "setupFee", "monthlyFee", "deliveryTimeline", "validityDays", status,
            "quoteRequestId", "createdAt", "updatedAt"
        )
        VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,
            $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
            '','',NULL,$20,$21,$22,$23,$24
        )`;



export const DELETE_QUOTATION_0 = `DELETE FROM "Quotation" WHERE id = $1 RETURNING id`;
