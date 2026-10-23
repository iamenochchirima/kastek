import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type pg from "pg";
import { buildApp } from "../src/app.js";
import { CORE_REGISTRARS } from "../src/main.js";
import { readConfig } from "../src/config.js";
import type { CoreContext } from "../src/context.js";

test("Growth registers the recorded API route contract", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/routes.json", import.meta.url),
      "utf8",
    ),
  ) as {version:number;generatedBy:string;routeCount:number;routes:string[]};
  assert.equal(fixture.version,1);
  assert.equal(fixture.generatedBy,'scripts/refresh-route-contracts.ts');
  assert.equal(fixture.routeCount,fixture.routes.length);
  const expected=new Set(fixture.routes);
  assert.equal(expected.size,fixture.routeCount);
  for(const route of ['POST /api/quote-requests','POST /api/waitlist','GET /api/inbox/conversations','GET /api/agents/bootstrap','POST /internal/agents/actions'])assert.ok(expected.has(route),route);
  assert.ok(![...expected].some(route=>route.includes('/api/widget/v1/')||route.includes('/api/agents/installations/')||route.includes('/api/internal/agents/v1/')));
  const actual = new Set<string>(["GET /", "GET /health"]);
  const config = readConfig({
    DATABASE_URL: "postgres://unused",
    FRONTEND_URL: "http://localhost:3000",
    LOG_LEVEL: "silent",
  });
  const context = {
    config,
    pool: {
      query: () => {
        throw new Error("Route registration must not access PostgreSQL");
      },
    },
  } as unknown as CoreContext;
  const app = await buildApp(context, [
    (instance) => {
      instance.addHook("onRoute", (route) => {
        for (const method of Array.isArray(route.method)
          ? route.method
          : [route.method])
          if (method !== "HEAD") actual.add(`${method} ${route.url}`);
      });
    },
    ...CORE_REGISTRARS,
  ]);

  try {
    await app.ready();
    assert.deepEqual([...actual].sort(), [...expected].sort());
  } finally {
    await app.close();
  }
});
