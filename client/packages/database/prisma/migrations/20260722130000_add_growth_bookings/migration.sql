CREATE TYPE "BookingStatus" AS ENUM ('SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

CREATE TABLE "BookingService" (
    id TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    "durationMinutes" INTEGER NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BookingService_pkey" PRIMARY KEY (id)
);

CREATE TABLE "Booking" (
    id TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "customerId" TEXT,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT,
    "scheduledStart" TIMESTAMP(3) NOT NULL,
    "scheduledEnd" TIMESTAMP(3) NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Africa/Johannesburg',
    status "BookingStatus" NOT NULL DEFAULT 'SCHEDULED',
    notes TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Booking_pkey" PRIMARY KEY (id)
);

CREATE UNIQUE INDEX "BookingService_orgId_name_key" ON "BookingService"("orgId", name);
CREATE INDEX "BookingService_orgId_active_idx" ON "BookingService"("orgId", active);
CREATE INDEX "Booking_orgId_scheduledStart_idx" ON "Booking"("orgId", "scheduledStart");
CREATE INDEX "Booking_orgId_status_scheduledStart_idx" ON "Booking"("orgId", status, "scheduledStart");
CREATE INDEX "Booking_serviceId_scheduledStart_idx" ON "Booking"("serviceId", "scheduledStart");
CREATE INDEX "Booking_customerId_scheduledStart_idx" ON "Booking"("customerId", "scheduledStart");

ALTER TABLE "BookingService"
  ADD CONSTRAINT "BookingService_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"(id)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"(id)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Booking_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "BookingService"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Booking_customerId_fkey"
  FOREIGN KEY ("orgId", "customerId") REFERENCES "Customer"("orgId", id)
  ON DELETE RESTRICT ON UPDATE CASCADE;
