export const CREATE_0 = `INSERT INTO "AdminSupportAccessGrant"
          ("id", "adminId", "organizationId", "resourceType", "resourceId",
           "reason", "grantedById", "expiresAt")
        VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8)
        RETURNING "id", "adminId", "organizationId", "resourceType", "resourceId",
                  "reason", "grantedById", "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
                  "revokedAt" AT TIME ZONE 'UTC' AS "revokedAt",
                  "createdAt" AT TIME ZONE 'UTC' AS "createdAt"`;

export const LIST_0 = `SELECT "id", "adminId", "organizationId", "resourceType", "resourceId",
               "reason", "grantedById", "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
               "revokedAt" AT TIME ZONE 'UTC' AS "revokedAt",
               "createdAt" AT TIME ZONE 'UTC' AS "createdAt"
        FROM "AdminSupportAccessGrant"
        WHERE ($1::text IS NULL OR "organizationId" = $1)
        ORDER BY "createdAt" DESC
        LIMIT 200`;

export const REVOKE_0 = `UPDATE "AdminSupportAccessGrant"
        SET "revokedAt" = NOW()
        WHERE "id" = $1 AND "revokedAt" IS NULL
        RETURNING "id", "adminId", "organizationId", "resourceType", "resourceId",
                  "reason", "grantedById", "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
                  "revokedAt" AT TIME ZONE 'UTC' AS "revokedAt",
                  "createdAt" AT TIME ZONE 'UTC' AS "createdAt"`;

export const ALLOWS_0 = `SELECT EXISTS (
          SELECT 1
          FROM "AdminSupportAccessGrant"
          WHERE "adminId" = $1
            AND "organizationId" = $2
            AND "revokedAt" IS NULL
            AND "expiresAt" > NOW()
            AND (
              ("resourceType" = 'organization' AND "resourceId" IS NULL)
              OR ("resourceType" = $3 AND "resourceId" = $4)
            )
        )`;

export const RECORD_AUDIT_0 = `INSERT INTO "AdminSupportAccessAuditEvent"
           ("id", "grantId", "actorId", "action", "metadata")
           VALUES ($1, $2, $3, $4, $5)`;
