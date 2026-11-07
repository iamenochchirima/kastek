import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import type { CoreContext } from '../src/context.js';
import { registerAuthRoutes } from '../src/routes/auth.js';
import { registerSocialRoutes } from '../src/routes/social.js';
import { registerSocialOAuthRoutes } from '../src/routes/social-oauth.js';
import { registerNotificationRoutes } from '../src/routes/notifications.js';
import { registerBillingRoutes } from '../src/routes/billing.js';
import { registerEmailRoutes } from '../src/routes/email.js';
import { registerConnectionRoutes } from '../src/routes/connections.js';
import { registerAdminAnalyticsRoutes } from '../src/routes/admin-analytics.js';
import { registerEarlyAccessRoutes } from '../src/routes/early-access.js';
import { registerWhatsappMarketingRoutes } from '../src/routes/whatsapp.js';
import { registerPublicV1Routes } from '../src/routes/public-v1.js';
import { registerAdminOperationsRoutes } from '../src/routes/admin-operations.js';
import { stringQueryMap } from '../src/typed-query.js';

test('typed queries preserve Actix extractor errors before route effects', async () => {
  const mapped = stringQueryMap({ duplicate: ['old', 'new'], only: 'value' });
  assert.equal(mapped.duplicate, 'new');
  assert.equal(mapped.only, 'value');
  const config = readConfig({
      DATABASE_URL: 'postgres://unused',
      FRONTEND_URL: 'http://localhost:3000',
      LOG_LEVEL: 'silent',
    }),
    context = {
      config,
      pool: {
        query: () => {
          throw new Error('query extraction must run before database access');
        },
      },
    } as unknown as CoreContext,
    oauthApp = await buildApp(context, [
      registerAuthRoutes,
      registerSocialOAuthRoutes,
      registerEmailRoutes,
      (instance, core) => registerConnectionRoutes(instance, core),
    ]);

  try {
    for (const [url, field] of [
      ['/api/auth/login?returnTo=%2F&returnTo=%2Felsewhere', 'returnTo'],
      ['/api/auth/login?screen=login&screen=signup', 'screen'],
      ['/api/auth/callback?state=first&state=second', 'state'],
      ['/api/auth/callback?error=denied&error=other', 'error'],
      [
        '/api/email/oauth/google/start?returnTo=%2F&returnTo=%2Fagain',
        'returnTo',
      ],
      ['/api/email/oauth/google/callback?state=first&state=second', 'state'],
      [
        '/api/connections/synthetic/access/request?capabilities=read&capabilities=write',
        'capabilities',
      ],
      [
        '/api/email/oauth/google/callback?error_description=first&error_description=second',
        'error_description',
      ],
      [
        '/api/social/oauth/x/start?connectionId=first&connectionId=second',
        'connectionId',
      ],
      ['/api/social/oauth/meta/callback?state=first&state=second', 'state'],
      [
        '/api/social/oauth/bluesky/start?handle=first&handle=second',
        'handle',
      ],
      ['/api/social/oauth/bluesky/callback?iss=first&iss=second', 'iss'],
    ] as const) {
      const response = await oauthApp.inject({ url });
      assert.equal(response.statusCode, 400);
      assert.equal(
        response.headers['content-type'],
        'text/plain; charset=utf-8',
      );
      assert.equal(
        response.body,
        'Query deserialize error: duplicate field `' + field + '`',
      );
    }
  } finally {
    await oauthApp.close();
  }

  const socialApp = await buildApp(context, [
    (instance, core) => registerSocialRoutes(instance, core),
  ]);
  try {
    for (const [query, detail] of [
      ['', 'missing field `expires`'],
      ['?expires=1', 'missing field `signature`'],
      ['?expires=invalid&signature=value', 'invalid digit found in string'],
      [
        '?expires=9223372036854775808&signature=value',
        'number too large to fit in target type',
      ],
    ] as const) {
      const response = await socialApp.inject({
        url: `/api/social/media/synthetic/public${query}`,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(
        response.body,
        `Query deserialize error: ${detail}`,
      );
    }

    for (const [query, detail] of [
      [
        '?metrics=likes&metrics=comments',
        'duplicate field `metrics`',
      ],
      [
        '?publishedFrom=2026-01-01&published_from=2026-01-02',
        'duplicate field `publishedFrom`',
      ],
      ['?limit=invalid', 'invalid digit found in string'],
      [
        '?limit=9223372036854775808',
        'number too large to fit in target type',
      ],
    ] as const) {
      const response = await socialApp.inject({
        url: `/api/social/posts/insights${query}`,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(
        response.body,
        `Query deserialize error: ${detail}`,
      );
    }
  } finally {
    await socialApp.close();
  }

  const notificationApp = await buildApp(context, [
    (instance, core) => registerNotificationRoutes(instance, core),
  ]);
  try {
    for (const [query, detail] of [
      ['?limit=invalid', 'invalid digit found in string'],
      [
        '?limit=9223372036854775808',
        'number too large to fit in target type',
      ],
      ['?cursor=first&cursor=second', 'duplicate field `cursor`'],
    ] as const) {
      const response = await notificationApp.inject({
        url: `/api/notifications${query}`,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(
        response.body,
        `Query deserialize error: ${detail}`,
      );
    }
  } finally {
    await notificationApp.close();
  }

  const billingApp = await buildApp(context, [
    (instance, core) => registerBillingRoutes(instance, core),
  ]);
  try {
    const response = await billingApp.inject({
      url: '/api/billing/usage?range=7d&range=90d',
    });
    assert.equal(response.statusCode, 400);
    assert.equal(
      response.body,
      'Query deserialize error: duplicate field `range`',
    );
  } finally {
    await billingApp.close();
  }

  const adminQueryApp = await buildApp(context, [
    async (instance, core) => {
      await registerAdminAnalyticsRoutes(instance, core);
      await registerEarlyAccessRoutes(instance, core);
    },
  ]);
  try {
    for (const [url, detail] of [
      [
        '/api/admin/analytics/overview?days=7&days=30',
        'duplicate field `days`',
      ],
      [
        '/api/admin/activity?organizationId=one&organizationId=two',
        'duplicate field `organizationId`',
      ],
      ['/api/admin/activity/stream?limit=invalid', 'invalid digit found in string'],
      ['/api/admin/reports/export', 'missing field `report`'],
      ['/api/admin/early-access?status=new&status=active', 'duplicate field `status`'],
      ['/api/admin/early-access?limit=invalid', 'invalid digit found in string'],
      [
        '/api/admin/reports/export?report=usage&days=9223372036854775808',
        'number too large to fit in target type',
      ],
    ] as const) {
      const response = await adminQueryApp.inject({ url });
      assert.equal(response.statusCode, 400);
      assert.equal(response.body, `Query deserialize error: ${detail}`);
    }
  } finally {
    await adminQueryApp.close();
  }

  const adminOperationsApp = await buildApp(context, [
    (instance, core) => registerAdminOperationsRoutes(instance, core),
  ]);
  try {
    for (const [url, detail] of [
      [
        '/api/admin/operations/webhooks/deliveries?limit=1&limit=2',
        'duplicate field `limit`',
      ],
      [
        '/api/admin/operations/webhooks/deliveries?limit=4294967296',
        'number too large to fit in target type',
      ],
      [
        '/api/admin/operations/support-grants?organizationId=first&organizationId=second',
        'duplicate field `organizationId`',
      ],
      [
        '/api/admin/conversations?organizationId=a&organizationId=b',
        'duplicate field `organizationId`',
      ],
      [
        '/api/admin/outreach/campaign/leads?emailStatus=sent&emailStatus=failed',
        'duplicate field `emailStatus`',
      ],
      [
        '/api/admin/outreach/delivery?limit=9223372036854775808',
        'number too large to fit in target type',
      ],
      [
        '/api/admin/notifications?unreadOnly=true&unreadOnly=false',
        'duplicate field `unreadOnly`',
      ],
      [
        '/api/admin/notifications?unreadOnly=yes',
        'provided string was not `true` or `false`',
      ],
      [
        '/api/admin/notifications?limit=9223372036854775808',
        'number too large to fit in target type',
      ],
    ] as const) {
      const response = await adminOperationsApp.inject({ url });
      assert.equal(response.statusCode, 400);
      assert.equal(
        response.headers['content-type'],
        'text/plain; charset=utf-8',
      );
      assert.equal(response.body, `Query deserialize error: ${detail}`);
    }
  } finally {
    await adminOperationsApp.close();
  }

  const whatsappQueryApp = await buildApp(context, [
    (instance, core) => registerWhatsappMarketingRoutes(instance, core),
  ]);
  try {
    for (const [url, detail] of [
      [
        '/api/whatsapp/contacts?limit=10&limit=20',
        'duplicate field `limit`',
      ],
      ['/api/whatsapp/contacts?cursor=-1', 'invalid digit found in string'],
      [
        '/api/whatsapp/contacts?cursor=18446744073709551616',
        'number too large to fit in target type',
      ],
      [
        '/api/whatsapp/templates?status=approved&status=pending',
        'duplicate field `status`',
      ],
    ] as const) {
      const response = await whatsappQueryApp.inject({ url });
      assert.equal(response.statusCode, 400);
      assert.equal(response.body, `Query deserialize error: ${detail}`);
    }
  } finally {
    await whatsappQueryApp.close();
  }

  const publicApiApp = await buildApp(context, [
    (instance, core) => registerPublicV1Routes(instance, core, {} as never),
  ]);
  try {
    for (const [url, detail] of [
      ['/v1/content/posts?cursor=1&cursor=2', 'duplicate field `cursor`'],
      ['/v1/contacts?limit=1&limit=2', 'duplicate field `limit`'],
      ['/v1/templates?status=one&status=two', 'duplicate field `status`'],
      [
        '/v1/webhooks/subscriptions?limit=invalid',
        'invalid digit found in string',
      ],
      [
        '/v1/capabilities?cursor=18446744073709551616',
        'number too large to fit in target type',
      ],
    ] as const) {
      const response = await publicApiApp.inject({ url });
      assert.equal(response.statusCode, 400);
      assert.equal(response.body, `Query deserialize error: ${detail}`);
    }
  } finally {
    await publicApiApp.close();
  }

});
