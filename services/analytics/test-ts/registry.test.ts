import assert from "node:assert/strict";
import test from "node:test";
import type {
  ContractSummary,
  DimensionDefinition,
  MetricDefinition,
  MetricSetDefinition,
} from "../src-ts/registry-types.js";
import {
  RegistryError,
  validateRegistrySemantics,
} from "../src-ts/registry.js";

const contract: ContractSummary = {
  identity: "core.event@1",
  owner: "core",
  category: "event",
  privacy_class: "aggregate",
  schema_sha256: "fixture",
};

function metric(
  overrides: Partial<MetricDefinition> = {},
): MetricDefinition {
  return {
    key: "orders",
    version: 1,
    domain: "commerce",
    owner: "core",
    lifecycle: "active",
    description: "Fixture metric",
    value_type: "count",
    unit: "count",
    precision: null,
    sources: [contract.identity],
    formula: "count",
    eligible_population: "all",
    exclusions: [],
    numerator: null,
    denominator: null,
    time_semantics: "event",
    default_aggregation: "sum",
    temporal_aggregation: "sum",
    comparison: "previous_period",
    deduplication: "event_id",
    descendant_aggregation: "sum",
    supported_intervals: ["day"],
    scope_kinds: ["core_organization"],
    dimensions: ["platform"],
    permissions: [],
    privacy_class: "aggregate",
    exactness: "exact",
    freshness: { max_age_seconds: 60, late_data_window_seconds: 60 },
    coverage: { mode: "complete", required_sources: [contract.identity] },
    availability: "available",
    effective_from: "2026-01-01T00:00:00Z",
    applicability: null,
    replacement: null,
    dependencies: [],
    ...overrides,
  };
}

function dimension(
  overrides: Partial<DimensionDefinition> = {},
): DimensionDefinition {
  return {
    key: "platform",
    value_type: "string",
    source: contract.identity,
    compatible_metrics: ["orders@1"],
    filterable: true,
    groupable: true,
    cardinality: "low",
    privacy_class: "aggregate",
    stable_key: true,
    permissions: [],
    ...overrides,
  };
}

function metricSet(
  overrides: Partial<MetricSetDefinition> = {},
): MetricSetDefinition {
  return {
    key: "core",
    version: 1,
    owner: "core",
    lifecycle: "active",
    description: "Fixture metric set",
    metrics: ["orders@1"],
    default_interval: "day",
    scope_kinds: ["core_organization"],
    permissions: [],
    ...overrides,
  };
}

function validate(
  metrics: MetricDefinition[] = [metric()],
  dimensions: DimensionDefinition[] = [dimension()],
  sets: MetricSetDefinition[] = [metricSet()],
  contracts: ContractSummary[] = [contract],
): void {
  validateRegistrySemantics(metrics, dimensions, sets, contracts);
}

test("registry semantics accept a consistent metric graph", () => {
  assert.doesNotThrow(() => validate());
});

test("registry semantics reject invalid source, dimension, coverage and ratio references", () => {
  assert.throws(
    () => validate([metric({ sources: ["missing.event@1"] })]),
    (error) =>
      error instanceof RegistryError &&
      /unregistered source contract/.test(error.message),
  );
  assert.throws(
    () => validate([metric({ dimensions: ["unknown"] })]),
    /references an unknown dimension/,
  );
  assert.throws(
    () =>
      validate([
        metric({ coverage: { mode: "complete", required_sources: ["other@1"] } }),
      ]),
    /coverage references a source outside its source set/,
  );
  assert.throws(
    () => validate([metric({ value_type: "percentage" })]),
    /ratio metrics require numerator and denominator/,
  );
  assert.throws(
    () =>
      validate([
        metric({ numerator: "other@1", denominator: "third@1" }),
      ]),
    /numerator other@1 is not declared as a dependency/,
  );
  assert.throws(
    () =>
      validate([
        metric({ denominator: "other@1" }),
      ]),
    /denominator other@1 is not declared as a dependency/,
  );
});

test("registry semantics reject duplicate identities, broken dependencies and cycles", () => {
  assert.throws(
    () => validate([metric(), metric()]),
    /duplicate metric identity orders@1/,
  );
  assert.throws(
    () => validate([metric()], [dimension()], [metricSet(), metricSet()]),
    /duplicate metric-set identity core@1/,
  );
  assert.throws(
    () => validate([metric()], [dimension()], [metricSet()], [contract, contract]),
    /duplicate contract identity core.event@1/,
  );
  assert.throws(
    () => validate([metric({ dependencies: ["missing@1"] })]),
    /references unknown dependency/,
  );
  assert.throws(
    () =>
      validate([
        metric({ dependencies: ["other@1"] }),
        metric({ key: "other", dependencies: ["orders@1"] }),
      ]),
    /registry dependency cycle/,
  );
});

test("registry semantics reject incompatible dimensions and unknown metric-set entries", () => {
  assert.throws(
    () =>
      validate(
        [metric({ dimensions: [] })],
        [dimension({ compatible_metrics: ["orders@1"] })],
      ),
    /metric does not declare it/,
  );
  assert.throws(
    () => validate([metric()], [dimension()], [metricSet({ metrics: ["missing@1"] })]),
    /metric set core@1 references an unknown metric/,
  );
});
