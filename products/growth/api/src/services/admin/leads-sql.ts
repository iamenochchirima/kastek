export const SELECT_COLS = `id, "businessName", "contactPerson", phone, email, "businessType",
    services, description, source, status, "quoteAmount",
    "followUpDate" AT TIME ZONE 'UTC' AS "followUpDate",
    notes, "assignedToId",
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"`;

export const LIST_LEADS_0 = `SELECT id, "businessName", "contactPerson", phone, email, "businessType",
    services, description, source, status, "quoteAmount",
    "followUpDate" AT TIME ZONE 'UTC' AS "followUpDate",
    notes, "assignedToId",
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt" FROM "QuoteRequest" ORDER BY "createdAt" DESC`;

export const GET_LEAD_0 = `SELECT id, "businessName", "contactPerson", phone, email, "businessType",
    services, description, source, status, "quoteAmount",
    "followUpDate" AT TIME ZONE 'UTC' AS "followUpDate",
    notes, "assignedToId",
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt" FROM "QuoteRequest" WHERE id = $1 LIMIT 1`;

export const CREATE_LEAD_0 = `INSERT INTO "QuoteRequest" (
            id, "businessName", "contactPerson", phone, email, "businessType",
            services, description, source, status, "quoteAmount", "assignedToId",
            notes, "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '[]', $13, $14)`;



export const DELETE_LEAD_0 = `DELETE FROM "QuoteRequest" WHERE id = $1 RETURNING id`;

export const ADD_NOTE_0 = `UPDATE "QuoteRequest"
        SET notes = notes || $1::jsonb, "updatedAt" = NOW()
        WHERE id = $2
        RETURNING notes`;
