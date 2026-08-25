import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { expect, test } from "@playwright/test";

const email = process.env.ANALYTICS_PLAYWRIGHT_EMAIL;
const password = process.env.ANALYTICS_PLAYWRIGHT_PASSWORD;
const storageStatePath = resolve(
  process.cwd(),
  process.env.ANALYTICS_PLAYWRIGHT_STORAGE_STATE ?? ".playwright/.auth/user.json",
);

test("creates a reusable Core session for analytics browser tests", async ({ request }) => {
  test.skip(!email || !password, "Set ANALYTICS_PLAYWRIGHT_EMAIL and ANALYTICS_PLAYWRIGHT_PASSWORD");

  const response = await request.post("/api/auth/login", {
    data: { email, password },
  });

  expect(response.status(), "analytics browser login failed").toBe(200);
  const payload = (await response.json()) as { user?: { emailVerified?: string | null } };
  expect(payload.user?.emailVerified, "analytics test account must be verified").toBeTruthy();

  await mkdir(dirname(storageStatePath), { recursive: true });
  await request.storageState({ path: storageStatePath });
});
