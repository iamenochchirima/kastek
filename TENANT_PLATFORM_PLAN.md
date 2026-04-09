# Tenant Platform Backend Plan

This plan captures the approved backend-only direction for the tenant platform split.

## Goals

- keep `server/` as KasiTek core
- add a separate Rust `tenant-server/` for white-label tenants
- keep separate deployments and separate databases
- avoid touching frontend apps during this refactor
- introduce reusable Rust crates for backend primitives only

## First Implementation Slice

1. Create a root Rust workspace
2. Keep `server/` as the core workspace member
3. Add `tenant-server/` as a new workspace member
4. Add first reusable backend crates:
   - `types`
   - `config`
   - `crypto-utils`
   - `observability`
5. Scaffold tenant-server with:
   - config loading
   - health route
   - modular route structure
   - api-key/workspace middleware foundation
6. Add tenant database schema foundation for:
   - workspaces
   - api keys
   - branding
   - usage limits
   - usage events
   - audit logs

## Boundaries

### Core server

`server/` remains:

- KasiTek-native backend
- richer internal functionality
- current auth/session model
- existing product flows

### Tenant server

`tenant-server/` will own:

- workspace-scoped API key auth
- tenant-isolated agent configuration
- tenant-isolated conversation history
- tenant usage limits and metering
- branding/domain config
- auditability for tenant actions

### Shared crates

Shared crates should contain primitives and adapters, not feature orchestration.

Good candidates:

- `types`
- `config`
- `crypto-utils`
- `observability`

Later:

- `ai`
- `messaging`
- `usage`

## Rules

- no frontend changes in this refactor
- no accidental coupling of tenant runtime to core runtime
- no tenant access through current core routes
- no shared database between core and tenant
- keep the tenant backend narrow and stable

## Immediate Next Steps

After scaffolding, the next backend implementation steps are:

1. add tenant schema and migrations
2. implement API key auth
3. implement workspace context extraction
4. add workspace/branding endpoints
5. add agent configuration endpoints
6. add conversation history endpoints
7. add usage reporting and limit enforcement
