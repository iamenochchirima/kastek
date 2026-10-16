export const SELECT_COLS = `id, "businessName", website, address, category, "bizbayUrl",
    phone, email, "callStatus", notes, "callbackDate", "createdAt", "updatedAt"`;

export const LIST_0 = `SELECT id, "businessName", website, address, category, "bizbayUrl",
    phone, email, "callStatus", notes, "callbackDate", "createdAt", "updatedAt" FROM "WebServiceLead" ORDER BY "createdAt" DESC, id ASC`;

export const GET_0 = `SELECT id, "businessName", website, address, category, "bizbayUrl",
    phone, email, "callStatus", notes, "callbackDate", "createdAt", "updatedAt" FROM "WebServiceLead" WHERE id = $1 LIMIT 1`;

export const CREATE_0 = `INSERT INTO "WebServiceLead" (
            id, "businessName", website, address, category, "bizbayUrl",
            phone, email, "callStatus", notes, "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;



export const DELETE_0 = `DELETE FROM "WebServiceLead" WHERE id = $1 RETURNING id`;

export const IMPORT_0 = `INSERT INTO "WebServiceLead" (
                id, "businessName", website, address, category, "bizbayUrl",
                phone, email, "callStatus", notes, "createdAt", "updatedAt"
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT DO NOTHING`;
