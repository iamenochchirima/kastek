export const CAMPAIGN_COLS = `id, name, category, status, "totalLeads", "emailsSent", replies,
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"`;

export const LEAD_COLS = `id, "campaignId", "businessName", website, address, "bizbayUrl", category, phone,
    "emailStatus", "emailAddress",
    "emailSentAt" AT TIME ZONE 'UTC' AS "emailSentAt",
    "emailTemplate", "followUpCount",
    "lastFollowUp" AT TIME ZONE 'UTC' AS "lastFollowUp",
    "nextFollowUp" AT TIME ZONE 'UTC' AS "nextFollowUp",
    notes,
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"`;

export const LIST_CAMPAIGNS_0 = `SELECT {CAMPAIGN_COLS} FROM "OutreachCampaign" ORDER BY "createdAt" DESC`;

export const GET_CAMPAIGN_0 = `SELECT {CAMPAIGN_COLS} FROM "OutreachCampaign" WHERE id = $1 LIMIT 1`;

export const CREATE_CAMPAIGN_0 = `INSERT INTO "OutreachCampaign" (id, name, category, status, "totalLeads", "emailsSent", replies, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, 0, 0, 0, $5, $6)`;



export const DELETE_CAMPAIGN_0 = `DELETE FROM "OutreachCampaign" WHERE id = $1 RETURNING id`;

export const DELETE_ALL_CAMPAIGNS_0 = `DELETE FROM "OutreachLead"`;

export const DELETE_ALL_CAMPAIGNS_1 = `WITH deleted AS (DELETE FROM "OutreachCampaign" RETURNING id) SELECT COUNT(*) FROM deleted`;

export const LIST_LEADS_0 = `SELECT {LEAD_COLS} FROM "OutreachLead" WHERE "campaignId" = $1 ORDER BY "createdAt" DESC`;

export const CREATE_LEAD_0 = `SELECT id FROM "OutreachCampaign" WHERE id = $1 LIMIT 1`;

export const CREATE_LEAD_1 = `INSERT INTO "OutreachLead" (
            id, "campaignId", "businessName", website, address, "bizbayUrl", category, phone,
            "emailStatus", "emailAddress", "emailTemplate", "followUpCount", notes,
            "createdAt", "updatedAt"
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,0,$11,$12,$13)`;

export const CREATE_LEAD_2 = `UPDATE "OutreachCampaign"
        SET "totalLeads" = (SELECT COUNT(*) FROM "OutreachLead" WHERE "campaignId" = $1), "updatedAt" = NOW()
        WHERE id = $1`;



export const UPDATE_LEAD_1 = `SELECT COUNT(*) FROM "OutreachLead" WHERE "campaignId" = $1 AND "emailStatus" = 'sent'`;

export const UPDATE_LEAD_2 = `SELECT COUNT(*) FROM "OutreachLead" WHERE "campaignId" = $1 AND "emailStatus" IN ('replied','interested')`;

export const UPDATE_LEAD_3 = `UPDATE "OutreachCampaign" SET "emailsSent" = $1, replies = $2, "updatedAt" = NOW() WHERE id = $3`;

export const GET_LEAD_0 = `SELECT {LEAD_COLS} FROM "OutreachLead" WHERE id = $1 AND "campaignId" = $2 LIMIT 1`;

export const DELETE_LEAD_0 = `DELETE FROM "OutreachLead" WHERE id = $1 AND "campaignId" = $2 RETURNING id`;

export const DELETE_LEAD_1 = `UPDATE "OutreachCampaign"
        SET "totalLeads" = (SELECT COUNT(*) FROM "OutreachLead" WHERE "campaignId" = $1), "updatedAt" = NOW()
        WHERE id = $1`;

export const CREATE_DELIVERY_LOGS_0 = `INSERT INTO "OutreachEmailDeliveryLog" (
                id, "campaignId", "leadId", recipient, subject, status, provider,
                "providerMessageId", "providerResponse", "errorMessage", "attemptedAt"
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;

export const IMPORT_CAMPAIGN_0 = `SELECT id, name FROM "OutreachCampaign" WHERE lower(category) = lower($1) LIMIT 1`;

export const IMPORT_CAMPAIGN_1 = `INSERT INTO "OutreachCampaign" (id, name, category, status, "totalLeads", "emailsSent", replies, "createdAt", "updatedAt")
        VALUES ($1,$2,$3,'draft',$4,0,0,$5,$6)`;

export const IMPORT_CAMPAIGN_2 = `INSERT INTO "OutreachLead" (
                id, "campaignId", "businessName", website, address, "bizbayUrl", category, phone,
                "emailStatus", "followUpCount", "createdAt", "updatedAt"
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',0,$9,$10)`;


export const LIST_DELIVERY_LOGS_0 = `SELECT
            l.id, l."campaignId", l."leadId", l."isTest",
            l.recipient, l.subject, l.status, l.provider,
            l."providerMessageId", l."errorMessage",
            l."attemptedAt" AT TIME ZONE 'UTC' AS "attemptedAt",
            c.name AS campaign_name, c.category AS campaign_category,
            ol."businessName" AS lead_business_name, ol.website AS lead_website
        FROM "OutreachEmailDeliveryLog" l
        LEFT JOIN "OutreachCampaign" c ON c.id = l."campaignId"
        LEFT JOIN "OutreachLead" ol ON ol.id = l."leadId"
        {where_clause}
        ORDER BY l."attemptedAt" DESC
        LIMIT {limit}`;
