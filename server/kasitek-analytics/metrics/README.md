# Analytics metric registry

`index.json` is the deterministic index for YAML metric, dimension, and metric-set definitions.
`registry.schema.json` validates each source file before the service loads it.

Metrics use stable domain-qualified identities such as `campaign.delivery_rate@1`. Definitions
carry source contracts, formulas, eligible populations, exclusions, aggregation and deduplication
rules, scope kinds, permissions, privacy, exactness, freshness, coverage, availability, and
effective periods. Dimensions are registered separately so reporting clients cannot group by an
arbitrary event attribute. Metric sets provide named, versioned dashboard defaults.

The registry loader rejects duplicate identities, unknown references, invalid ratio dependencies,
incompatible dimensions, coverage sources outside the source set, and dependency cycles. It also
produces a SHA-256 artifact hash used by the generated Rust key binding.

Validate or regenerate the Rust binding with:

```bash
cargo run --bin analytics-registry -- --check
cargo run --bin analytics-registry -- --write
```

Formula, population, denominator, unit, or aggregation changes require a new metric major version
and an explicit migration of consumers. Reporting, projections, exports, alerts, and agent tools
will consume these identities through Analytics rather than defining local calculations.
