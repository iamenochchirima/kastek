import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SandboxGuardError,
  parseDatabaseUrl,
  validateSandboxEnvironment,
} from "../src/guard.js";

const base: NodeJS.ProcessEnv = {
  EVALS_ENVIRONMENT: "test",
  AGENTS_EVALS_DATABASE_URL:
    "postgresql://agents_evals_admin@127.0.0.1:55432/agents_evals",
  AGENTS_PRODUCT_DATABASE_URL:
    "postgresql://agents_admin@127.0.0.1:16544/agents",
  AGENTS_BILLING_ENFORCEMENT: "0",
  EVALS_MODEL_MODE: "deterministic",
  EVALS_IDENTITY_MODE: "seed",
  EVALS_NETWORK_POLICY: "loopback",
};

function guardCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof SandboxGuardError && error.code === code;
}

test("accepts the persistent Agents sandbox environment", () => {
  const result = validateSandboxEnvironment(base);
  assert.equal(result.environment, "test");
  assert.equal(result.evalDatabase.database, "agents_evals");
  assert.equal(result.productDatabase.database, "agents");
  assert.equal(result.billingEnforcement, "sandbox");
  assert.equal(result.modelMode, "deterministic");
  assert.equal(result.identityMode, "seed");
  assert.equal(result.networkPolicy, "loopback");
});

test("normalizes localhost to loopback", () => {
  const result = parseDatabaseUrl(
    "postgresql://role@localhost:5432/agents_evals",
    "url",
  );
  assert.equal(result.host, "127.0.0.1");
});

test("rejects a per-run database as the persistent sandbox", () => {
  assert.throws(
    () =>
      validateSandboxEnvironment({
        ...base,
        AGENTS_EVALS_DATABASE_URL:
          "postgresql://agents_evals_admin@127.0.0.1:55432/agents_evals_abcd",
      }),
    guardCode("NON_PERSISTENT_EVAL_DATABASE"),
  );
});

test("rejects a product database reused as the sandbox", () => {
  assert.throws(
    () =>
      validateSandboxEnvironment({
        ...base,
        AGENTS_PRODUCT_DATABASE_URL:
          "postgresql://agents_evals_admin@127.0.0.1:55432/agents_evals",
      }),
    guardCode("PRODUCTION_DATABASE"),
  );
});

test("rejects a production environment", () => {
  assert.throws(
    () =>
      validateSandboxEnvironment({
        ...base,
        EVALS_ENVIRONMENT: "production",
      }),
    guardCode("PRODUCTION_ENVIRONMENT"),
  );
});

test("records sandbox billing independently of the control-plane product env", () => {
  const result = validateSandboxEnvironment({
    ...base,
    AGENTS_BILLING_ENFORCEMENT: "1",
  });
  assert.equal(result.billingEnforcement, "sandbox");
});

test("rejects a live model", () => {
  assert.throws(
    () =>
      validateSandboxEnvironment({
        ...base,
        EVALS_MODEL_MODE: "live",
      }),
    guardCode("LIVE_MODEL_NOT_ALLOWED"),
  );
  assert.throws(
    () =>
      validateSandboxEnvironment({
        ...base,
        AGENTS_HARBOR_REAL_MODEL: "1",
      }),
    guardCode("LIVE_MODEL_NOT_ALLOWED"),
  );
});

test("rejects a production identity mode", () => {
  assert.throws(
    () =>
      validateSandboxEnvironment({
        ...base,
        EVALS_IDENTITY_MODE: "service-principal",
      }),
    guardCode("PRODUCTION_IDENTITY"),
  );
});

test("rejects an open network policy", () => {
  assert.throws(
    () =>
      validateSandboxEnvironment({
        ...base,
        EVALS_NETWORK_POLICY: "open",
      }),
    guardCode("OPEN_NETWORK_POLICY"),
  );
});

test("rejects a missing product database", () => {
  assert.throws(
    () =>
      validateSandboxEnvironment({
        ...base,
        AGENTS_PRODUCT_DATABASE_URL: undefined,
        AGENTS_DATABASE_URL: undefined,
      }),
    guardCode("CONFIGURATION_MISSING"),
  );
});
