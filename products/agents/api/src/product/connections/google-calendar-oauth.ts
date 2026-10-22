import type * as oidc from "openid-client";
import {nativeProviderConnectors} from "../../adapters/providers/connector-registry";
import { NativeProviderOAuth,providerOAuthConfigFromEnvironment,providerScopes,parseProviderTokens,type ProviderOAuthConfig,type ProviderOAuthTokens,type ProviderOAuthPort } from "./provider-oauth";
const definition=nativeProviderConnectors.find(record=>record.id==="google-calendar")!;
export type GoogleOAuthConfig=ProviderOAuthConfig;
export type GoogleOAuthTokens=ProviderOAuthTokens;
export type GoogleOAuthPort=ProviderOAuthPort;
export const GOOGLE_CALENDAR_SCOPES=providerScopes(definition,definition.operations.map(operation=>operation.id));
export const parseGoogleTokens=parseProviderTokens;
export const googleOAuthConfigFromEnvironment=(env:NodeJS.ProcessEnv=process.env)=>providerOAuthConfigFromEnvironment(definition,env);
export class GoogleCalendarOAuth extends NativeProviderOAuth {
 constructor(config:GoogleOAuthConfig,testMetadata?:oidc.ServerMetadata){super(definition,config,testMetadata);}
}
