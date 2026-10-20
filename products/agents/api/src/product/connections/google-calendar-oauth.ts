import * as oidc from "openid-client";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { createBoundedFetch } from "../../infrastructure/connected-network";

export const GOOGLE_CALENDAR_SCOPES=Object.freeze(["openid","email","https://www.googleapis.com/auth/calendar.calendarlist.readonly","https://www.googleapis.com/auth/calendar.events.freebusy","https://www.googleapis.com/auth/calendar.events"]);
export interface GoogleOAuthConfig {clientId:string;clientSecret:string;callbackUrl:string;appUrl:string}
export interface GoogleOAuthTokens {accessToken:string;refreshToken:string;expiresAt:string;scopes:string[];subject:string;email:string}
export interface GoogleOAuthPort {
  begin():Promise<{state:string;nonce:string;verifier:string;authorizationUrl:string}>;
  complete(query:string,attempt:{state:string;nonce:string;verifier:string}):Promise<GoogleOAuthTokens>;
  refresh(refreshToken:string,current:GoogleOAuthTokens):Promise<GoogleOAuthTokens>;
}
export function googleOAuthConfigFromEnvironment(env:NodeJS.ProcessEnv=process.env):GoogleOAuthConfig|undefined {
  const {GOOGLE_CALENDAR_CLIENT_ID:clientId,GOOGLE_CALENDAR_CLIENT_SECRET:clientSecret,GOOGLE_CALENDAR_CALLBACK_URL:callbackUrl,AGENTS_PUBLIC_URL:appUrl}=env;
  if(!clientId||!clientSecret||!callbackUrl||!appUrl)return;
  try{const callback=new URL(callbackUrl),app=new URL(appUrl);if(callback.protocol!=="https:"||app.protocol!=="https:"||callback.username||callback.password||callback.search||callback.hash||app.username||app.password)return;
    if(!callback.pathname.endsWith("/api/google-calendar/callback"))return;
    return {clientId,clientSecret,callbackUrl:callback.href,appUrl:app.href};}catch{return;}
}
const tokensSchema=z.strictObject({accessToken:z.string().min(1).max(8192),refreshToken:z.string().min(1).max(8192),expiresAt:z.iso.datetime({offset:true}),scopes:z.array(z.string().max(256)).max(32),subject:z.string().min(1).max(256),email:z.email().max(320)});
export function parseGoogleTokens(value:unknown):GoogleOAuthTokens {return tokensSchema.parse(value);}
const normalizeScopes=(scopes:string[])=>[...new Set(scopes.map(scope=>scope==="https://www.googleapis.com/auth/userinfo.email"?"email":scope))];
const fail=()=>new PlatformError("GOOGLE_AUTHORIZATION_FAILED",401,"Google authorization could not be completed");
export class GoogleCalendarOAuth implements GoogleOAuthPort {
  constructor(readonly config:GoogleOAuthConfig,private readonly testMetadata?:oidc.ServerMetadata) {}
  private configuration():oidc.Configuration {
    const metadata=this.testMetadata??{issuer:"https://accounts.google.com",authorization_endpoint:"https://accounts.google.com/o/oauth2/v2/auth",token_endpoint:"https://oauth2.googleapis.com/token",jwks_uri:"https://www.googleapis.com/oauth2/v3/certs",response_types_supported:["code"],subject_types_supported:["public"],id_token_signing_alg_values_supported:["RS256"]};
    const config=new oidc.Configuration(metadata,this.config.clientId,this.config.clientSecret);
    config.timeout=15;oidc.enableNonRepudiationChecks(config);
    if(this.testMetadata){for(const value of [metadata.issuer,metadata.authorization_endpoint,metadata.token_endpoint,metadata.jwks_uri]){const url=new URL(value!);if(url.protocol!=="http:"||!["localhost","127.0.0.1","[::1]"].includes(url.hostname))throw fail();}oidc.allowInsecureRequests(config);}
    const allowed=new Set([metadata.token_endpoint,metadata.jwks_uri]);
    config[oidc.customFetch]=async(url,options)=>{
      const fetcher=createBoundedFetch({authorizeUrl:value=>allowed.has(value.href),headers:Object.fromEntries(new Headers(options.headers)),maxRequestBytes:16384,maxResponseBytes:262144,maxRequests:1,maxAttempts:1,deadlineAt:Date.now()+15000,testLoopback:!!this.testMetadata,returnAuthenticationResponses:true,returnProviderErrorResponses:true});
      const body=options.body instanceof URLSearchParams?options.body.toString():options.body;
      if(body!==undefined&&body!==null&&typeof body!=="string")throw fail();
      return fetcher(url,{method:options.method,headers:options.headers,signal:options.signal,body});
    };
    return config;
  }
  async begin(){const config=this.configuration(),state=oidc.randomState(),nonce=oidc.randomNonce(),verifier=oidc.randomPKCECodeVerifier();return {state,nonce,verifier,authorizationUrl:oidc.buildAuthorizationUrl(config,{redirect_uri:this.config.callbackUrl,scope:GOOGLE_CALENDAR_SCOPES.join(" "),state,nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:"S256",access_type:"offline",prompt:"consent",include_granted_scopes:"true"}).href};}
  async complete(query:string,attempt:{state:string;nonce:string;verifier:string}):Promise<GoogleOAuthTokens>{
    try{const response=await oidc.authorizationCodeGrant(this.configuration(),new URL(this.config.callbackUrl+query),{pkceCodeVerifier:attempt.verifier,expectedState:attempt.state,expectedNonce:attempt.nonce,idTokenExpected:true});
      const claims=response.claims();if(!claims||typeof claims.sub!=="string"||typeof claims.email!=="string"||claims.email_verified!==true||typeof response.refresh_token!=="string"||response.token_type.toLowerCase()!=="bearer"||!response.expires_in||response.expires_in>86400)throw fail();
      const scopes=normalizeScopes((response.scope??"").split(" ").filter(Boolean));if(!GOOGLE_CALENDAR_SCOPES.every(scope=>scopes.includes(scope)))throw new PlatformError("GOOGLE_SCOPES_REQUIRED",403,"Google Calendar permissions were not granted");
      return parseGoogleTokens({accessToken:response.access_token,refreshToken:response.refresh_token,expiresAt:new Date(Date.now()+response.expires_in*1000).toISOString(),scopes,subject:claims.sub,email:claims.email});
    }catch(error){if(error instanceof PlatformError)throw error;throw fail();}
  }
  async refresh(refreshToken:string,current:GoogleOAuthTokens):Promise<GoogleOAuthTokens>{
    try{const response=await oidc.refreshTokenGrant(this.configuration(),refreshToken);if(response.token_type.toLowerCase()!=="bearer"||!response.expires_in||response.expires_in>86400)throw fail();const claims=response.claims();if(claims&&(claims.sub!==current.subject||claims.email!==undefined&&claims.email!==current.email||claims.email_verified!==undefined&&claims.email_verified!==true))throw fail();const scopes=normalizeScopes(response.scope?response.scope.split(" ").filter(Boolean):current.scopes);
      if(!GOOGLE_CALENDAR_SCOPES.every(scope=>scopes.includes(scope)))throw fail();
      return parseGoogleTokens({...current,accessToken:response.access_token,refreshToken:response.refresh_token??refreshToken,expiresAt:new Date(Date.now()+response.expires_in*1000).toISOString(),scopes});
    }catch{throw new PlatformError("GOOGLE_RECONNECT_REQUIRED",401,"Reconnect Google Calendar");}
  }
}
