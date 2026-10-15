ALTER TABLE "CreditLedgerEntry"
  DROP CONSTRAINT "CreditLedgerEntry_type_check";

ALTER TABLE "CreditLedgerEntry"
  ADD CONSTRAINT "CreditLedgerEntry_type_check"
  CHECK ("type" IN ('GRANT', 'RESERVE', 'DEBIT', 'REFUND', 'RELEASE', 'EXPIRY', 'ADJUSTMENT', 'REVOKE'));
