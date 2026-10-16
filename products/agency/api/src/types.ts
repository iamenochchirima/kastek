export interface HealthResponse {
  status: string;
  service: string;
  timestamp: string;
}
export interface TenantWorkspaceContext {
  workspace_id: string;
  workspace_slug: string;
  scopes: string[];
}
export interface TenantResolvedWorkspace {
  workspace_id: string;
  workspace_slug: string;
  display_name: string;
}
export interface TenantUserSessionContext {
  workspace_id: string;
  workspace_slug: string;
  tenant_user_id: string;
  email: string;
  name: string | null;
  roles: string[];
  agency_partner: boolean;
}
export interface TenantAccessContext {
  workspace_id: string;
  workspace_slug: string;
  scopes: string[];
  tenant_user_id: string | null;
  tenant_user_roles: string[];
}
export interface TenantClientUserSessionContext {
  workspace_id: string;
  workspace_slug: string;
  tenant_client_id: string;
  tenant_client_name: string;
  tenant_client_user_id: string;
  email: string;
  name: string | null;
  roles: string[];
}
