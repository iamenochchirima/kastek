# Tenant Platform Execution Plan

This file tracks the active implementation plan for the white-label tenant platform.

## Current Goal

Move `kasitek-tenants` and `client/apps/tenant-portal` from scaffold/demo mode into a deployable tenant platform with:

- separate tenant backend
- separate tenant database
- tenant workspace/domain resolution
- tenant staff auth
- tenant client identity and auth
- tenant provisioning/bootstrap flow
- tenant portal connected to real backend APIs
- one unified tenant frontend for both tenant admins and tenant clients

## Execution Checklist

### Phase 1: Backend Identity Foundation

- [x] Add tenant workspace domains
- [x] Add tenant staff users, roles, and sessions
- [x] Add tenant client entities
- [x] Add tenant client users, roles, invites, and sessions
- [x] Separate tenant staff auth from tenant client auth

### Phase 2: Backend API Surface

- [x] Add tenant staff auth endpoints
- [x] Add tenant client auth endpoints
- [x] Add tenant-admin client management endpoints
- [x] Add real workspace and branding reads
- [x] Add real agents, conversations, and usage reads
- [x] Add tenant-client-scoped service/data endpoints

### Phase 3: Provisioning And Bootstrap

- [x] Add a tenant bootstrap/provisioning utility
- [x] Create workspace + branding + domain + first tenant admin in one flow
- [x] Issue initial API key in provisioning flow
- [x] Document required environment and bootstrap commands

### Phase 4: Tenant Portal Integration

- [x] Replace demo localStorage auth with real tenant staff auth
- [x] Add tenant context bootstrap from backend
- [x] Add logout/me flow based on cookie sessions
- [x] Replace placeholder dashboard summary/hooks with real backend-backed data
- [x] Remove redundant standalone `tenant-admin` app
- [x] Add tenant-admin client management UI
- [x] Add client invite/onboarding UI
- [x] Add unified login routing/role-aware redirect flow for tenant staff vs tenant clients

### Phase 5: Hardening

- [x] Add a unified browser session/login contract for tenant staff and tenant client users
- [x] Move tenant-portal browser traffic behind a same-origin backend proxy path
- [x] Improve invite activation with preview + direct client session bootstrap
- [x] Add client conversation detail views on real client-scoped data
- [ ] Add role guards consistently across tenant-admin routes
- [ ] Add client-user-scoped access middleware for future client surfaces
- [ ] Add tests or targeted verification scripts for auth and provisioning flows
- [x] Review CORS/cookie/domain setup for deployment topology

## Active Work

Current execution focus:

1. expand role hardening across the remaining tenant-admin surfaces
2. add targeted verification scripts for auth, invite, and bootstrap flows
3. deepen client deliverables and service workflows beyond conversations

## Notes

- Keep `kasitek-core` unchanged unless explicitly required later.
- Do not merge tenant staff and tenant client identities into one table.
- Keep tenant admin and tenant client users inside one frontend app unless a hard deployment/security requirement forces a split.
- Prefer clean boundaries over shortcuts that will block scaling later.
