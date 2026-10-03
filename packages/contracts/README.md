# Shared contracts

Private browser-safe TypeScript contracts, generated Analytics registry keys and Analytics endpoint constants. It exports ESM and CommonJS entry points with declarations, and contains no runtime secrets or Node imports. Analytics registry generation writes the single shared source to `src/analytics-registry.ts`.

Wire property names, enums, envelope versions and reporting paths follow the existing Rust implementations. `Integer` accepts exact decimal strings and bigint as well as safe numbers. Backend serializers must emit numeric JSON tokens where the existing contract requires numbers. Do not convert PostgreSQL bigint to Number without checking its safe range.

From the Labs root, use Node 24 and `pnpm install --frozen-lockfile`, then `pnpm build:shared`.
