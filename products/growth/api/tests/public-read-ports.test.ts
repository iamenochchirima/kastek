import test from 'node:test';
import assert from 'node:assert/strict';
import { isolatedDatabase } from './helpers/database-fixture.js';
import { installPgTimestampParsers } from '../src/db.js';
import { readConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import {
  createPublicReadPorts,
  createPublicDomainAdapter,
} from '../src/capabilities/public-adapter.js';
import { registerDeveloperRoutes } from '../src/routes/developers.js';
import { registerWorkspaceRoutes } from '../src/routes/workspace.js';
import { registerPublicV1Routes } from '../src/routes/public-v1.js';
import { createApiKey } from '../src/services/public-api.js';
import { workspaceSummary } from '../src/services/workspace-summary.js';
import type { RequestContext } from '../src/identity/request-context.js';
installPgTimestampParsers();
const url = process.env.CORE_PUBLIC_READ_TEST_DATABASE_URL;
test(
  'real public aliases preserve canonical organization, scopes, pagination and filtering; workspace summary uses all native domains',
  { skip: !url },
  async () => {
    const fixture = await isolatedDatabase(url!, 'public_reads', [
      'DeveloperApiKey',
      'OrganizationMember',
      'PublicApiRequest',
      'UsageEvent',
      'PublicApiWebhookSubscription',
      'PublicApiWebhookDelivery',
      'WhatsappContact',
      'WhatsappContactListMembership',
      'WhatsappConnection',
      'WhatsappTemplate',
      'WhatsappCampaign',
      'WhatsappCampaignRecipient',
      'WhatsappSendEvent',
      'ExternalConnection',
      'Conversation',
      'Message',
      'MessageAttachment',
      'MessageReference',
      'MessageReaction',
      'SocialChannelConnection',
      'SocialPost',
    ]);
    const { pool } = fixture,
      core = {
        pool,
        config: readConfig({ DATABASE_URL: url!, LOG_LEVEL: 'silent' }),
      };
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await pool.query(`INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt")VALUES('membership','org','user','OWNER',NOW())`);
      await pool.query(
        `INSERT INTO "WhatsappConnection"(id,"userId","orgId","phoneNumberId","accessTokenEncrypted","wabaId","currentQualityRating","authMethod","dailyLimitEstimate","updatedAt") VALUES('connection','user','org','phone','unused','waba','GREEN','manual',10,NOW())`,
      );
      await pool.query(
        `INSERT INTO "WhatsappContact"(id,"userId","orgId",phone,"fullName",tags,"listLabel","optIn",metadata,"updatedAt") VALUES('contact','colleague','org','+123','Allowed',ARRAY['tag'],'approved',true,'{"private":true}',NOW()),('unapproved','user','org','+124','Unapproved',ARRAY[]::text[],'other',false,null,NOW()),('foreign','user','other','+125','Foreign',ARRAY[]::text[],'approved',true,null,NOW())`,
      );
      await pool.query(
        `INSERT INTO "WhatsappContactListMembership"(id,"userId","orgId","contactId","listLabel",tags,"optIn",metadata,"updatedAt") SELECT 'member_'||id,"userId","orgId",id,"listLabel",tags,"optIn",metadata,NOW() FROM "WhatsappContact"`,
      );
      await pool.query(
        `INSERT INTO "WhatsappTemplate"(id,"userId","orgId","connectionId","templateName",language,category,status,body,"updatedAt") VALUES('template','user','org','connection','welcome','en','MARKETING','PENDING','Private template',NOW()),('foreign_template','user','other','connection','other','en','MARKETING','PENDING','Other',NOW())`,
      );
      await pool.query(
        `INSERT INTO "WhatsappCampaign"(id,"userId","orgId","connectionId","templateId",name,"templateName","templateLanguage","failedCount","blockedCount","totalRecipients",status,"updatedAt") VALUES('campaign','colleague','org','connection','template','Campaign','welcome','en',2,3,8,'DRAFT',NOW()),('foreign_campaign','user','other','connection','foreign_template','Other','other','en',99,0,99,'DRAFT',NOW())`,
      );
      await pool.query(
        `INSERT INTO "Conversation"(id,channel,"customerIdentifier","customerName","orgId","unreadCount","lastMessageAt","updatedAt") VALUES('first','whatsapp','wa:connection:+123','First','org',1,NOW(),NOW()),('second','whatsapp','wa:connection:+124','Second','org',0,NOW()-INTERVAL '1 hour',NOW()),('foreign_conversation','whatsapp','wa:connection:+125','Foreign','other',9,NOW(),NOW())`,
      );
      await pool.query(
        `INSERT INTO "Message"(id,"conversationId",sender,content,"providerMessageId") VALUES('message','first','customer','Private message','provider')`,
      );
      await pool.query(
        `INSERT INTO "SocialPost"(id,"userId","orgId",content,channels,status,"updatedAt") VALUES('post','colleague','org','content','{}','DRAFT',NOW()),('other_post','user','other','content','{}','DRAFT',NOW())`,
      );
      const key = await createApiKey(pool, 'org', 'user', 'fixture', null),
        authorization = `Bearer ${key.secret}`;
      app = await buildApp(core, [
        (app, context) =>
          registerPublicV1Routes(
            app,
            context,
            createPublicDomainAdapter(pool, createPublicReadPorts(context)),
          ),
        registerDeveloperRoutes,
        registerWorkspaceRoutes,
      ]);
      assert.equal(
        (await app.inject({ url: '/api/workspace/summary' })).statusCode,
        401,
      );
      assert.equal(
        (await app.inject({ url: '/api/developers' })).statusCode,
        401,
      );
      const get = async (path: string) => {
        const result = await app!.inject({
          method: 'GET',
          url: path,
          headers: { authorization },
        });
        assert.equal(result.statusCode, 200, result.body);
        return result.json();
      };
      await pool.query(`UPDATE "WhatsappContactListMembership" SET location='Harare' WHERE id='member_contact'`);
      const filtered=await get('/v1/contacts?q=Allowed&optIn=all&excluded=false&location=Harare&listLabel=approved&tag=tag');
      assert.deepEqual(filtered.contacts.map((contact:{id:string})=>contact.id),['member_contact']);
      assert.equal((await app.inject({url:'/v1/contacts?excluded=unknown',headers:{authorization}})).statusCode,422);
      const contacts = await get('/v1/contacts?optIn=true&listLabel=approved');
      assert.equal(contacts.contacts.length, 1);
      assert.equal(contacts.contacts[0].id, 'member_contact');
      assert.equal(contacts.contacts[0].phone, '+123');
      assert.deepEqual(contacts.contacts[0].metadata, {private:true});
      const conversations = await get(
        '/v1/inbox/conversations?cursor=1&limit=1',
      );
      assert.equal(conversations.pagination.cursor, 1);
      assert.equal(conversations.conversations[0].id, 'second');
      assert.equal(conversations.pagination.nextCursor, null);
      assert.equal(conversations.conversations[0].phone, '+124');
      const messages = await get('/v1/inbox/conversations/first/messages');
      assert.equal(messages.messages[0].id, 'message');
      assert.equal(messages.messages[0].content, 'Private message');
      assert.ok(Array.isArray(messages.messages[0].attachments));
      assert.equal(
        (
          await app.inject({
            url: '/v1/inbox/conversations/foreign_conversation/messages',
            headers: { authorization },
          })
        ).statusCode,
        404,
      );
      assert.equal((await get('/v1/campaigns')).campaigns.length, 1);
      assert.equal(
        (await get('/v1/campaigns/campaign')).campaign.id,
        'campaign',
      );
      const templates = await get('/v1/templates');
      assert.equal(templates.templates.length, 1);
      assert.equal(templates.templates[0].body, 'Private template');
      await pool.query(
        `UPDATE "DeveloperApiKey" SET scopes=ARRAY['api:write'] WHERE id=$1`,
        [key.key.id],
      );
      assert.equal(
        (await app.inject({ url: '/v1/contacts', headers: { authorization } }))
          .statusCode,
        403,
      );
      const reads = createPublicReadPorts(core),
        context = { organizationId: 'org' } as RequestContext;
      await assert.rejects(
        reads.getCampaignSummary(context, 'foreign_campaign'),
        (e: unknown) =>
          typeof e === 'object' &&
          e !== null &&
          'status' in e &&
          e.status === 404,
      );
      const summary = (
        await workspaceSummary(core, 'org', 'user')
      ).summary;
      assert.equal(summary.agentCount, null);
      assert.equal(summary.attention.agentAttention, null);
      assert.equal(summary.socialPostCount, 1n);
      assert.equal(summary.contactsAggregate.total, 2n);
      assert.equal(summary.contactsAggregate.optedIn, 1n);
      assert.equal(summary.campaignsAggregate.totalCampaigns, 1n);
      assert.equal(summary.attention.campaignFailures, 5n);
      assert.equal(summary.attention.unreadConversations, 1n);
      assert.equal(summary.attention.socialAttention, 1n);
      assert.equal(summary.templateStatusMap.PENDING, 1n);
      assert.equal(summary.reviewQueue[0]!.body, 'Private template');
      assert.equal(summary.connections[0]!.stats.estimatedRemainingToday, 10);
      assert.ok(
        Number(
          (
            await pool.query(
              `SELECT COUNT(*) FROM "PublicApiRequest" WHERE "orgId"='org'`,
            )
          ).rows[0].count,
        ) >= 7,
      );
    } finally {
      await app?.close();
      await fixture.close();
    }
  },
);
