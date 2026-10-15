import { ApiError } from '../error.js';
export type PrincipalKind = 'direct_user' | 'platform_admin' | 'workspace_api_key' | 'service_account' | 'oauth_user' | 'oauth_application' | 'agent_installation' | 'trusted_internal_service';
export interface Principal { kind: PrincipalKind; id: string; subjectUserId: string | null; clientId: string | null }
export type ActorKind = 'direct_user' | 'api_client' | 'external_agent' | 'native_agent';
export interface Actor { kind: ActorKind; id: string; realm: 'direct'; authenticated_client_id: string | null; delegated_by: null }
export interface PublicApiPrincipalPolicy { wireName: string; actorKind: ActorKind; supportsDirectReads: boolean; supportsDirectWrites: boolean; requiresInstallationCapabilities: boolean }
export const SUPPORTED_PUBLIC_API_PRINCIPALS = ['direct_user', 'workspace_api_key', 'agent_installation'] as const;
export const UNSUPPORTED_PUBLIC_API_PRINCIPALS = ['service_account', 'oauth_user', 'oauth_application'] as const;
export function directUser(userId: string): Principal { return { kind:'direct_user',id:userId,subjectUserId:userId,clientId:null }; }
export function publicApiPolicy(principal: Principal): PublicApiPrincipalPolicy {
  const kind = principal.kind;
  if (kind !== 'direct_user' && kind !== 'workspace_api_key' && kind !== 'agent_installation') throw new ApiError(403,'unsupported_principal',`Public API principal type ${kind} is not supported`);
  return { wireName:kind,actorKind:kind==='direct_user'?'direct_user':kind==='workspace_api_key'?'api_client':'external_agent',supportsDirectReads:true,supportsDirectWrites:true,requiresInstallationCapabilities:kind==='agent_installation' };
}
export function toDirectActor(principal: Principal): Actor {
  let kind: ActorKind;
  switch(principal.kind) {
    case 'direct_user': kind='direct_user'; break;
    case 'workspace_api_key': case 'service_account': kind='api_client';break;
    case 'agent_installation':kind='external_agent';break;
    case 'trusted_internal_service':kind='native_agent';break;
    default:throw new ApiError(403,'forbidden','This principal cannot act in the direct product runtime');
  }
  return {kind,id:principal.id,realm:'direct',authenticated_client_id:kind==='direct_user'?null:principal.clientId??principal.id,delegated_by:null};
}
