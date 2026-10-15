# Agency UI screen and API inventory

Inspected from the migrated source on 2026-10-07. The public URL mapping is in `UI_IMPLEMENTATION.md`. API-client hooks retain their definitions in `client/packages/api-client-react/src/index.ts`; shared auth/context calls retain their definitions in `src/lib/auth.tsx` and `src/lib/tenant-context-provider.tsx`. Backend membership/audience checks remain authoritative.

| Screen source | Frontend access/context boundary | Direct API paths and API-client hooks |
| --- | --- | --- |
| `accept-invite.tsx` | public or delegated to child screen | `/api/client-auth/accept-invite`; `/api/client-auth/invite?token=${encodeURIComponent(token)}` |
| `adcreative.tsx` | tenant audience | `useCreateAdCampaign`; `useListAdCampaigns`; `useListAdCreatives` |
| `admin-setup.tsx` | public or delegated to child screen | `/api/auth/accept-admin-invite`; `/api/auth/admin-invite?token=${encodeURIComponent(token)}` |
| `aeo.tsx` | tenant audience | `useCreateAeoContent`; `useGetAeoCitations`; `useListAeoContent` |
| `agency-landing.tsx` | public or delegated to child screen | No direct API call |
| `client-conversation-detail.tsx` | client audience | `useGetClientConversation`; `useListClientConversationMessages` |
| `client-conversations.tsx` | client audience | `useListClientConversations` |
| `client-detail.tsx` | CLIENT_ADMIN_ROLES, tenant audience | `useInviteTenantClientUser`; `useListTenantClientUsers`; `useListTenantClients` |
| `client-home.tsx` | client audience | `useGetClientLeadStats`; `useGetClientOverview`; `useListClientConversations` |
| `client-leads.tsx` | client audience | `useGetClientLeadStats`; `useListClientLeads` |
| `clients.tsx` | CLIENT_ADMIN_ROLES, tenant audience | `useCreateTenantClient`; `useListTenantClients` |
| `content.tsx` | tenant audience | `useGenerateContent`; `useListContentHistory` |
| `dashboard.tsx` | tenant audience | `useGetDashboardActivity`; `useGetDashboardSummary`; `useListServices` |
| `leads.tsx` | LEAD_OPERATOR_ROLES, tenant audience | `useCreateLead`; `useGetLeadsStats`; `useListLeads`; `useListTenantClients` |
| `login.tsx` | public or delegated to child screen | `/api/auth/session/continue`; `/api/tenant/api/partner/auth/start?returnTo=${encodeURIComponent(context.workspace?.slug` |
| `not-found.tsx` | public or delegated to child screen | No direct API call |
| `nurturing.tsx` | tenant audience | `useCreateNurturingSequence`; `useGetNurturingStats`; `useListNurturingSequences` |
| `partner-business-settings.tsx` | backend partner/owner API checks | `/api/partner/businesses/${encodeURIComponent(businessId)}`; `/api/partner/businesses/${encodeURIComponent(businessId)}/branding` |
| `partner-businesses.tsx` | backend partner/owner API checks | `/api/partner/auth/${allDevices`; `/api/partner/auth/me`; `/api/partner/businesses` |
| `partner-login.tsx` | public or delegated to child screen | `/api/tenant/api/partner/auth/start${params.size` |
| `partner-onboarding.tsx` | backend partner/owner API checks | `/api/partner/auth/me`; `/api/partner/businesses` |
| `portal-entry.tsx` | public or delegated to child screen | `/api/public/tenant-context` |
| `reporting.tsx` | tenant audience | `useCreateReportingDashboard`; `useGetDashboardMetrics`; `useListReportingDashboards` |
| `reviews.tsx` | tenant audience | `useCreateReviewCampaign`; `useGetReviewStats`; `useListReviewCampaigns` |
| `settings.tsx` | SETTINGS_ROLES, tenant audience | `/api/workspace`; `/api/workspace/domains`; `/api/workspace/domains/${domainId}`; `/api/workspace/domains/${domainId}/primary`; `/api/workspace/domains/${domainId}/verify`; `/api/workspace/email-sending`; `/api/workspace/email-sending/domains`; `/api/workspace/email-sending/domains/${domainId}`; `/api/workspace/email-sending/domains/${domainId}/verify`; `/api/workspace/email-sending/test`; `/api/workspace/staff`; `/api/workspace/staff/${staffId}` |
| `tenant-home.tsx` | backend partner/owner API checks | `/api/partner/auth/me` |
| `voice.tsx` | tenant audience | `useCreateVoiceAgent`; `useListVoiceAgents`; `useListVoiceCalls` |

The theme and router migration did not change the typed API-client endpoint definitions or the backend role matrix. The browser separately verified owner business creation/branding, Viewer sign-in and denial of `/clients`, client sign-in and denial of `/settings`. Database-backed auth integration verifies invitation activation, partner ownership and cross-workspace denial.
