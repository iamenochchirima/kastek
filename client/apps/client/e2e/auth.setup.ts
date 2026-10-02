import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const email = process.env.ANALYTICS_PLAYWRIGHT_EMAIL;
const password = process.env.ANALYTICS_PLAYWRIGHT_PASSWORD;
const storageStatePath = resolve(
  process.cwd(),
  process.env.ANALYTICS_PLAYWRIGHT_STORAGE_STATE ??
    '.playwright/.auth/user.json',
);

test('creates a reusable Core session for analytics browser tests', async ({
  page,
  baseURL,
}) => {
  test.skip(
    !email || !password,
    'Set ANALYTICS_PLAYWRIGHT_EMAIL and ANALYTICS_PLAYWRIGHT_PASSWORD',
  );

  // Follow the same browser-bound OIDC redirect as the product login button.
  // Credentials are entered on the self-hosted provider, never sent to Core.
  await page.goto('/api/auth/login?returnTo=/analytics', {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('input[name="username"]').fill(email!);
  await page.locator('input[name="password"]').fill(password!);
  await page.locator('input[name="login"], button[name="login"]').click();
  await page.waitForURL((url) => url.origin === new URL(baseURL!).origin);
  expect(new URL(page.url()).pathname, 'shared identity login failed').not.toBe(
    '/auth-error',
  );

  const response = await page.context().request.get('/api/auth/me');
  expect(
    response.status(),
    'shared identity session was not accepted by Core',
  ).toBe(200);
  const payload = (await response.json()) as {
    user?: { emailVerified?: string | null };
  };
  expect(
    payload.user?.emailVerified,
    'analytics test account must be verified',
  ).toBeTruthy();

  await mkdir(dirname(storageStatePath), { recursive: true });
  await page.context().storageState({ path: storageStatePath });
});
