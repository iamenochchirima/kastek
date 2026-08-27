CREATE UNIQUE INDEX "ProductWaitlistEntry_active_email_key"
  ON "ProductWaitlistEntry" (lower(email))
  WHERE status IN ('new', 'reviewing', 'approved', 'invited', 'active');
