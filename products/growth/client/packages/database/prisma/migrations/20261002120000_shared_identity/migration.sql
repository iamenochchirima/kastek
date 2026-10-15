-- Fresh identity boundary. Existing credential sessions are deliberately invalidated.
DELETE FROM "Session";
CREATE TABLE "ExternalIdentity" (issuer TEXT NOT NULL, subject TEXT NOT NULL, "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE, PRIMARY KEY (issuer,subject), UNIQUE("userId"));
CREATE TABLE "OidcTransaction" (state TEXT PRIMARY KEY,"browserHash" TEXT NOT NULL,nonce TEXT NOT NULL,verifier TEXT NOT NULL,"returnTo" TEXT NOT NULL,expires TIMESTAMP(3) NOT NULL);
CREATE TABLE "OidcLogoutReplay" (jti TEXT PRIMARY KEY,expires TIMESTAMP(3) NOT NULL);
ALTER TABLE "Session" ADD COLUMN "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ADD COLUMN "identityCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ADD COLUMN "providerRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ADD COLUMN "refreshToken" TEXT NOT NULL, ADD COLUMN "idToken" TEXT NOT NULL, ADD COLUMN "providerSid" TEXT;
CREATE INDEX "Session_providerSid_idx" ON "Session"("providerSid");
