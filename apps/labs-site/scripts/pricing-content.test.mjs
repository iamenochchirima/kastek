import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Labs pricing routes to product pricing without hardcoded prices", async () => {
  const source = await readFile(
    new URL("../src/app/pricing/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /productUrls\.growth/);
  assert.match(source, /productUrls\.agents/);
  for (const pattern of [/\bR\s?\d/, /\$\s?\d/, /\bZAR\s?\d/])
    assert.doesNotMatch(source, pattern);
});
