# KasiTek Agent Platform

The Agent Platform owns agent definitions, durable execution, conversations, memory, operational
records, and the standalone management UI.

## Management UI

The Next.js app is in `client/apps/agent-platform`. It contains the existing `/agents/**`,
`/studio`, `/studio/new`, and `/playground` routes. Growth retains its copy until its separate
cleanup issue is completed. This app's authentication and API integrations are still transitional
and are not configured as standalone services. See [the source boundary](docs/source-boundary.md).

Use Node `>=22.12.0 <23` or `>=24.0.0` and pnpm `10.30.1`.

```bash
pnpm install
pnpm dev
```

Focused checks:

```bash
pnpm typecheck
pnpm build
```

`pnpm lint` is available, but the verbatim relocated UI currently reports existing React-hook
lint errors. Those behavior-preserving source files are not refactored as part of this move.
