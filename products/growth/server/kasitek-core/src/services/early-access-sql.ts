// SQL extracted from services/early_access.rs, preserving original parameter order.
export const EARLY_ACCESS_SQL = {
  "application_select": [
    "\n        SELECT id,\n               COALESCE(\"businessName\", \"contactPerson\") AS business_name,\n               \"contactPerson\" AS contact_person,\n               phone,\n               email,\n               \"businessType\" AS business_type,\n               website,\n               COALESCE(products, ARRAY[]::text[]) AS products,\n               notes,\n               source,\n               status,\n               cohort,\n               \"reviewNotes\" AS review_notes,\n               \"decisionReason\" AS decision_reason,\n               \"reviewedById\" AS reviewed_by_id,\n               \"reviewedAt\" AT TIME ZONE 'UTC' AS reviewed_at,\n               \"approvedById\" AS approved_by_id,\n               \"approvedAt\" AT TIME ZONE 'UTC' AS approved_at,\n               \"organizationId\" AS organization_id,\n               \"earlyAccessInvitationId\" AS early_access_invitation_id,\n               (SELECT status FROM \"EarlyAccessInvitation\" WHERE id = \"ProductWaitlistEntry\".\"earlyAccessInvitationId\") AS invitation_status,\n               (SELECT \"deliveryStatus\" FROM \"EarlyAccessInvitation\" WHERE id = \"ProductWaitlistEntry\".\"earlyAccessInvitationId\") AS invitation_delivery_status,\n               (SELECT \"expiresAt\" FROM \"EarlyAccessInvitation\" WHERE id = \"ProductWaitlistEntry\".\"earlyAccessInvitationId\") AS invitation_expires_at,\n               \"packageKey\" AS package_key,\n               \"packageSnapshot\" AS package_snapshot,\n               \"activatedAt\" AT TIME ZONE 'UTC' AS activated_at,\n               \"earlyAccessEndsAt\" AT TIME ZONE 'UTC' AS early_access_ends_at,\n               \"entitlementGrantIds\" AS entitlement_grant_ids,\n               \"creditGrantId\" AS credit_grant_id,\n               \"createdAt\" AT TIME ZONE 'UTC' AS created_at,\n               \"updatedAt\" AT TIME ZONE 'UTC' AS updated_at\n        FROM \"ProductWaitlistEntry\"\n    "
  ],
  "expire_due_invitations": [
    "UPDATE \"EarlyAccessInvitation\"\n           SET status = 'expired', \"updatedAt\" = NOW()\n           WHERE status = 'pending' AND \"expiresAt\" <= NOW()"
  ],
  "record_event": [
    "INSERT INTO \"ProductWaitlistEvent\"\n           (id, \"waitlistEntryId\", \"fromStatus\", \"toStatus\", action, \"actorId\", reason, metadata, \"createdAt\")\n           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())"
  ],
  "get_application": [
    "SELECT id, \"waitlistEntryId\" AS waitlist_entry_id,\n                  \"fromStatus\" AS from_status, \"toStatus\" AS to_status,\n                  action, \"actorId\" AS actor_id, reason, metadata,\n                  \"createdAt\" AT TIME ZONE 'UTC' AS created_at\n           FROM \"ProductWaitlistEvent\"\n           WHERE \"waitlistEntryId\" = $1\n           ORDER BY \"createdAt\" ASC, id ASC"
  ],
  "reject_application": [
    "UPDATE \"ProductWaitlistEntry\"\n           SET status = $1, \"decisionReason\" = $2, \"reviewedById\" = $3,\n               \"reviewedAt\" = NOW(), \"updatedAt\" = NOW()\n           WHERE id = $4"
  ],
  "ensure_entitlement_grant": [
    "SELECT id FROM \"OrganizationEntitlementGrant\"\n           WHERE \"orgId\" = $1 AND key = $2 AND source = 'MANUAL'::\"EntitlementSource\" AND reason = $3\n             AND (\"endsAt\" IS NULL OR \"endsAt\" > NOW())\n           ORDER BY \"createdAt\" DESC LIMIT 1"
  ],
  "mark_invitation_delivery": [
    "UPDATE \"EarlyAccessInvitation\"\n           SET \"deliveryStatus\" = $1, \"deliveryAttempts\" = \"deliveryAttempts\" + 1,\n               \"lastDeliveryAttemptAt\" = NOW(), \"lastDeliveryErrorCode\" = $2, \"updatedAt\" = NOW()\n           WHERE id = $3"
  ],
  "release_activation_claim": [
    "UPDATE \"EarlyAccessInvitation\"\n           SET status = 'pending', \"acceptedAt\" = NULL, \"updatedAt\" = NOW()\n           WHERE id = $1 AND status = 'accepted'"
  ],
  "create_signup_invitation": [
    "UPDATE \"EarlyAccessInvitation\" SET status = 'revoked', \"revokedAt\" = NOW(), \"updatedAt\" = NOW()\n           WHERE \"waitlistEntryId\" = $1 AND status = 'pending'",
    "INSERT INTO \"EarlyAccessInvitation\"\n           (id, \"waitlistEntryId\", email, \"tokenHash\", status, \"deliveryStatus\", \"expiresAt\", \"createdById\", \"createdAt\", \"updatedAt\")\n           VALUES ($1, $2, $3, $4, 'pending', 'pending', $5, $6, NOW(), NOW())",
    "UPDATE \"ProductWaitlistEntry\"\n           SET status = CASE WHEN status IN ('approved', 'invited') THEN status ELSE 'approved' END,\n               \"approvedById\" = $1, \"approvedAt\" = COALESCE(\"approvedAt\", NOW()),\n               \"reviewedById\" = COALESCE(\"reviewedById\", $1), \"reviewedAt\" = COALESCE(\"reviewedAt\", NOW()),\n               \"earlyAccessInvitationId\" = $2, \"packageKey\" = $3, \"packageSnapshot\" = $4,\n               \"updatedAt\" = NOW() WHERE id = $5",
    "UPDATE \"ProductWaitlistEntry\" SET status = 'invited', \"updatedAt\" = NOW() WHERE id = $1"
  ],
  "approve_self_service_application": [
    "SELECT EXISTS(SELECT 1 FROM \"EarlyAccessInvitation\" WHERE id = $1 AND status = 'pending' AND \"expiresAt\" > NOW())"
  ],
  "signup_invitation_preview": [
    "SELECT i.email, i.status, i.\"expiresAt\" AS expires_at, COALESCE(w.\"businessName\", w.\"contactPerson\") AS business_name FROM \"EarlyAccessInvitation\" i JOIN \"ProductWaitlistEntry\" w ON w.id = i.\"waitlistEntryId\" WHERE i.\"tokenHash\" = $1"
  ],
  "activate_signup_invitation": [
    "SELECT i.id, i.\"waitlistEntryId\", i.email, i.status,\n                  i.\"expiresAt\" AS expires_at\n           FROM \"EarlyAccessInvitation\" i\n           WHERE i.\"tokenHash\" = $1",
    "SELECT email FROM \"User\" WHERE id = $1",
    "UPDATE \"EarlyAccessInvitation\"\n           SET status = 'accepted', \"acceptedAt\" = NOW(), \"updatedAt\" = NOW()\n           WHERE id = $1 AND status = 'pending' AND \"expiresAt\" > NOW()\n           RETURNING id",
    "UPDATE \"ProductWaitlistEntry\" SET status = 'active', \"organizationId\" = $1, \"activatedAt\" = NOW(), \"earlyAccessEndsAt\" = $2, \"entitlementGrantIds\" = $3, \"creditGrantId\" = $4, \"updatedAt\" = NOW() WHERE id = $5 AND status IN ('approved', 'invited')"
  ],
  "restore_application": [
    "UPDATE \"ProductWaitlistEntry\"\n           SET status = 'approved', \"decisionReason\" = $1, \"updatedAt\" = NOW()\n           WHERE id = $2 AND status = 'revoked'"
  ],
  "revoke_application": [
    "UPDATE \"EarlyAccessInvitation\"\n           SET status = 'revoked', \"revokedAt\" = NOW(), \"updatedAt\" = NOW()\n           WHERE \"waitlistEntryId\" = $1 AND status = 'pending'",
    "UPDATE \"ProductWaitlistEntry\" SET status = 'revoked', \"decisionReason\" = $1, \"updatedAt\" = NOW() WHERE id = $2"
  ],
  "status_for_org": [
    "SELECT id, status, \"earlyAccessEndsAt\", \"activatedAt\", \"createdAt\"\n           FROM \"ProductWaitlistEntry\"\n           WHERE \"organizationId\" = $1 AND status IN ('approved', 'invited', 'active', 'expired', 'revoked')\n           ORDER BY \"createdAt\" DESC LIMIT 1"
  ],
  "expire_due_access": [
    "SELECT id, status, COALESCE(\"businessName\", \"contactPerson\") FROM \"ProductWaitlistEntry\"\n           WHERE \"earlyAccessEndsAt\" IS NOT NULL AND \"earlyAccessEndsAt\" <= NOW()\n             AND status IN ('approved', 'invited', 'active')",
    "UPDATE \"ProductWaitlistEntry\" SET status = 'expired', \"updatedAt\" = NOW() WHERE id = $1 AND status = $2"
  ]
} as const;
