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
  ) as {
    sourceCommit: string;
    sourceFiles: Record<string, string>;
    routeCount: number;
    routes: string[];
    typescriptExtensions: {
      method: string;
      path: string;
      source: string;
      sourceCommit: string;
      reason: string;
    }[];
  };
  assert.match(fixture.sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(Object.keys(fixture.sourceFiles).length > 0);
  for (const digest of Object.values(fixture.sourceFiles))
    assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(fixture.routeCount, 537);
  assert.equal(fixture.routes.length, fixture.routeCount);
  assert.equal(fixture.typescriptExtensions.length, 2);
  for (const extension of fixture.typescriptExtensions) {
    assert.match(extension.sourceCommit, /^[a-f0-9]{40}$/);
    assert.ok(extension.source.startsWith("server/kasitek-core/"));
    assert.ok(extension.source.endsWith(".ts"));
    assert.ok(extension.reason.length > 0);
  }

  const expected = new Set(
    [
      ...fixture.routes,
      ...fixture.typescriptExtensions.map(
        ({ method, path }) => `${method} ${path}`,
      ),
    ].map((route) => route.replace(/\{([^}]+)\}/g, ":$1")),
  );
  assert.equal(
    expected.size,
    fixture.routeCount + fixture.typescriptExtensions.length,
  );
  const actual = new Set<string>(["GET /", "GET /health"]);
  const config = readConfig({
    DATABASE_URL: "postgres://unused",
    FRONTEND_URL: "http://localhost:3000",
    AGENTS_API_URL: "http://127.0.0.1:4100",
    AGENTS_INTERNAL_AUTH_SECRET: "synthetic-route-census-key",
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
