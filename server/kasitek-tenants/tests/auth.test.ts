import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { readConfig } from '../src/config.js';
import { installErrorHandler } from '../src/error.js';
import { apiJson } from '../src/json.js';
import { runMigrations } from '../src/migrate.js';
import { installPgTimestampParsers } from '../src/db.js';
import {
  registerAuthRoutes,
  hashPassword,
  newToken,
} from '../src/controllers/auth.js';
import { registerSessionRoutes } from '../src/controllers/session.js';
import { registerAdminRoutes } from '../src/controllers/admin.js';
import { registerWorkspaceRoutes } from '../src/controllers/workspace.js';
import { registerPartnerBusinessRoutes } from '../src/controllers/partner-businesses.js';
import { registerPartnerAuthRoutes } from '../src/controllers/partner-auth.js';
import { registerClientsRoutes } from '../src/controllers/clients.js';
import {
  registerClientAuthRoutes,
  issueClientInvite,
} from '../src/controllers/client-auth.js';
import {
  registerAdminInvitesRoutes,
  issueAdminInvite,
} from '../src/controllers/admin-invites.js';
import {
  extractAccessContext,
  tokenHash,
  requireActiveTenantClient,
  requireClientScopedConversation,
} from '../src/middleware.js';
import {
  createResendDomain,
  sendEmail,
  sendTenantAdminInviteEmail,
  resolveWorkspaceEmailSender,
  workspacePortalUrl,
} from '../src/mail.js';
const url = process.env.TENANT_TEST_DATABASE_URL;
test(
  'Agency staff/client sessions preserve host binding, distinct audience, invitations and invalidation',
  { skip: !url },
  async () => {
    installPgTimestampParsers();
    const admin = new pg.Pool({ connectionString: url }),
      schema = `tenant_auth_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    const app = Fastify({
      ajv: {
        customOptions: {
          coerceTypes: false,
          removeAdditional: false,
          useDefaults: false,
        },
      },
    });
    const config = readConfig({
        TENANT_DATABASE_URL: url,
        TENANT_PLATFORM_BASE_DOMAIN: 'agency.example',
        TENANT_APP_BASE_URL: 'http://localhost:3001',
      }),
      context = { pool, config };
    try {
      await runMigrations(pool);
      await app.register(cookie);
      app.setReplySerializer(apiJson);
      installErrorHandler(app);
      registerAuthRoutes(app, context);
      registerSessionRoutes(app, context);
      registerClientAuthRoutes(app, context);
      registerAdminInvitesRoutes(app, context);
      registerAdminRoutes(app, context);
      registerWorkspaceRoutes(app, context);
      registerPartnerAuthRoutes(app, context);
      registerPartnerBusinessRoutes(app, context);
      registerClientsRoutes(app, context);
      app.get('/fixture/access', (request) =>
        extractAccessContext(request, context),
      );
      const hash = await hashPassword('fixture password');
      await pool.query(
        "INSERT INTO workspaces(id,slug,display_name) VALUES ('a','alpha','Agency A'),('b','beta','Agency B')",
      );
      await pool.query(
        "INSERT INTO workspace_domains(id,workspace_id,domain) VALUES ('custom','a','custom.example')",
      );
      await pool.query(
        "INSERT INTO tenant_users(id,workspace_id,email,password_hash,status) VALUES ('staff-a','a','staff@example.test',$1,'active'),('staff-b','b','staff@example.test',$1,'active'),('setup-a','a','setup@example.test','','invited'),('owner-a','a','partner@example.test',NULL,'active')",
        [hash],
      );
      await pool.query(
        "INSERT INTO tenant_user_roles(tenant_user_id,role) VALUES ('staff-a','admin'),('staff-a','staff'),('setup-a','admin'),('owner-a','owner')",
      );
      await pool.query(
        "INSERT INTO agency_partners(id,issuer,subject,email,email_verified) VALUES ('partner-a','http://issuer.example/realms/kasitek','subject-a','partner@example.test',TRUE)",
      );
      await pool.query(
        "INSERT INTO agency_partner_memberships(partner_id,workspace_id,tenant_user_id) VALUES ('partner-a','a','owner-a')",
      );
      const partnerToken = newToken();
      await pool.query(
        "INSERT INTO agency_partner_sessions(id,partner_id,token_hash,expires_at,last_used_at) VALUES ('partner-session-a','partner-a',$1,NOW()+INTERVAL '30 days',NOW()-INTERVAL '1 day')",
        [tokenHash(partnerToken)],
      );
      const emptyPartnerToken = newToken();
      await pool.query(
        "INSERT INTO agency_partners(id,issuer,subject,email,email_verified) VALUES ('partner-empty','http://issuer.example/realms/kasitek','subject-empty','empty@example.test',TRUE)",
      );
      await pool.query(
        "INSERT INTO agency_partner_sessions(id,partner_id,token_hash,expires_at,last_used_at) VALUES ('partner-session-empty','partner-empty',$1,NOW()+INTERVAL '30 days',NOW())",
        [tokenHash(emptyPartnerToken)],
      );
      const idlePartnerToken = newToken();
      const expiredPartnerToken = newToken();
      await pool.query(
        "INSERT INTO agency_partners(id,issuer,subject,email,email_verified) VALUES ('partner-idle','http://issuer.example/realms/kasitek','subject-idle','idle@example.test',TRUE),('partner-expired','http://issuer.example/realms/kasitek','subject-expired','expired@example.test',TRUE)",
      );
      await pool.query(
        `INSERT INTO agency_partner_sessions(id,partner_id,token_hash,expires_at,last_used_at)
         VALUES ('partner-session-idle','partner-idle',$1,NOW()+INTERVAL '30 days',NOW()-INTERVAL '8 days'),
                ('partner-session-expired','partner-expired',$2,NOW()-INTERVAL '1 second',NOW())`,
        [tokenHash(idlePartnerToken), tokenHash(expiredPartnerToken)],
      );
      await pool.query(
        "INSERT INTO tenant_clients(id,workspace_id,name,slug) VALUES ('client-a','a','Client A','a'),('client-b','b','Client B','b'),('sibling-client','a','Sibling Client','sibling')",
      );
      await pool.query(
        "INSERT INTO tenant_client_users(id,workspace_id,tenant_client_id,email,password_hash,status) VALUES ('customer-a','a','client-a','customer@example.test',$1,'active'),('invite-customer','a','client-a','invite@example.test',NULL,'invited')",
        [hash],
      );
      await pool.query(
        "INSERT INTO tenant_client_user_roles(tenant_client_user_id,role) VALUES ('customer-a','client'),('invite-customer','client')",
      );
      const call = (
        method: 'GET' | 'POST',
        path: string,
        payload?: unknown,
        cookies = '',
        host = 'alpha.agency.example',
      ) =>
        app.inject({
          method,
          url: path,
          headers: { host, ...(cookies ? { cookie: cookies } : {}) },
          ...(payload === undefined ? {} : { payload }),
        });
      const adminWithoutSecret = await call('GET', '/api/admin/workspaces');
      assert.equal(adminWithoutSecret.statusCode, 403);
      const emptyPartnerCookie = `${config.partner_session_cookie_name}=${emptyPartnerToken}`;
      const emptyPartnerMe = await call('GET', '/api/partner/auth/me', undefined, emptyPartnerCookie);
      assert.equal(emptyPartnerMe.statusCode, 200, emptyPartnerMe.body);
      const emptyPartnerBusinesses = await call('GET', '/api/partner/businesses', undefined, emptyPartnerCookie);
      assert.equal(emptyPartnerBusinesses.statusCode, 200, emptyPartnerBusinesses.body);
      assert.deepEqual(emptyPartnerBusinesses.json().businesses, []);
      assert.equal(
        (await call('GET', '/api/workspace', undefined, emptyPartnerCookie)).statusCode,
        401,
      );
      assert.equal(
        (await call('GET', '/api/partner/auth/me', undefined, `${config.partner_session_cookie_name}=${idlePartnerToken}`)).statusCode,
        401,
      );
      assert.equal(
        (await call('GET', '/api/partner/auth/me', undefined, `${config.partner_session_cookie_name}=${expiredPartnerToken}`)).statusCode,
        401,
      );
      const partnerAccess = await call(
        'GET',
        '/fixture/access',
        undefined,
        `${config.partner_session_cookie_name}=${partnerToken}`,
      );
      assert.equal(partnerAccess.statusCode, 200, partnerAccess.body);
      assert.deepEqual(partnerAccess.json(), {
        workspace_id: 'a',
        workspace_slug: 'alpha',
        scopes: ['tenant:portal'],
        tenant_user_id: 'owner-a',
        tenant_user_roles: ['owner'],
      });
      const partnerSession = await call(
        'GET',
        '/api/auth/session',
        undefined,
        `${config.partner_session_cookie_name}=${partnerToken}`,
      );
      assert.equal(partnerSession.statusCode, 200, partnerSession.body);
      assert.equal(partnerSession.json().audience, 'tenant');
      assert.equal(partnerSession.json().user.agencyPartner, true);
      const partnerWorkspace = await call(
        'GET',
        '/api/workspace',
        undefined,
        `${config.partner_session_cookie_name}=${partnerToken}`,
      );
      assert.equal(partnerWorkspace.statusCode, 200, partnerWorkspace.body);
      assert.equal(partnerWorkspace.json().workspace.tenantUserId, 'owner-a');
      assert.deepEqual(partnerWorkspace.json().workspace.tenantUserRoles, ['owner']);
      const lastUsedBeforeReads = (await pool.query(
        "SELECT to_char(last_used_at,'YYYY-MM-DD HH24:MI:SS.US') AS value FROM agency_partner_sessions WHERE id='partner-session-a'",
      )).rows[0].value;
      await call('GET', '/api/partner/auth/me', undefined, `${config.partner_session_cookie_name}=${partnerToken}`);
      await call('GET', '/api/partner/businesses', undefined, `${config.partner_session_cookie_name}=${partnerToken}`);
      const lastUsedAfterReads = (await pool.query(
        "SELECT to_char(last_used_at,'YYYY-MM-DD HH24:MI:SS.US') AS value FROM agency_partner_sessions WHERE id='partner-session-a'",
      )).rows[0].value;
      assert.equal(lastUsedAfterReads, lastUsedBeforeReads);
      const recordedActivity = await app.inject({
        method: 'POST',
        url: '/api/partner/auth/activity',
        headers: {
          host: 'alpha.agency.example',
          origin: config.partner_app_base_url,
          cookie: `${config.partner_session_cookie_name}=${partnerToken}`,
        },
      });
      assert.equal(recordedActivity.statusCode, 204, recordedActivity.body);
      const lastUsedAfterActivity = (await pool.query(
        "SELECT to_char(last_used_at,'YYYY-MM-DD HH24:MI:SS.US') AS value FROM agency_partner_sessions WHERE id='partner-session-a'",
      )).rows[0].value;
      assert.ok(lastUsedAfterActivity > lastUsedAfterReads);
      const rejectedCrossOriginActivity = await app.inject({
        method: 'POST',
        url: '/api/partner/auth/activity',
        headers: {
          host: 'alpha.agency.example',
          origin: 'https://untrusted.example',
          cookie: `${config.partner_session_cookie_name}=${partnerToken}`,
        },
      });
      assert.equal(rejectedCrossOriginActivity.statusCode, 401);
      const lastUsedAfterRejectedActivity = (await pool.query(
        "SELECT to_char(last_used_at,'YYYY-MM-DD HH24:MI:SS.US') AS value FROM agency_partner_sessions WHERE id='partner-session-a'",
      )).rows[0].value;
      assert.equal(lastUsedAfterRejectedActivity, lastUsedAfterActivity);
      const partnerDomainAttempt = await app.inject({
        method: 'POST',
        url: '/api/workspace/domains',
        headers: {
          host: 'alpha.agency.example',
          origin: config.partner_app_base_url,
          cookie: `${config.partner_session_cookie_name}=${partnerToken}`,
        },
        payload: { domain: 'agency.example.test' },
      });
      assert.equal(partnerDomainAttempt.statusCode, 403);
      const partnerCookie = `${config.partner_session_cookie_name}=${partnerToken}`;
      const spoofedOwnerAttempt = await app.inject({
        method: 'POST',
        url: '/api/partner/businesses',
        headers: {
          host: 'alpha.agency.example',
          origin: config.partner_app_base_url,
          cookie: partnerCookie,
          'idempotency-key': 'fixture-business-request-key-spoof',
        },
        payload: { name: 'Spoofed Owner', ownerId: 'someone-else', role: 'owner' },
      });
      assert.equal(spoofedOwnerAttempt.statusCode, 400);
      const businessBody = {
        name: 'Northstar Creative',
        reportingTimezone: 'Africa/Johannesburg',
        primaryColor: '#123456',
      };
      const createBusiness = () => app.inject({
        method: 'POST',
        url: '/api/partner/businesses',
        headers: {
          host: 'alpha.agency.example',
          origin: config.partner_app_base_url,
          cookie: partnerCookie,
          'idempotency-key': 'fixture-business-request-key-0001',
        },
        payload: businessBody,
      });
      await pool.query(`CREATE FUNCTION reject_partner_business_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'business.created' THEN
            RAISE EXCEPTION 'forced rollback test';
          END IF;
          RETURN NEW;
        END;
      $$ LANGUAGE plpgsql`);
      await pool.query(`CREATE TRIGGER reject_partner_business_audit
        BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_partner_business_audit()`);
      const rolledBackBusiness = await app.inject({
        method: 'POST',
        url: '/api/partner/businesses',
        headers: {
          host: 'alpha.agency.example',
          origin: config.partner_app_base_url,
          cookie: partnerCookie,
          'idempotency-key': 'fixture-business-request-rollback',
        },
        payload: { name: 'Rollback Studio', reportingTimezone: 'UTC' },
      });
      assert.equal(rolledBackBusiness.statusCode, 500);
      const rollbackCounts = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM workspaces WHERE slug='rollback-studio') AS workspaces,
           (SELECT COUNT(*) FROM workspace_branding b JOIN workspaces w ON w.id=b.workspace_id WHERE w.slug='rollback-studio') AS branding,
           (SELECT COUNT(*) FROM agency_partner_memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE w.slug='rollback-studio') AS memberships,
           (SELECT COUNT(*) FROM agency_partner_business_requests WHERE partner_id='partner-a' AND request_key='fixture-business-request-rollback') AS requests`,
      );
      assert.deepEqual(rollbackCounts.rows[0], {
        workspaces: '0', branding: '0', memberships: '0', requests: '0',
      });
      await pool.query('DROP TRIGGER reject_partner_business_audit ON audit_logs');
      await pool.query('DROP FUNCTION reject_partner_business_audit()');
      const createdBusiness = await createBusiness();
      assert.equal(createdBusiness.statusCode, 201, createdBusiness.body);
      const createdBusinessId = createdBusiness.json().business.id as string;
      assert.equal(createdBusiness.json().business.slug, 'northstar-creative');
      assert.equal(createdBusiness.json().business.portalPath, '/portal/northstar-creative');
      const partnerCannotInviteTheirOwnAccount = await app.inject({
        method: 'POST',
        url: '/api/workspace/staff',
        headers: {
          host: 'northstar-creative.agency.example',
          origin: config.partner_app_base_url,
          cookie: partnerCookie,
        },
        payload: { email: 'partner@example.test', role: 'admin' },
      });
      assert.equal(partnerCannotInviteTheirOwnAccount.statusCode, 403);
      const ownerRolesAfterSelfInvite = await pool.query(
        `SELECT r.role FROM agency_partner_memberships m
         JOIN tenant_user_roles r ON r.tenant_user_id=m.tenant_user_id
         WHERE m.partner_id='partner-a' AND m.workspace_id=$1 ORDER BY r.role`,
        [createdBusinessId],
      );
      assert.deepEqual(ownerRolesAfterSelfInvite.rows.map((row) => row.role), ['owner']);
      const partnerBusinessList = await call(
        'GET',
        '/api/partner/businesses',
        undefined,
        partnerCookie,
      );
      assert.equal(partnerBusinessList.statusCode, 200, partnerBusinessList.body);
      assert.equal(partnerBusinessList.json().businesses.length, 2);
      assert.ok(partnerBusinessList.json().businesses.some((business) => business.id === createdBusinessId));
      const workspaceHeaders = {
        host: 'northstar-creative.agency.example',
        cookie: partnerCookie,
      };
      const ownedClientsBefore = await app.inject({ method: 'GET', url: '/api/clients', headers: workspaceHeaders });
      assert.equal(ownedClientsBefore.statusCode, 200, ownedClientsBefore.body);
      assert.deepEqual(ownedClientsBefore.json().clients, []);
      const clientCreated = await app.inject({
        method: 'POST',
        url: '/api/clients',
        headers: workspaceHeaders,
        payload: { name: 'Northstar Customer', adminEmail: 'client@example.test' },
      });
      assert.equal(clientCreated.statusCode, 200, clientCreated.body);
      assert.equal(clientCreated.json().client.workspaceId, createdBusinessId);
      assert.equal(typeof clientCreated.json().adminInvite.activationUrl, 'string');
      const ownedClientsAfter = await app.inject({ method: 'GET', url: '/api/clients', headers: workspaceHeaders });
      assert.equal(ownedClientsAfter.statusCode, 200, ownedClientsAfter.body);
      assert.equal(ownedClientsAfter.json().clients.length, 1);
      const staffInvited = await app.inject({
        method: 'POST',
        url: '/api/workspace/staff',
        headers: { ...workspaceHeaders, origin: config.partner_app_base_url },
        payload: { email: 'staff@example.test', name: 'Agency Staff', role: 'admin' },
      });
      assert.equal(staffInvited.statusCode, 201, staffInvited.body);
      assert.equal(typeof staffInvited.json().invite.activationUrl, 'string');
      const ownedStaff = await app.inject({ method: 'GET', url: '/api/workspace/staff', headers: workspaceHeaders });
      assert.equal(ownedStaff.statusCode, 200, ownedStaff.body);
      const businessDetails = await call(
        'GET',
        `/api/partner/businesses/${createdBusinessId}`,
        undefined,
        partnerCookie,
      );
      assert.equal(businessDetails.statusCode, 200, businessDetails.body);
      assert.equal(businessDetails.json().business.staffCount, 1);
      assert.equal(businessDetails.json().business.clientCount, 1);
      const clientCookieAttempt = await app.inject({
        method: 'POST',
        url: '/api/partner/businesses',
        headers: {
          host: 'alpha.agency.example',
          origin: config.partner_app_base_url,
          cookie: `${partnerCookie}; ${config.client_session_cookie_name}=client-session`,
          'idempotency-key': 'fixture-business-request-key-0002',
        },
        payload: { name: 'Blocked by client session' },
      });
      assert.equal(clientCookieAttempt.statusCode, 403);
      const replayedBusiness = await createBusiness();
      assert.equal(replayedBusiness.statusCode, 200, replayedBusiness.body);
      assert.equal(replayedBusiness.json().business.id, createdBusinessId);
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/partner/businesses/${createdBusinessId}/branding`,
        headers: {
          host: 'alpha.agency.example',
          origin: config.partner_app_base_url,
          cookie: partnerCookie,
        },
        payload: { displayName: 'Northstar Studio' },
      });
      assert.equal(renamed.statusCode, 200, renamed.body);
      const brandedPortalContext = await call(
        'GET',
        '/api/public/tenant-context',
        undefined,
        '',
        'northstar-creative.agency.example',
      );
      assert.equal(brandedPortalContext.statusCode, 200, brandedPortalContext.body);
      assert.equal(brandedPortalContext.json().branding.displayName, 'Northstar Studio');
      const retryAfterRename = await createBusiness();
      assert.equal(retryAfterRename.statusCode, 200, retryAfterRename.body);
      assert.equal(retryAfterRename.json().business.id, createdBusinessId);
      const reusedKey = await app.inject({
        method: 'POST',
        url: '/api/partner/businesses',
        headers: {
          host: 'alpha.agency.example',
          origin: config.partner_app_base_url,
          cookie: partnerCookie,
          'idempotency-key': 'fixture-business-request-key-0001',
        },
        payload: { ...businessBody, reportingTimezone: 'UTC' },
      });
      assert.equal(reusedKey.statusCode, 409);
      const createConcurrentBusiness = (cookie: string, key: string) => app.inject({
        method: 'POST',
        url: '/api/partner/businesses',
        headers: {
          host: 'alpha.agency.example',
          origin: config.partner_app_base_url,
          cookie,
          'idempotency-key': key,
        },
        payload: { name: 'Concurrent Studio', reportingTimezone: 'UTC' },
      });
      const [concurrentA, concurrentB] = await Promise.all([
        createConcurrentBusiness(partnerCookie, 'fixture-concurrent-request-a'),
        createConcurrentBusiness(emptyPartnerCookie, 'fixture-concurrent-request-b'),
      ]);
      assert.equal(concurrentA.statusCode, 201, concurrentA.body);
      assert.equal(concurrentB.statusCode, 201, concurrentB.body);
      assert.notEqual(concurrentA.json().business.id, concurrentB.json().business.id);
      assert.notEqual(concurrentA.json().business.slug, concurrentB.json().business.slug);
      const ownerBusinessList = await call(
        'GET',
        '/api/partner/businesses',
        undefined,
        partnerCookie,
      );
      assert.equal(ownerBusinessList.statusCode, 200, ownerBusinessList.body);
      assert.equal(ownerBusinessList.json().businesses.length, 3);
      const otherOwnerBusiness = await call(
        'GET',
        `/api/partner/businesses/${encodeURIComponent(createdBusinessId)}`,
        undefined,
        emptyPartnerCookie,
      );
      assert.equal(otherOwnerBusiness.statusCode, 404);
      const spoofedWorkspaceClients = await app.inject({
        method: 'GET',
        url: '/api/clients',
        headers: {
          host: `${concurrentA.json().business.slug}.agency.example`,
          'x-kasitek-tenant-slug': concurrentA.json().business.slug,
          cookie: emptyPartnerCookie,
        },
      });
      assert.equal(spoofedWorkspaceClients.statusCode, 401);
      const spoofedWorkspaceStaff = await app.inject({
        method: 'POST',
        url: '/api/workspace/staff',
        headers: {
          host: `${concurrentA.json().business.slug}.agency.example`,
          'x-kasitek-tenant-slug': concurrentA.json().business.slug,
          origin: config.partner_app_base_url,
          cookie: emptyPartnerCookie,
        },
        payload: { email: 'spoofed@example.test', name: 'Spoofed', role: 'admin' },
      });
      assert.equal(spoofedWorkspaceStaff.statusCode, 401);
      const concurrentCount = await pool.query(
        "SELECT COUNT(*) AS count FROM workspaces WHERE slug LIKE 'concurrent-studio%'",
      );
      assert.equal(Number(concurrentCount.rows[0].count), 2);
      const ownerCredentials = await pool.query(
        `SELECT u.password_hash FROM agency_partner_memberships m
         JOIN tenant_users u ON u.id=m.tenant_user_id WHERE m.workspace_id=$1`,
        [createdBusinessId],
      );
      assert.equal(ownerCredentials.rowCount, 1);
      assert.equal(ownerCredentials.rows[0].password_hash, null);
      assert.equal(
        Number((await pool.query(
          'SELECT COUNT(*) AS count FROM agency_partner_business_requests WHERE workspace_id=$1',
          [createdBusinessId],
        )).rows[0].count),
        1,
      );
      const malformed = await call('POST', '/api/auth/login', {
        email: 42,
        password: 'fixture password',
      });
      assert.equal(malformed.statusCode, 400);
      assert.match(malformed.headers['content-type']!, /text\/plain/);
      assert.equal(
        (
          await call('POST', '/api/auth/accept-admin-invite', {
            token: 'fixture',
            password: 'fixture',
            name: 42,
          })
        ).statusCode,
        400,
      );
      const login = await call('POST', '/api/auth/session/login', {
        email: ' STAFF@EXAMPLE.TEST ',
        password: ' fixture password ',
      });
      assert.equal(login.statusCode, 200, login.body);
      assert.equal(login.json().audience, 'tenant');
      assert.deepEqual(login.json().user.roles, ['admin', 'staff']);
      const staffCookie = login.cookies.find(
        (c) => c.name === config.session_cookie_name,
      )!;
      assert.ok(staffCookie.httpOnly);
      assert.equal(staffCookie.sameSite, 'Lax');
      const staffHeader = `${staffCookie.name}=${staffCookie.value}`;
      await pool.query(
        `INSERT INTO tenant_users(id,workspace_id,email,status) VALUES ('owner-b','a','second-owner@example.test','active');
         INSERT INTO tenant_user_roles(tenant_user_id,role) VALUES ('owner-b','owner')`,
      );
      const removePrimaryPartner = await app.inject({
        method: 'DELETE',
        url: '/api/workspace/staff/owner-a',
        headers: { host: 'alpha.agency.example', cookie: staffHeader },
      });
      assert.equal(removePrimaryPartner.statusCode, 400);
      const removeOtherOwner = await app.inject({
        method: 'DELETE',
        url: '/api/workspace/staff/owner-b',
        headers: { host: 'alpha.agency.example', cookie: staffHeader },
      });
      assert.equal(removeOtherOwner.statusCode, 400);
      assert.equal(
        Number((await pool.query("SELECT COUNT(*) AS count FROM tenant_users WHERE id IN ('owner-a','owner-b')")).rows[0].count),
        2,
      );
      assert.equal(
        (await call('GET', '/api/auth/me', undefined, staffHeader)).json().user
          .id,
        'staff-a',
      );
      assert.equal(
        (
          await call(
            'GET',
            '/api/auth/me',
            undefined,
            staffHeader,
            'beta.agency.example',
          )
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await call(
            'GET',
            '/api/auth/me',
            undefined,
            staffHeader,
            'custom.example',
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await call(
            'GET',
            '/api/auth/me',
            undefined,
            staffHeader,
            'unknown.example',
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT token_hash FROM tenant_sessions WHERE tenant_user_id=$1',
            ['staff-a'],
          )
        ).rows[0].token_hash,
        tokenHash(staffCookie.value),
      );
      const token = newToken();
      await pool.query(
        "INSERT INTO workspace_api_keys(id,workspace_id,label,key_prefix,key_hash,scopes) VALUES ('key','b','fixture','fixture',$1,'[\"tenant:read\",4]')",
        [tokenHash(token)],
      );
      const keyed = await app.inject({
        method: 'GET',
        url: '/fixture/access',
        headers: {
          host: 'alpha.agency.example',
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(keyed.json().workspace_id, 'b');
      assert.deepEqual(keyed.json().scopes, ['tenant:read']);
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: '/fixture/access',
            headers: {
              host: 'alpha.agency.example',
              authorization: `Bearer ${token}`,
              cookie: `${config.session_cookie_name}=`,
            },
          })
        ).statusCode,
        401,
      );
      const client = await call(
        'POST',
        '/api/auth/session/login',
        { email: 'customer@example.test', password: 'fixture password' },
        staffHeader,
      );
      assert.equal(client.statusCode, 200, client.body);
      assert.equal(client.json().audience, 'client');
      assert.equal(
        client.cookies.find((c) => c.name === config.session_cookie_name)!
          .value,
        '',
      );
      const cCookie = client.cookies.find(
          (c) => c.name === config.client_session_cookie_name,
        )!,
        clientHeader = `${cCookie.name}=${cCookie.value}`;
      assert.equal(
        (await call('GET', '/api/auth/me', undefined, clientHeader)).statusCode,
        401,
      );
      assert.equal(
        (
          await call('GET', '/api/client-auth/me', undefined, clientHeader)
        ).json().clientUser.tenantClientId,
        'client-a',
      );
      assert.equal(
        (
          await call(
            'GET',
            '/api/client-auth/me',
            undefined,
            clientHeader,
            'beta.agency.example',
          )
        ).statusCode,
        401,
      );
      await assert.rejects(
        () => requireActiveTenantClient(pool, 'a', 'client-b'),
        /not found/,
      );
      await assert.rejects(
        () => requireClientScopedConversation(pool, 'a', 'client-b', 'absent'),
        /conversation not found/,
      );
      await pool.query(
        "INSERT INTO conversations(id,workspace_id,tenant_client_id,channel,customer_identifier) VALUES ('own-conversation','a','client-a','website','own'),('sibling-conversation','a','sibling-client','website','sibling')",
      );
      await requireClientScopedConversation(
        pool,
        'a',
        'client-a',
        'own-conversation',
      );
      await assert.rejects(
        () =>
          requireClientScopedConversation(
            pool,
            'a',
            'client-a',
            'sibling-conversation',
          ),
        /conversation not found/,
      );
      const invitation = await issueClientInvite(
        context,
        'a',
        'alpha',
        'client-a',
        'invite-customer',
        'invite@example.test',
        null,
      );
      assert.equal(invitation.email_sent, false);
      const inviteToken = new URL(invitation.activation_url!).searchParams.get(
        'token',
      )!;
      assert.equal(
        (
          await call(
            'GET',
            `/api/client-auth/invite?token=${inviteToken}`,
            undefined,
            '',
            'beta.agency.example',
          )
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await call('GET', `/api/client-auth/invite?token=${inviteToken}`)
        ).json().invite.isValid,
        true,
      );
      const accepted = await call('POST', '/api/client-auth/accept-invite', {
        token: inviteToken,
        password: 'x',
        name: ' Fixture Client ',
      });
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.equal(accepted.json().clientUser.name, 'Fixture Client');
      assert.equal(
        (
          await call('POST', '/api/client-auth/accept-invite', {
            token: inviteToken,
            password: 'x',
          })
        ).statusCode,
        401,
      );
      await pool.query(
        "INSERT INTO tenant_client_users(id,workspace_id,tenant_client_id,email,password_hash,status) VALUES ('revoked-client','a','client-a','revoked@example.test',NULL,'invited')",
      );
      await pool.query(
        "INSERT INTO tenant_client_user_roles(tenant_client_user_id,role) VALUES ('revoked-client','client')",
      );
      const replacedInvite = await issueClientInvite(
        context,
        'a',
        'alpha',
        'client-a',
        'revoked-client',
        'revoked@example.test',
        null,
      );
      const replacedToken = new URL(
        replacedInvite.activation_url!,
      ).searchParams.get('token')!;
      await issueClientInvite(
        context,
        'a',
        'alpha',
        'client-a',
        'revoked-client',
        'revoked@example.test',
        null,
      );
      assert.equal(
        (
          await call('GET', `/api/client-auth/invite?token=${replacedToken}`)
        ).json().invite.isValid,
        false,
      );
      assert.equal(
        (
          await call('POST', '/api/client-auth/accept-invite', {
            token: replacedToken,
            password: 'x',
          })
        ).statusCode,
        401,
      );
      const setup = await call('POST', '/api/auth/session/continue', {
        email: 'setup@example.test',
      });
      assert.equal(setup.json().nextStep, 'setup_link_sent');
      const adminToken = new URL(setup.json().activationUrl).searchParams.get(
        'token',
      )!;
      assert.equal(
        (
          await call('POST', '/api/auth/accept-admin-invite', {
            token: adminToken,
            password: 'short',
          })
        ).statusCode,
        400,
      );
      const adminAccepted = await call(
        'POST',
        '/api/auth/accept-admin-invite',
        { token: adminToken, password: 'long enough', name: 'Fixture Admin' },
      );
      assert.equal(adminAccepted.statusCode, 200, adminAccepted.body);
      assert.equal(adminAccepted.json().user.name, 'Fixture Admin');
      assert.equal(
        (
          await call('POST', '/api/auth/accept-admin-invite', {
            token: adminToken,
            password: 'long enough',
          })
        ).statusCode,
        400,
      );
      const rollbackInvite = await issueAdminInvite(
        context,
        'a',
        'alpha',
        'Agency A',
        'setup-a',
        'setup@example.test',
      );
      const rollbackToken = new URL(
        rollbackInvite.activation_url!,
      ).searchParams.get('token')!;
      await pool.query(`CREATE FUNCTION fixture_fail_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
       CREATE TRIGGER fixture_fail BEFORE INSERT ON tenant_sessions FOR EACH ROW EXECUTE FUNCTION fixture_fail_session()`);
      const failedActivation = await call(
        'POST',
        '/api/auth/accept-admin-invite',
        {
          token: rollbackToken,
          password: 'rollback password',
          name: 'Rollback name',
        },
      );
      assert.equal(failedActivation.statusCode, 500);
      assert.equal(failedActivation.json().error, 'database error');
      assert.equal(
        (
          await pool.query(
            'SELECT accepted_at FROM tenant_user_invites WHERE token_hash=$1',
            [tokenHash(rollbackToken)],
          )
        ).rows[0].accepted_at,
        null,
      );
      assert.equal(
        (await pool.query("SELECT name FROM tenant_users WHERE id='setup-a'"))
          .rows[0].name,
        'Fixture Admin',
      );
      await pool.query(
        'DROP TRIGGER fixture_fail ON tenant_sessions;DROP FUNCTION fixture_fail_session()',
      );
      const expired = await issueAdminInvite(
        context,
        'a',
        'alpha',
        'Agency A',
        'setup-a',
        'setup@example.test',
      );
      const expiredToken = new URL(expired.activation_url!).searchParams.get(
        'token',
      )!;
      await pool.query(
        "UPDATE tenant_user_invites SET expires_at=NOW()-interval '1 second' WHERE token_hash=$1",
        [tokenHash(expiredToken)],
      );
      assert.equal(
        (
          await call('GET', `/api/auth/admin-invite?token=${expiredToken}`)
        ).json().invite.isValid,
        false,
      );
      await pool.query(
        "UPDATE tenant_users SET status='disabled' WHERE id='staff-a'",
      );
      assert.equal(
        (await call('GET', '/api/auth/me', undefined, staffHeader)).statusCode,
        401,
      );
      await pool.query(
        "UPDATE tenant_client_sessions SET expires_at=NOW()-interval '1 second' WHERE token_hash=$1",
        [tokenHash(cCookie.value)],
      );
      assert.equal(
        (await call('GET', '/api/client-auth/me', undefined, clientHeader))
          .statusCode,
        401,
      );
      assert.equal(
        (
          await call(
            'POST',
            '/api/auth/session/logout',
            {},
            `${staffHeader}; ${clientHeader}`,
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*) FROM tenant_sessions WHERE token_hash=$1',
            [tokenHash(staffCookie.value)],
          )
        ).rows[0].count,
        '0',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*) FROM tenant_client_sessions WHERE token_hash=$1',
            [tokenHash(cCookie.value)],
          )
        ).rows[0].count,
        '0',
      );

      const oidcKeys = await generateKeyPair('RS256', { modulusLength: 2048 });
      const oidcJwk = await exportJWK(oidcKeys.publicKey);
      Object.assign(oidcJwk, { kid: 'agency-test-key', alg: 'RS256', use: 'sig' });
      let signedIdToken = '';
      let observedTokenForm = '';
      let adminLogoutPath = '';
      let adminTokenAuthorization = '';
      let adminLogoutAuthorization = '';
      const oidcServer = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
        response.setHeader('content-type', 'application/json');
        if (url.pathname === '/.well-known/openid-configuration') {
          response.end(JSON.stringify({
            issuer: oidcIssuer,
            authorization_endpoint: `${oidcIssuer}/authorize`,
            token_endpoint: `${oidcIssuer}/token`,
            jwks_uri: `${oidcIssuer}/jwks`,
            end_session_endpoint: `${oidcIssuer}/logout`,
          }));
        } else if (url.pathname === '/jwks') {
          response.end(JSON.stringify({ keys: [oidcJwk] }));
        } else if (url.pathname === '/token') {
          let body = '';
          for await (const part of request) body += part;
          observedTokenForm = body;
          const form = new URLSearchParams(body);
          if (form.get('grant_type') === 'client_credentials') {
            adminTokenAuthorization = String(request.headers.authorization ?? '');
            response.end(JSON.stringify({ access_token: 'fixture-admin-access-token' }));
          } else {
            response.end(JSON.stringify({ id_token: signedIdToken }));
          }
        } else if (url.pathname.startsWith('/admin/realms/kasitek/users/')) {
          adminLogoutPath = url.pathname;
          adminLogoutAuthorization = String(request.headers.authorization ?? '');
          response.statusCode = 204;
          response.end();
        } else {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'not found' }));
        }
      });
      oidcServer.listen(0, '127.0.0.1');
      await once(oidcServer, 'listening');
      const oidcAddress = oidcServer.address();
      assert.ok(oidcAddress && typeof oidcAddress === 'object');
      const oidcIssuer = `http://127.0.0.1:${oidcAddress.port}`;
      context.config.partner_oidc_issuer_url = oidcIssuer;
      context.config.partner_oidc_client_id = 'agency-partner-test';
      context.config.partner_oidc_client_secret = 'test-only-client-secret';
      context.config.partner_oidc_admin_client_id = 'agency-partner-session-admin-test';
      context.config.partner_oidc_admin_client_secret = 'test-only-session-admin-secret';
      context.config.partner_oidc_redirect_uri = 'http://localhost:3010/api/tenant/api/partner/auth/callback';
      context.config.partner_app_base_url = 'http://localhost:3010';
      context.config.session_cookie_secure = true;
      try {
        const start = await app.inject({
          method: 'GET',
          url: '/api/partner/auth/start?intent=register&returnTo=https%3A%2F%2Fevil.example',
          headers: { host: 'localhost:3010' },
        });
        assert.equal(start.statusCode, 302, start.body);
        const authorizeUrl = new URL(start.headers.location!);
        assert.equal(authorizeUrl.searchParams.get('prompt'), 'create');
        assert.equal(authorizeUrl.searchParams.has('kc_action'), false);
        assert.equal(authorizeUrl.searchParams.get('client_id'), 'agency-partner-test');
        assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
        const flowState = authorizeUrl.searchParams.get('state')!;
        const flowNonce = authorizeUrl.searchParams.get('nonce')!;
        const flowCookie = start.cookies.find((c) => c.name === 'kasitek.agency.login-flow')!;
        const flow = (await pool.query(
          'SELECT code_verifier,return_path FROM agency_partner_auth_flows WHERE state_hash=$1',
          [tokenHash(flowState)],
        )).rows[0];
        assert.equal(flow.return_path, '/app/businesses');
        assert.equal(
          authorizeUrl.searchParams.get('code_challenge'),
          createHash('sha256').update(flow.code_verifier).digest('base64url'),
        );
        signedIdToken = await new SignJWT({
          email: 'partner-oidc@example.test',
          email_verified: true,
          name: 'OIDC Test Partner',
          nonce: flowNonce,
          sid: 'provider-session-test',
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'agency-test-key' })
          .setIssuer(oidcIssuer)
          .setAudience('agency-partner-test')
          .setSubject('provider-subject-test')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(oidcKeys.privateKey);
        const callback = await app.inject({
          method: 'GET',
          url: `/api/partner/auth/callback?code=authorization-code-test&state=${encodeURIComponent(flowState)}`,
          headers: {
            host: 'localhost:3010',
            cookie: `kasitek.agency.login-flow=${flowCookie.value}`,
          },
        });
        assert.equal(callback.statusCode, 302, callback.body);
        assert.equal(callback.headers.location, 'http://localhost:3010/onboarding');
        const exchanged = new URLSearchParams(observedTokenForm);
        assert.equal(exchanged.get('grant_type'), 'authorization_code');
        assert.equal(exchanged.get('code_verifier'), flow.code_verifier);
        const partnerCookie = callback.cookies.find((c) => c.name === config.partner_session_cookie_name)!;
        assert.ok(partnerCookie.value);
        assert.ok(partnerCookie.httpOnly);
        assert.equal(partnerCookie.secure, true);
        assert.equal(partnerCookie.sameSite, 'Lax');
        assert.equal(partnerCookie.domain, undefined);
        assert.equal(
          (await call('GET', '/api/partner/auth/me', undefined, `${partnerCookie.name}=${partnerCookie.value}`)).json().partner.email,
          'partner-oidc@example.test',
        );
        const replay = await app.inject({
          method: 'GET',
          url: `/api/partner/auth/callback?code=authorization-code-test&state=${encodeURIComponent(flowState)}`,
          headers: { host: 'localhost:3010', cookie: `kasitek.agency.login-flow=${flowCookie.value}` },
        });
        assert.equal(replay.statusCode, 401);

        const unverifiedStart = await app.inject({
          method: 'GET',
          url: '/api/partner/auth/start?intent=register',
          headers: { host: 'localhost:3010' },
        });
        const unverifiedAuthorize = new URL(unverifiedStart.headers.location!);
        const unverifiedState = unverifiedAuthorize.searchParams.get('state')!;
        const unverifiedFlowCookie = unverifiedStart.cookies.find((c) => c.name === 'kasitek.agency.login-flow')!;
        const unverifiedFlow = (await pool.query(
          'SELECT nonce FROM agency_partner_auth_flows WHERE state_hash=$1',
          [tokenHash(unverifiedState)],
        )).rows[0];
        signedIdToken = await new SignJWT({
          email: 'unverified@example.test',
          email_verified: false,
          nonce: unverifiedFlow.nonce,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'agency-test-key' })
          .setIssuer(oidcIssuer)
          .setAudience('agency-partner-test')
          .setSubject('unverified-provider-subject')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(oidcKeys.privateKey);
        const unverifiedCallback = await app.inject({
          method: 'GET',
          url: `/api/partner/auth/callback?code=unverified-code&state=${encodeURIComponent(unverifiedState)}`,
          headers: {
            host: 'localhost:3010',
            cookie: `kasitek.agency.login-flow=${unverifiedFlowCookie.value}`,
          },
        });
        assert.equal(unverifiedCallback.statusCode, 403);
        assert.equal(
          Number((await pool.query("SELECT COUNT(*) AS count FROM agency_partners WHERE subject='unverified-provider-subject'")).rows[0].count),
          0,
        );

        const logout = await app.inject({
          method: 'POST',
          url: '/api/partner/auth/logout',
          headers: {
            host: 'localhost:3010',
            origin: context.config.partner_app_base_url,
            cookie: `${partnerCookie.name}=${partnerCookie.value}`,
          },
        });
        assert.equal(logout.statusCode, 200, logout.body);
        const logoutDestination = new URL(logout.json().logoutUrl);
        assert.equal(logoutDestination.pathname, '/logout');
        assert.equal(logoutDestination.searchParams.get('client_id'), 'agency-partner-test');
        assert.equal(logoutDestination.searchParams.get('post_logout_redirect_uri'), 'http://localhost:3010/login?audience=partner');
        assert.equal(
          (await call('GET', '/api/partner/auth/me', undefined, `${partnerCookie.name}=${partnerCookie.value}`)).statusCode,
          401,
        );

        const oidcPartner = (await pool.query(
          "SELECT id FROM agency_partners WHERE issuer=$1 AND subject='provider-subject-test'",
          [oidcIssuer],
        )).rows[0];
        const logoutAllToken = newToken();
        await pool.query(
          `INSERT INTO agency_partner_sessions(id,partner_id,token_hash,provider_sid,expires_at,last_used_at)
           VALUES('partner-session-logout-all',$1,$2,'provider-session-test',NOW()+INTERVAL '30 days',NOW())`,
          [oidcPartner.id, tokenHash(logoutAllToken)],
        );
        const logoutAll = await app.inject({
          method: 'POST',
          url: '/api/partner/auth/logout-all',
          headers: {
            host: 'localhost:3010',
            origin: context.config.partner_app_base_url,
            cookie: `${config.partner_session_cookie_name}=${logoutAllToken}`,
          },
        });
        assert.equal(logoutAll.statusCode, 200, logoutAll.body);
        assert.equal(logoutAll.json().logoutUrl, 'http://localhost:3010/login?audience=partner');
        assert.equal(adminTokenAuthorization, `Basic ${Buffer.from('agency-partner-session-admin-test:test-only-session-admin-secret').toString('base64')}`);
        assert.equal(adminLogoutPath, '/admin/realms/kasitek/users/provider-subject-test/logout');
        assert.equal(adminLogoutAuthorization, 'Bearer fixture-admin-access-token');
        assert.ok((await pool.query(
          "SELECT revoked_at FROM agency_partner_sessions WHERE id='partner-session-logout-all'",
        )).rows[0].revoked_at);

        const backchannelToken = newToken();
        await pool.query(
          `INSERT INTO agency_partner_sessions(id,partner_id,token_hash,provider_sid,expires_at,last_used_at)
           VALUES('partner-session-backchannel',$1,$2,'provider-session-backchannel',NOW()+INTERVAL '30 days',NOW())`,
          [oidcPartner.id, tokenHash(backchannelToken)],
        );
        const logoutEvent = 'http://schemas.openid.net/event/backchannel-logout';
        const logoutJwt = await new SignJWT({
          events: { [logoutEvent]: {} },
          sid: 'provider-session-backchannel',
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'agency-test-key', typ: 'logout+jwt' })
          .setIssuer(oidcIssuer)
          .setAudience('agency-partner-test')
          .setSubject('provider-subject-test')
          .setJti('agency-backchannel-test-jti')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(oidcKeys.privateKey);
        const backchannel = await app.inject({
          method: 'POST',
          url: '/api/partner/auth/backchannel-logout',
          payload: { logout_token: logoutJwt },
        });
        assert.equal(backchannel.statusCode, 204, backchannel.body);
        assert.ok((await pool.query(
          "SELECT revoked_at FROM agency_partner_sessions WHERE id='partner-session-backchannel'",
        )).rows[0].revoked_at);
      } finally {
        await new Promise<void>((resolve, reject) => {
          oidcServer.close((error) => error ? reject(error) : resolve());
        });
      }
    } finally {
      await app.close();
      await pool.end();
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  },
);
test('Agency Resend domain/mail adapters retain provider status, sender and invitation content without real delivery', async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    if (text) bodies.push(JSON.parse(text));
    res.setHeader('content-type', 'application/json');
    if (req.url === '/domains')
      return res.end(
        JSON.stringify({
          data: {
            id: 'fixture-domain',
            name: 'mail.example.test',
            status: 'verified',
            verified_at: '2026-10-02T18:20:30.123456Z',
            records: [
              {
                record: 'SPF',
                type: 'TXT',
                name: 'send',
                value: 'fixture',
                status: 'verified',
              },
            ],
          },
        }),
      );
    res.writeHead(req.headers['x-unused'] ? 500 : 201);
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = readConfig({
    TENANT_DATABASE_URL: 'postgres://fixture',
    TENANT_RESEND_API_KEY: 'synthetic',
    TENANT_RESEND_FROM_EMAIL: 'Fixture <fixture@example.test>',
    TENANT_APP_BASE_URL: 'http://localhost:3001',
  });
  const context = { pool: {} as pg.Pool, config },
    options = {
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    };
  try {
    assert.equal(workspacePortalUrl(context, 'a'), 'http://localhost:3001');
    const domain = await createResendDomain(
      context,
      'mail.example.test',
      options,
    );
    assert.equal(domain.provider_domain_id, 'fixture-domain');
    assert.ok(domain.verified_at);
    assert.equal(
      domain.verified_at!.toISOString(),
      '2026-10-02T18:20:30.123456Z',
    );
    assert.equal(domain.records[0]!.record_type, 'TXT');
    assert.deepEqual(bodies[0], {
      name: 'mail.example.test',
      region: 'eu-west-1',
    });
    await sendTenantAdminInviteEmail(
      context,
      'target@example.test',
      'Fixture Agency',
      'https://fixture/setup?token=synthetic',
      null,
      new Date('2026-10-03T10:00:00Z'),
      options,
    );
    assert.match(String(bodies[1]!.text), /2026-10-03 10:00 UTC/);
    assert.match(String(bodies[1]!.html), /complete portal setup/);
    await sendEmail(
      context,
      {
        sending_mode: 'shared',
        sender_name: 'Fixture',
        from_email: 'from@example.test',
        reply_to_email: null,
        domain_status: 'shared',
        active_domain_id: null,
        active_domain: null,
      },
      ['target@example.test'],
      'Fixture',
      'text',
      'html',
      options,
    );
    assert.equal(bodies[2]!.reply_to, null);
    await assert.rejects(
      () =>
        createResendDomain(context, 'fixture', {
          fetch: async () =>
            new Response('{"message":"provider denied"}', { status: 422 }),
        }),
      /bad request: provider denied/,
    );
    await assert.rejects(
      () =>
        sendEmail(
          context,
          {
            sending_mode: 'shared',
            sender_name: 'Fixture',
            from_email: 'from@example.test',
            reply_to_email: null,
            domain_status: 'shared',
            active_domain_id: null,
            active_domain: null,
          },
          [],
          '',
          '',
          '',
          { fetch: async () => new Response('{}', { status: 202 }) },
        ),
      /Failed to send email/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
