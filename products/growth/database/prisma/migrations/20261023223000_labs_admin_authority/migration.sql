CREATE TABLE "AdminServiceAssertionNonce" (nonce TEXT PRIMARY KEY,"expiresAt" TIMESTAMP(3) NOT NULL);
CREATE INDEX "AdminServiceAssertionNonce_expiry" ON "AdminServiceAssertionNonce"("expiresAt");
