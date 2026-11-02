CREATE TABLE "OperationsNotificationReceipt" (
 id TEXT PRIMARY KEY,
 digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
