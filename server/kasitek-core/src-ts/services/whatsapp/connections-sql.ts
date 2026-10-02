export const SQL={
  "connect_connection": [
    "SELECT \"orgId\" FROM \"WhatsappConnection\" WHERE \"phoneNumberId\" = $1 LIMIT 1",
    "\n        INSERT INTO \"WhatsappConnection\" (\n            id, \"userId\", \"orgId\", \"phoneNumberId\", \"phoneDisplayNumber\", \"accessTokenEncrypted\",\n            \"wabaId\", \"authMethod\", \"currentQualityRating\", \"dailyLimitEstimate\", verified, \"providerPermissions\", \"createdAt\", \"updatedAt\"\n        )\n        VALUES (\n            $1, $2, $3, $4, $5, $6, $7, $8, CAST($9 AS \"WhatsappConnectionQualityRating\"), $10, $11, $12, NOW(), NOW()\n        )\n        ON CONFLICT (\"phoneNumberId\")\n        DO UPDATE SET\n            \"userId\" = EXCLUDED.\"userId\",\n            \"orgId\" = EXCLUDED.\"orgId\",\n            \"phoneDisplayNumber\" = EXCLUDED.\"phoneDisplayNumber\",\n            \"accessTokenEncrypted\" = EXCLUDED.\"accessTokenEncrypted\",\n            \"wabaId\" = EXCLUDED.\"wabaId\",\n            \"authMethod\" = EXCLUDED.\"authMethod\",\n            \"currentQualityRating\" = EXCLUDED.\"currentQualityRating\",\n            \"dailyLimitEstimate\" = EXCLUDED.\"dailyLimitEstimate\",\n            verified = EXCLUDED.verified,\n            \"providerPermissions\" = COALESCE(EXCLUDED.\"providerPermissions\", \"WhatsappConnection\".\"providerPermissions\"),\n            \"updatedAt\" = NOW()\n        ",
    "UPDATE \"WhatsappConnection\" SET \"providerPermissions\" = $1, \"updatedAt\" = NOW() WHERE id = $2"
  ],
  "refresh_connection_inner": [
    "\n        UPDATE \"WhatsappConnection\"\n        SET \"phoneDisplayNumber\" = $1,\n            \"currentQualityRating\" = CAST($2 AS \"WhatsappConnectionQualityRating\"),\n            verified = $3,\n            \"dailyLimitEstimate\" = $4,\n            \"providerPermissions\" = $5,\n            \"updatedAt\" = NOW()\n        WHERE id = $6\n        ",
    "UPDATE \"WhatsappConnection\" SET \"providerPermissions\" = $1, \"updatedAt\" = NOW() WHERE id = $2"
  ],
  "update_connection_access_token": [
    "\n        UPDATE \"WhatsappConnection\"\n        SET \"accessTokenEncrypted\" = $1,\n            \"phoneDisplayNumber\" = $2,\n            \"currentQualityRating\" = CAST($3 AS \"WhatsappConnectionQualityRating\"),\n            verified = $4,\n            \"dailyLimitEstimate\" = $5,\n            \"providerPermissions\" = $6,\n            \"updatedAt\" = NOW()\n        WHERE id = $7\n        ",
    "UPDATE \"WhatsappConnection\" SET \"providerPermissions\" = $1, \"updatedAt\" = NOW() WHERE id = $2"
  ],
  "connection_health": [
    "UPDATE \"WhatsappConnection\"\n           SET \"providerPermissions\" = COALESCE($1, \"providerPermissions\"), \"updatedAt\" = NOW()\n           WHERE id = $2"
  ]
} as const;
