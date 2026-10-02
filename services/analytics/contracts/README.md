# Analytics contracts

`registry.json` is the index for analytics record contracts. Event attributes are defined by JSON
Schema 2020-12 files under `events/`; the shared CloudEvents-compatible envelope is
`envelope.schema.json` and is deliberately separate from each event payload.

Every indexed contract has a stable `domain.name@major` identity, an owning source lane, a privacy
class, examples, and prohibited sensitive fields. Producers must publish the exact registered
identity. A breaking field or meaning change requires a new major version; an optional field with
unchanged meaning may remain within the current major version.

Validate schemas and examples with:

```bash
corepack pnpm --filter @kasitek/analytics registry:check
```

Source outboxes, authenticated ingestion, scope authorization, and producer adapters are later
execution packages. This registry does not make a producer authoritative by itself.
