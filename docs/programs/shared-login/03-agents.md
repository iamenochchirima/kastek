# Agents independent human sign-in

Status: Draft follow-on. Owner repository: kasitek-agents.
Outcome: A person signs into the Agents product using a KasiTek account without requiring Growth to provide the human login session.
Dependency: Labs contract and verified Growth pilot.

## Work

- [ ] Inventory the copied web app's Core /api/auth/me, login, cookie-forwarding, organization, and API assumptions.
- [ ] Define the Agents-local human principal and workspace membership model. A standalone customer need not own a Growth workspace.
- [ ] Add issuer/subject-to-local-principal mapping and a separate OIDC product client.
- [ ] Add backend-owned callback/session handling. Replace only the human login dependence on Growth.
- [ ] Authorize Agents resource operations against current Agents membership. Keep internal signed service tokens, installation identities, gateway credentials, API keys, and tool delegation separate.
- [ ] Define how a Growth integration maps to an explicitly granted Agents installation/workspace. A Growth role alone cannot confer access to arbitrary Agents resources.
- [ ] Adopt the agreed revocation/logout policy and update the standalone local startup instructions.

## Minimum verification

- [ ] Login succeeds with Growth stopped. A standalone Agents user can access only its granted workspace.
- [ ] A signed-in Growth user with no Agents grant is denied.
- [ ] Wrong product audience and unauthorized organization/actor claims fail.
- [ ] Existing Core-to-Agents authorized product-chat calls continue to work with their separate credentials.
- [ ] Account disable and logout satisfy the shared contract.

## Release and rollback

Build one provider-based human sign-in flow with fresh product users. No existing-account migration or old-login fallback is required. Record schema/configuration revision, login/denial metrics, docs, and operational recovery before deployment.
