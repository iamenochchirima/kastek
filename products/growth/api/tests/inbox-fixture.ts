import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { installPgTimestampParsers } from '../src/db.js';
import { readConfig } from '../src/config.js';
import type { InboxOptions } from '../src/services/inbox/types.js';
export async function inboxFixture(
  run: (pool: pg.Pool, options: InboxOptions) => Promise<void>,
) {
  installPgTimestampParsers();
  const url = process.env.CORE_INBOX_TEST_DATABASE_URL!,
    schema = `inbox_test_${randomUUID().replaceAll('-', '')}`,
    admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c timezone=UTC`,
  });
  try {
    const migrations = resolve(
      process.cwd(),
      '../database/prisma/migrations',
    );
    for (const folder of [
      '20260717120000_add_shared_connections',
      '20260831150000_add_connection_permission_center',
      '20260910100000_add_workspace_email_connections',
      '20260910120000_add_email_inbox_bindings',
    ]) {
      const source = readFileSync(
        resolve(migrations, folder, 'migration.sql'),
        'utf8',
      );
      for (const query of source.match(
        /CREATE (?:TYPE|TABLE|UNIQUE INDEX|INDEX)[\s\S]*?;/g,
      ) ?? [])
        await pool.query(query);
    }
    await pool.query(
      readFileSync(
        resolve(
          migrations,
          '20260829180000_add_core_analytics_outbox/migration.sql',
        ),
        'utf8',
      ),
    );
    const initial = readFileSync(
        resolve(
          migrations,
          '20260301000000_initial_client_schema/migration.sql',
        ),
        'utf8',
      ),
      convo = initial.match(/CREATE TABLE "Conversation"[\s\S]*?;/)![0],
      message = initial.match(/CREATE TABLE "Message"[\s\S]*?;/)![0];
    await pool.query(convo);
    await pool.query(message);
    await pool.query(
      `ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "orgId" text,ADD COLUMN IF NOT EXISTS "externalConnectionId" text,ADD COLUMN IF NOT EXISTS "customerId" text,ADD COLUMN IF NOT EXISTS "lastReadAt" timestamp,ADD COLUMN IF NOT EXISTS starred boolean DEFAULT false;CREATE UNIQUE INDEX conversation_identifier ON "Conversation"(channel,"customerIdentifier");ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "contentType" text DEFAULT 'TEXT',ADD COLUMN IF NOT EXISTS "providerMessageId" text,ADD COLUMN IF NOT EXISTS "providerStatus" text,ADD COLUMN IF NOT EXISTS "providerMetadata" jsonb,ADD COLUMN IF NOT EXISTS "whatsappMessageId" text,ADD COLUMN IF NOT EXISTS "whatsappStatus" text,ADD COLUMN IF NOT EXISTS "errorCode" text,ADD COLUMN IF NOT EXISTS "errorMessage" text,ADD COLUMN IF NOT EXISTS "editedAt" timestamp,ADD COLUMN IF NOT EXISTS "deletedAt" timestamp;CREATE UNIQUE INDEX message_provider ON "Message"("conversationId","providerMessageId");`,
    );
    for (const folder of [
      '20260729100000_refactor_inbox_message_domain',
      '20260717170000_add_canonical_customers',
    ]) {
      const source = readFileSync(
        resolve(migrations, folder, 'migration.sql'),
        'utf8',
      );
      for (const query of source.match(
        /CREATE (?:TYPE|TABLE|UNIQUE INDEX|INDEX)[\s\S]*?;/g,
      ) ?? [])
        if (!query.includes('WhatsappContact')) await pool.query(query);
    }
    await pool.query(
      `CREATE TYPE "SocialPlatform" AS ENUM('FACEBOOK','INSTAGRAM','THREADS','TIKTOK','BLUESKY','LINKEDIN','X');CREATE TYPE "SocialChannelStatus" AS ENUM('CONNECTED','DISCONNECTED','NEEDS_REAUTH');CREATE TABLE "SocialChannelConnection"(id text PRIMARY KEY,"userId" text,"orgId" text,platform "SocialPlatform",status "SocialChannelStatus","displayName" text,handle text,"externalAccountId" text,"accessToken" text,"refreshToken" text,metadata jsonb,"lastSyncedAt" timestamp,"createdAt" timestamp DEFAULT NOW(),"updatedAt" timestamp DEFAULT NOW(),UNIQUE("orgId",platform,"externalAccountId"));CREATE TABLE "WhatsappConnection"(id text,"orgId" text,"phoneNumberId" text,"phoneDisplayNumber" text,verified boolean,"updatedAt" timestamp,"createdAt" timestamp,"wabaId" text,"currentQualityRating" text,"dailyLimitEstimate" int,"authMethod" text,"providerPermissions" jsonb);`,
    );
    const config = readConfig({
        DATABASE_URL: url,
        SOCIAL_TOKEN_ENCRYPTION_KEY: 'fixture-key',
        AUTH_META_APP_SECRET: ' fixture-meta ',
        META_WEBHOOK_VERIFY_TOKEN: 'fixture-verify',
        KASITEK_EMAIL_GOOGLE_CLIENT_ID: 'fixture-client',
        KASITEK_EMAIL_GOOGLE_CLIENT_SECRET: 'fixture-secret',
        KASITEK_EMAIL_GOOGLE_REDIRECT_URI: 'http://localhost/callback',
      }),
      options: InboxOptions = {
        config,
        whatsapp: {
          listInboxConversations: async () => ({ conversations: [] }),
          listConversationMessages: async () => {
            throw Error('Unexpected WA path');
          },
          sendConversationMessage: async () => {
            throw Error('Unexpected WA path');
          },
          markConversationRead: async () => {
            throw Error('Unexpected WA path');
          },
          downloadMessageAttachment: async () => {
            throw Error('Unexpected WA path');
          },
        },
        publishEvent: async () => {},
      };
    await run(pool, options);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}
