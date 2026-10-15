-- Early-access applicants may be individuals without a company name.
ALTER TABLE "ProductWaitlistEntry"
  ALTER COLUMN "businessName" DROP NOT NULL,
  ADD COLUMN "website" TEXT;
