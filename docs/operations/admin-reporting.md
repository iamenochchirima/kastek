# Administrative reporting contract

Owner: Platform engineering. Reviewed: 2026-10-23.

This reference defines the administrative reporting transport and metric semantics. Product sources and the admin UI must expose coverage for the metrics they actually supply. Contract presence alone does not establish runtime source coverage.

The shared types and metric catalogue are in `packages/contracts/src/admin-reporting.ts`. Query validation and CSV serialization are in the `@kasitek-labs/server-support/admin-reporting` export.

## Scope and time

Each response names its product. An organization ID selects only that product's organization or workspace. Growth and Agency execution mapping uses the verified product execution tenant records held by Agents, never matching IDs or emails across products. Cross-product unique people and customer counts are unavailable without an explicit verified identity mapping. Product membership counts cannot be summed as unique people.

Requests use UTC start and end instants and a valid reporting timezone. Periods include start and exclude end. The selected timezone controls presentation and trend buckets, not the instants themselves. Current-state metrics describe the read snapshot and are labelled current. Period metrics describe source-recorded facts in the selected range. Report ranges are bounded to the existing Analytics limit of 366 days, page sizes to 100, and page numbers to 10,000. Exports use the same metric scope and definitions as the screen.

## Metric evidence

Values are decimal strings so PostgreSQL bigint totals remain exact across JSON. Unknown values are null. Every metric names its source and available, partial, stale, unavailable or unsupported state. A successful query confirming no rows can produce zero. A failed query cannot. Source observation timestamps describe source facts, response generation timestamps describe requests, and complete-through watermarks require ingestion or projection checkpoints. Do not substitute one for another.

The catalogue groups metrics into customers, adoption, usage, revenue and reliability. Sources must document their meaningful activity set. An organization owner's identity inferred from organization activity does not establish that owner's activity. Root task failure and completion metrics use the admission cohort and current outcome; report distinct terminal outcomes and do not claim a closed-cohort success rate while work remains open.

## Shared execution and cost

Agents owns execution accounting. Attribute each root task to its consuming product through its admitted product and verified product tenant mapping. Count a root once. Include child model work in root totals once per operation. Retried dispatch or re-read records cannot add cost. Consumer breakdowns partition execution-owner totals; they are not an additional platform cost.

Provider/model detail comes from recorded model identity, never a current catalogue guess. Model cost is stored in USD micros by the existing model accounting ledger. Settled known cost and unknown operation counts remain separate. Prices derived from usage are estimates unless a provider receipt establishes actual billing. Missing cost is never zero. Credits are a product usage unit, not money.

Example: a Growth root has two model operations and one child operation costing 100, 200 and 50 USD micros. The Agents execution total is 350 micros, with 350 attributed to Growth. A combined platform report is 350, not 700. If the child cost is unknown, known cost is 300 with partial coverage and one unknown operation. A replay of the first settlement leaves these values unchanged.

## Revenue

Keep amounts in source minor units with explicit currency. Group ZAR and USD separately. No implicit exchange rate or sum across currencies. Paid invoices use the paid timestamp and represent recorded collections, not provider net settlements. Refunded status alone does not establish refund amount and time. Outstanding is current unpaid issued balance, not a historical period-end balance. Where refunds or partial payment facts are absent, mark the corresponding metric unsupported or partial.

## Ownership and privacy

The admin browser calls its same-origin server proxy. Products expose authorized read APIs and retain database ownership. Labs Analytics owns registered event ingestion, projections, scope resolution and event-derived trend queries. Administrative current-state APIs are read-only. No raw SQL interface or cross-product private-source import is permitted.

Only safe IDs, product scope, state, timestamps and correlation/root IDs appear in report drill-down. Names, message bodies, prompts, tool arguments, attachments, tokens and provider payloads do not belong in telemetry or exports. Customer-content access remains a separately approved support flow.

Saved reports remain private to the creating admin and record metric definition version and product scope. Each export rechecks actor permission and records safe audit metadata. CSV serialization protects spreadsheet formulas and preserves null values and currency.

## Verification

Use fixed records to reconcile each source, then the combined report. Include distinct product organizations with equal IDs, mixed currencies, a root with child work and retry, missing model cost, source failure, delayed ingestion, and a daylight-saving period. Test HTTP authorization at the receiving product and partial-result behavior at the aggregator. Model evaluations remain owner-run.
