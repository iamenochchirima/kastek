-- Booking domain integration fixture. The whole script runs in a transaction and
-- rolls back, so it is safe to execute against a disposable local database.
BEGIN;

INSERT INTO "User" (id, email, "createdAt", "updatedAt") VALUES
  ('booking-integration-owner-a', 'booking-integration-owner-a@example.test', NOW(), NOW()),
  ('booking-integration-owner-b', 'booking-integration-owner-b@example.test', NOW(), NOW());

INSERT INTO "Organization" (id, name, slug, "ownerId", "createdAt", "updatedAt") VALUES
  ('booking-integration-org-a', 'Booking Integration A', 'booking-integration-a', 'booking-integration-owner-a', NOW(), NOW()),
  ('booking-integration-org-b', 'Booking Integration B', 'booking-integration-b', 'booking-integration-owner-b', NOW(), NOW());

INSERT INTO "BookingService" (
  id, "orgId", name, description, "durationMinutes", active, "createdAt", "updatedAt"
) VALUES
  ('booking-integration-service-a', 'booking-integration-org-a', 'Consultation', 'One hour', 60, true, NOW(), NOW()),
  ('booking-integration-service-b', 'booking-integration-org-b', 'Consultation', 'One hour', 60, true, NOW(), NOW());

INSERT INTO "Customer" (id, "orgId", "displayName", "createdAt", "updatedAt") VALUES
  ('booking-integration-customer-a', 'booking-integration-org-a', 'Customer A', NOW(), NOW()),
  ('booking-integration-customer-b', 'booking-integration-org-b', 'Customer B', NOW(), NOW());

INSERT INTO "Booking" (
  id, "orgId", "serviceId", "customerId", "contactName", "scheduledStart", "scheduledEnd",
  timezone, status, "createdAt", "updatedAt"
) VALUES
  (
    'booking-integration-booking-a', 'booking-integration-org-a', 'booking-integration-service-a',
    'booking-integration-customer-a', 'Customer A', '2035-01-01T10:00:00Z', '2035-01-01T11:00:00Z',
    'UTC', 'SCHEDULED', NOW(), NOW()
  ),
  (
    'booking-integration-booking-b', 'booking-integration-org-b', 'booking-integration-service-b',
    'booking-integration-customer-b', 'Customer B', '2035-01-01T10:00:00Z', '2035-01-01T11:00:00Z',
    'UTC', 'SCHEDULED', NOW(), NOW()
  );

DO $$
DECLARE
  org_a_bookings integer;
  org_b_bookings integer;
  cross_org_lookup integer;
  overlapping_slot boolean;
  cancelled_slot boolean;
BEGIN
  SELECT count(*) INTO org_a_bookings
  FROM "Booking" WHERE "orgId" = 'booking-integration-org-a';
  SELECT count(*) INTO org_b_bookings
  FROM "Booking" WHERE "orgId" = 'booking-integration-org-b';
  IF org_a_bookings <> 1 OR org_b_bookings <> 1 THEN
    RAISE EXCEPTION 'booking list is not organization scoped: org_a=%, org_b=%', org_a_bookings, org_b_bookings;
  END IF;

  SELECT count(*) INTO cross_org_lookup
  FROM "Booking"
  WHERE id = 'booking-integration-booking-a' AND "orgId" = 'booking-integration-org-b';
  IF cross_org_lookup <> 0 THEN
    RAISE EXCEPTION 'cross-organization booking lookup returned a row';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM "Booking"
    WHERE "serviceId" = 'booking-integration-service-a'
      AND "orgId" = 'booking-integration-org-a'
      AND status NOT IN ('CANCELLED'::"BookingStatus", 'NO_SHOW'::"BookingStatus")
      AND "scheduledStart" < '2035-01-01T11:30:00Z'
      AND "scheduledEnd" > '2035-01-01T10:30:00Z'
  ) INTO overlapping_slot;
  IF NOT overlapping_slot THEN
    RAISE EXCEPTION 'overlap query failed to detect an active booking';
  END IF;

  UPDATE "Booking" SET status = 'CANCELLED'::"BookingStatus"
  WHERE id = 'booking-integration-booking-a';
  SELECT EXISTS(
    SELECT 1 FROM "Booking"
    WHERE "serviceId" = 'booking-integration-service-a'
      AND "orgId" = 'booking-integration-org-a'
      AND status NOT IN ('CANCELLED'::"BookingStatus", 'NO_SHOW'::"BookingStatus")
      AND "scheduledStart" < '2035-01-01T11:30:00Z'
      AND "scheduledEnd" > '2035-01-01T10:30:00Z'
  ) INTO cancelled_slot;
  IF cancelled_slot THEN
    RAISE EXCEPTION 'cancelled booking was treated as an active overlap';
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO "Booking" (
      id, "orgId", "serviceId", "customerId", "contactName", "scheduledStart", "scheduledEnd",
      timezone, status, "createdAt", "updatedAt"
    ) VALUES (
      'booking-integration-cross-org-customer', 'booking-integration-org-a', 'booking-integration-service-a',
      'booking-integration-customer-b', 'Invalid Cross Org', '2035-01-02T10:00:00Z',
      '2035-01-02T11:00:00Z', 'UTC', 'SCHEDULED', NOW(), NOW()
    );
    RAISE EXCEPTION 'cross-organization customer booking was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;

ROLLBACK;
