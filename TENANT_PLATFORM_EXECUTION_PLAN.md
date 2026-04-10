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
- [ ] Add tenant-client-scoped service/data endpoints

### Phase 3: Provisioning And Bootstrap

- [ ] Add a tenant bootstrap/provisioning utility
- [ ] Create workspace + branding + domain + first tenant admin in one flow
- [ ] Issue initial API key in provisioning flow
- [ ] Document required environment and bootstrap commands

### Phase 4: Tenant Portal Integration

- [ ] Replace demo localStorage auth with real tenant staff auth
- [ ] Add tenant context bootstrap from backend
- [ ] Add logout/me flow based on cookie sessions
- [ ] Replace placeholder dashboard summary/hooks with real backend-backed data
- [ ] Add tenant-admin client management UI
- [ ] Add client invite/onboarding UI

### Phase 5: Hardening

- [ ] Add role guards consistently across tenant-admin routes
- [ ] Add client-user-scoped access middleware for future client surfaces
- [ ] Add tests or targeted verification scripts for auth and provisioning flows
- [ ] Review CORS/cookie/domain setup for deployment topology

## Active Work

Current execution focus:

1. provisioning/bootstrap flow
2. tenant portal auth/bootstrap wiring
3. first real dashboard data path

## Notes

- Keep `kasitek-core` unchanged unless explicitly required later.
- Do not merge tenant staff and tenant client identities into one table.
- Prefer clean boundaries over shortcuts that will block scaling later.
