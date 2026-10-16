ALTER TABLE agency_partner_business_requests
    ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
