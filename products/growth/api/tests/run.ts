import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  startBillingFixture,
  TEST_BILLING_SECRET,
  TEST_SNAPSHOT_SECRET,
} from "./support/billing-test-server.js";

const root = dirname(fileURLToPath(import.meta.url));
const fixture = await startBillingFixture();
const files = readdirSync(root)
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => join(root, name));
const env = {
  ...process.env,
  BILLING_SERVICE_URL: fixture.url,
  BILLING_SERVICE_SECRET: TEST_BILLING_SECRET,
  BILLING_SNAPSHOT_SECRET: TEST_SNAPSHOT_SECRET,
};
const args = process.argv.slice(2).filter((value) => value !== "--");
const child = spawn("tsx", ["--test", ...args, ...files], {
  env,
  stdio: "inherit",
});
const code = await new Promise<number | null>((resolve) =>
  child.once("exit", (value) => resolve(value)),
);
await fixture.close();
process.exit(code ?? 1);
