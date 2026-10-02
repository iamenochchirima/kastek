# Shared contracts

Private browser-safe TypeScript types and Analytics endpoint constants. The package exports compiled ESM and declarations. It contains no runtime secrets or Node imports.

Wire property names, enums, envelope versions and reporting paths follow the existing Rust implementations. `Integer` accepts exact decimal strings and bigint as well as safe numbers. Backend serializers must emit numeric JSON tokens where the existing contract requires numbers. Do not convert PostgreSQL bigint to Number without checking its safe range.

From the Labs root, use Node 24 and `pnpm install --frozen-lockfile`, then `pnpm build:shared`.
