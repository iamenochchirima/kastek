export const SELECT_COLS = `id, "businessName", "contactPerson", "contactEmail", "contactPhone",
    date AT TIME ZONE 'UTC' AS date, "serviceType", "billingMode", "recurringActive",
    "billingAnchorDay", "reminderDaysAfterDue",
    "lastSentAt" AT TIME ZONE 'UTC' AS "lastSentAt",
    "lastReminderAt" AT TIME ZONE 'UTC' AS "lastReminderAt",
    "lastPaidAt" AT TIME ZONE 'UTC' AS "lastPaidAt",
    title, introduction,
    "scopeOfWork", deliverables, "implementationSteps", "pricingItems",
    "maintenanceIncludes", "termsAndNotes", "includedFunctionality",
    "knowledgeBaseScope", "importantNotes", "supportIncludes",
    "setupFee", "monthlyFee", "deliveryTimeline", "validityDays", status,
    "quoteRequestId",
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"`;

export const RUN_SELECT_COLS = `id, "invoiceId", "cycleKey",
    "issueDate" AT TIME ZONE 'UTC' AS "issueDate",
    "periodStart" AT TIME ZONE 'UTC' AS "periodStart",
    "periodEnd" AT TIME ZONE 'UTC' AS "periodEnd",
    "dueDate" AT TIME ZONE 'UTC' AS "dueDate",
    status, "sendStatus", "reminderStatus",
    "sentAt" AT TIME ZONE 'UTC' AS "sentAt",
    "reminderDueAt" AT TIME ZONE 'UTC' AS "reminderDueAt",
    "reminderSentAt" AT TIME ZONE 'UTC' AS "reminderSentAt",
    "paidAt" AT TIME ZONE 'UTC' AS "paidAt",
    "pricingItemsSnapshot", "titleSnapshot", "contactEmailSnapshot", "businessNameSnapshot",
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"`;

export const LIST_ADMIN_IDS_0 = `SELECT id FROM "AdminUser"`;

export const PUBLISH_ADMIN_NOTIFICATION_0 = `SELECT id
        FROM "NotificationEvent"
        WHERE "scopeType" = 'ADMIN'::"NotificationScopeType"
          AND "scopeId" = 'global'
          AND "dedupeKey" = $1
        LIMIT 1`;

export const PUBLISH_ADMIN_NOTIFICATION_1 = `INSERT INTO "NotificationEvent" (
            id, "scopeType", "scopeId", "eventType", title, message, severity,
            "entityType", "entityId", payload, "dedupeKey", "createdAt"
        )
        VALUES (
            $1, 'ADMIN'::"NotificationScopeType", 'global', 'invoice.reminder_due', $2, $3,
            'WARNING'::"NotificationSeverity", $4, $5, $6, $7, NOW()
        )`;

export const PUBLISH_ADMIN_NOTIFICATION_2 = `INSERT INTO "Notification" (
                id, "eventId", "recipientType", "recipientId", channel, status, "sentAt", "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, 'ADMIN'::"NotificationRecipientType", $3,
                'IN_APP'::"NotificationChannel", 'SENT'::"NotificationStatus", NOW(), NOW(), NOW()
            )`;

export const FETCH_INVOICE_0 = `SELECT id, "businessName", "contactPerson", "contactEmail", "contactPhone",
    date AT TIME ZONE 'UTC' AS date, "serviceType", "billingMode", "recurringActive",
    "billingAnchorDay", "reminderDaysAfterDue",
    "lastSentAt" AT TIME ZONE 'UTC' AS "lastSentAt",
    "lastReminderAt" AT TIME ZONE 'UTC' AS "lastReminderAt",
    "lastPaidAt" AT TIME ZONE 'UTC' AS "lastPaidAt",
    title, introduction,
    "scopeOfWork", deliverables, "implementationSteps", "pricingItems",
    "maintenanceIncludes", "termsAndNotes", "includedFunctionality",
    "knowledgeBaseScope", "importantNotes", "supportIncludes",
    "setupFee", "monthlyFee", "deliveryTimeline", "validityDays", status,
    "quoteRequestId",
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt" FROM "Invoice" WHERE id = $1 LIMIT 1`;

export const FETCH_RECENT_RUNS_0 = `SELECT {RUN_SELECT_COLS}
        FROM "InvoiceRun"
        WHERE "invoiceId" = $1
        ORDER BY "issueDate" DESC
        LIMIT $2`;

export const SYNC_CURRENT_RUN_0 = `SELECT {RUN_SELECT_COLS}
        FROM "InvoiceRun"
        WHERE "invoiceId" = $1 AND "cycleKey" = $2
        LIMIT 1`;

export const SYNC_CURRENT_RUN_1 = `INSERT INTO "InvoiceRun" (
                id, "invoiceId", "cycleKey", "issueDate", "periodStart", "periodEnd",
                "dueDate", "status", "sendStatus", "reminderStatus", "pricingItemsSnapshot",
                "titleSnapshot", "contactEmailSnapshot", "businessNameSnapshot", "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, 'pending', 'pending', 'not_needed', $8,
                $9, $10, $11, NOW(), NOW()
            )`;

export const SYNC_CURRENT_RUN_2 = `SELECT {RUN_SELECT_COLS} FROM "InvoiceRun" WHERE id = $1`;

export const SYNC_CURRENT_RUN_3 = `UPDATE "InvoiceRun"
            SET
                status = $1,
                "reminderStatus" = $2,
                "reminderDueAt" = $3,
                "pricingItemsSnapshot" = $4,
                "titleSnapshot" = $5,
                "contactEmailSnapshot" = $6,
                "businessNameSnapshot" = $7,
                "updatedAt" = NOW()
            WHERE id = $8`;

export const SYNC_CURRENT_RUN_4 = `SELECT {RUN_SELECT_COLS} FROM "InvoiceRun" WHERE id = $1`;

export const INVOICE_RESPONSE_0 = `UPDATE "Invoice" SET status = $1, "updatedAt" = NOW() WHERE id = $2`;

export const LIST_INVOICES_0 = `SELECT id, "businessName", "contactPerson", "contactEmail", "contactPhone",
    date AT TIME ZONE 'UTC' AS date, "serviceType", "billingMode", "recurringActive",
    "billingAnchorDay", "reminderDaysAfterDue",
    "lastSentAt" AT TIME ZONE 'UTC' AS "lastSentAt",
    "lastReminderAt" AT TIME ZONE 'UTC' AS "lastReminderAt",
    "lastPaidAt" AT TIME ZONE 'UTC' AS "lastPaidAt",
    title, introduction,
    "scopeOfWork", deliverables, "implementationSteps", "pricingItems",
    "maintenanceIncludes", "termsAndNotes", "includedFunctionality",
    "knowledgeBaseScope", "importantNotes", "supportIncludes",
    "setupFee", "monthlyFee", "deliveryTimeline", "validityDays", status,
    "quoteRequestId",
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt" FROM "Invoice" ORDER BY "createdAt" DESC`;

export const CREATE_INVOICE_0 = `INSERT INTO "Invoice" (
            id, "businessName", "contactPerson", "contactEmail", "contactPhone",
            date, "serviceType", "billingMode", "recurringActive", "billingAnchorDay",
            "reminderDaysAfterDue", title, introduction,
            "scopeOfWork", deliverables, "implementationSteps", "pricingItems",
            "maintenanceIncludes", "termsAndNotes", "includedFunctionality",
            "knowledgeBaseScope", "importantNotes", "supportIncludes",
            "setupFee", "monthlyFee", "deliveryTimeline", "validityDays", status,
            "quoteRequestId", "createdAt", "updatedAt"
        )
        VALUES (
            $1,$2,$3,$4,$5,
            $6,$7,$8,$9,$10,
            $11,$12,$13,
            $14,$15,$16,$17,
            $18,$19,$20,
            $21,$22,$23,
            '','',NULL,$24,$25,
            $26,$27,$28
        )`;


export const INVOICE_RUN_ACTION_0 = `SELECT {RUN_SELECT_COLS}
        FROM "InvoiceRun"
        WHERE id = $1 AND "invoiceId" = $2
        LIMIT 1`;

export const INVOICE_RUN_ACTION_1 = `UPDATE "InvoiceRun"
                SET
                    "sentAt" = COALESCE("sentAt", $1),
                    status = CASE
                        WHEN "paidAt" IS NOT NULL THEN 'paid'
                        WHEN $2 >= "dueDate" THEN 'overdue'
                        ELSE 'sent'
                    END,
                    "sendStatus" = 'sent',
                    "reminderDueAt" = $3,
                    "updatedAt" = NOW()
                WHERE id = $4`;

export const INVOICE_RUN_ACTION_2 = `UPDATE "Invoice"
                SET status = 'sent', "lastSentAt" = $1, "updatedAt" = NOW()
                WHERE id = $2`;

export const INVOICE_RUN_ACTION_3 = `UPDATE "InvoiceRun"
                SET
                    "reminderSentAt" = COALESCE("reminderSentAt", $1),
                    "reminderStatus" = 'sent',
                    status = CASE WHEN "paidAt" IS NOT NULL THEN 'paid' ELSE 'reminder_sent' END,
                    "updatedAt" = NOW()
                WHERE id = $2`;

export const INVOICE_RUN_ACTION_4 = `UPDATE "Invoice"
                SET status = 'overdue', "lastReminderAt" = $1, "updatedAt" = NOW()
                WHERE id = $2`;

export const INVOICE_RUN_ACTION_5 = `UPDATE "InvoiceRun"
                SET
                    "paidAt" = COALESCE("paidAt", $1),
                    status = 'paid',
                    "sendStatus" = CASE WHEN "sentAt" IS NULL THEN 'pending' ELSE 'sent' END,
                    "updatedAt" = NOW()
                WHERE id = $2`;

export const INVOICE_RUN_ACTION_6 = `UPDATE "Invoice"
                SET status = 'paid', "lastPaidAt" = $1, "updatedAt" = NOW()
                WHERE id = $2`;

export const INVOICE_RUN_ACTION_7 = `UPDATE "InvoiceRun"
                SET
                    "sentAt" = NULL,
                    "reminderDueAt" = NULL,
                    "reminderSentAt" = NULL,
                    "paidAt" = NULL,
                    status = 'pending',
                    "sendStatus" = 'pending',
                    "reminderStatus" = 'not_needed',
                    "updatedAt" = NOW()
                WHERE id = $1`;

export const INVOICE_RUN_ACTION_8 = `UPDATE "Invoice" SET status = 'draft', "updatedAt" = NOW() WHERE id = $1`;

export const DELETE_INVOICE_0 = `DELETE FROM "Invoice" WHERE id = $1 RETURNING id`;
