import * as oidc from "openid-client";
import { z } from "zod";
import { connectorExecutionDigest,type NativeConnectorConfiguration } from "../../adapters/providers/connector-registry";
import { PlatformError,requestDigest } from "../../contracts/contracts";
import { createBoundedFetch } from "../../infrastructure/connected-network";

export interface ProviderOAuthConfig {clientId:string;clientSecret:string;callbackUrl:string;appUrl:string}
export interface ProviderOAuthTokens {accessToken:string;refreshToken:string;expiresAt:string;scopes:string[];subject:string;email:string}
export interface ProviderOAuthAttempt {state:string;nonce:string;verifier:string;scopes?:string[]}
export interface ProviderOAuthPort {
  readonly configurationDigest?:string;
  begin(scopes?:string[]):Promise<{state:string;nonce:string;verifier:string;authorizationUrl:string}>;
  complete(query:string,attempt:ProviderOAuthAttempt):Promise<ProviderOAuthTokens>;
  refresh(refreshToken:string,current:ProviderOAuthTokens):Promise<ProviderOAuthTokens>;
}
const tokensSchema=z.strictObject({accessToken:z.string().min(1).max(8192).regex(/^[^\x00-\x20\x7f]+$/),refreshToken:z.string().min(1).max(8192).regex(/^[^\x00-\x20\x7f]+$/),expiresAt:z.iso.datetime({offset:true}),scopes:z.array(z.string().min(1).max(256)).max(32),subject:z.string().min(1).max(256),email:z.string().min(1).max(320).refine(value=>!/[\x00-\x1f\x7f]/.test(value))});
export const parseProviderTokens=(value:unknown):ProviderOAuthTokens=>tokensSchema.parse(value);
export function providerScopes(definition:NativeConnectorConfiguration,operations:readonly string[]):string[] {
  if(!operations.length||new Set(operations).size!==operations.length||operations.some(id=>!definition.operations.some(operation=>operation.id===id)))throw new PlatformError("PROVIDER_OPERATION_INVALID",400,"Select supported provider actions");
  return [...new Set([...definition.auth.scopes,...definition.operations.filter(operation=>operations.includes(operation.id)).flatMap(operation=>operation.scopes)])];
}
export function providerOAuthConfigFromEnvironment(definition:NativeConnectorConfiguration,env:NodeJS.ProcessEnv=process.env):ProviderOAuthConfig|undefined {
  const refs=definition.auth.environment,clientId=env[refs.clientId],clientSecret=env[refs.clientSecret],callbackUrl=env[refs.callbackUrl],appUrl=env.AGENTS_PUBLIC_URL;
  if(!clientId||!clientSecret||!callbackUrl||!appUrl)return;
  try{
    const callback=new URL(callbackUrl),app=new URL(appUrl),local=[undefined,"development","test"].includes(env.NODE_ENV)&&app.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(app.hostname);
    if(callback.origin!==app.origin||(!local&&(callback.protocol!=="https:"||app.protocol!=="https:"))||callback.pathname!==definition.auth.callbackPath||app.pathname!=="/")return;
    if([callbackUrl,appUrl].some(value=>{const url=new URL(value);return !!url.username||!!url.password||/[?#\x00-\x20\x7f]/.test(value)||value.match(/^[a-z]+:\/\/([^/?#]*)/i)?.[1]?.includes("@");}))return;
    return {clientId,clientSecret,callbackUrl:callback.href,appUrl:app.href};
  }catch{return;}
}
const fail=()=>new PlatformError("PROVIDER_AUTHORIZATION_FAILED",401,"Provider authorization could not be completed");
const normalize=(value:string)=>value==="https://www.googleapis.com/auth/userinfo.email"?"email":value.replace(/^https:\/\/graph\.microsoft\.com\//,"");

/** Only installed native providers choose identity verification; remote metadata cannot select it. */
export class NativeProviderOAuth implements ProviderOAuthPort {
  readonly configurationDigest:string;
  private configurationPromise?:Promise<oidc.Configuration>;
  constructor(readonly definition:NativeConnectorConfiguration,readonly config:ProviderOAuthConfig,private readonly testMetadata?:oidc.ServerMetadata) {
    this.configurationDigest=requestDigest({connector:connectorExecutionDigest(definition),clientId:config.clientId,callbackUrl:config.callbackUrl,...(testMetadata?{testMetadata}:{})});
  }
  private async configuration():Promise<oidc.Configuration> {
    if(this.configurationPromise)return this.configurationPromise;
    const auth=this.definition.auth,metadata=this.testMetadata;
    if(metadata)for(const endpoint of [metadata.issuer,metadata.authorization_endpoint,metadata.token_endpoint,metadata.jwks_uri,metadata.introspection_endpoint].filter(Boolean)){const url=new URL(endpoint!);if(url.protocol!=="http:"||!["localhost","127.0.0.1","[::1]"].includes(url.hostname))throw fail();}
    const allowed=new Set([metadata?.token_endpoint??auth.tokenEndpoint,...(auth.kind==="oidc"?[metadata?.jwks_uri??auth.jwksUri,`${auth.issuer}/.well-known/openid-configuration`]:[auth.introspectionEndpoint])]);
    const fetcher:oidc.CustomFetch=async(url,options)=>{
      const bounded=createBoundedFetch({authorizeUrl:value=>allowed.has(value.href),headers:Object.fromEntries(new Headers(options.headers)),maxRequestBytes:16384,maxResponseBytes:262144,maxRequests:1,maxAttempts:1,deadlineAt:Date.now()+15000,testLoopback:!!metadata,returnAuthenticationResponses:true,returnProviderErrorResponses:true});
      const body=options.body instanceof URLSearchParams?options.body.toString():options.body;
      if(body!==undefined&&body!==null&&typeof body!=="string")throw fail();
      return bounded(url,{method:options.method,headers:options.headers,signal:options.signal,body});
    };
    this.configurationPromise=(async()=>{
      // openid-client's Entra discovery support verifies the tenant-specific issuer in ID tokens.
      if(this.definition.adapterKey==="microsoft-calendar-v1"&&!metadata){
        const result=await oidc.discovery(new URL((auth as {issuer:string}).issuer),this.config.clientId,this.config.clientSecret,undefined,{[oidc.customFetch]:fetcher});
        const discovered=result.serverMetadata();
        if(discovered.authorization_endpoint!==auth.authorizationEndpoint||discovered.token_endpoint!==auth.tokenEndpoint||auth.kind!=="oidc"||discovered.jwks_uri!==auth.jwksUri)throw fail();
        result.timeout=15;oidc.enableNonRepudiationChecks(result);return result;
      }
      const server=metadata??(auth.kind==="oidc"?{issuer:auth.issuer,authorization_endpoint:auth.authorizationEndpoint,token_endpoint:auth.tokenEndpoint,jwks_uri:auth.jwksUri,response_types_supported:["code"],subject_types_supported:["public"],id_token_signing_alg_values_supported:["RS256"]}:{issuer:new URL(auth.tokenEndpoint).origin,authorization_endpoint:auth.authorizationEndpoint,token_endpoint:auth.tokenEndpoint});
      const result=new oidc.Configuration(server,this.config.clientId,this.config.clientSecret);result.timeout=15;result[oidc.customFetch]=fetcher;
      if(auth.kind==="oidc")oidc.enableNonRepudiationChecks(result);
      if(metadata)oidc.allowInsecureRequests(result);
      return result;
    })();
    try{return await this.configurationPromise;}catch(error){this.configurationPromise=undefined;throw error;}
  }
  async begin(scopes=providerScopes(this.definition,this.definition.operations.map(operation=>operation.id))){
    const config=await this.configuration(),state=oidc.randomState(),nonce=oidc.randomNonce(),verifier=oidc.randomPKCECodeVerifier(),oidcProvider=this.definition.auth.kind==="oidc";
    const parameters:Record<string,string>={redirect_uri:this.config.callbackUrl,scope:scopes.join(" "),state};
    if(oidcProvider)Object.assign(parameters,{nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:"S256"});
    if(this.definition.adapterKey==="google-calendar-v1")Object.assign(parameters,{access_type:"offline",prompt:"consent",include_granted_scopes:"true"});
    return {state,nonce,verifier,authorizationUrl:oidc.buildAuthorizationUrl(config,parameters).href};
  }
  private async tokens(response:oidc.TokenEndpointResponse&oidc.TokenEndpointResponseHelpers,scopes:string[],current?:ProviderOAuthTokens):Promise<ProviderOAuthTokens>{
    if(response.token_type.toLowerCase()!=="bearer"||!response.expires_in||response.expires_in<=0||!Number.isSafeInteger(response.expires_in)||response.expires_in>31536000||!response.refresh_token&&!current)throw fail();
    let subject=current?.subject,email=current?.email,granted=(response.scope?response.scope.split(" ").filter(Boolean):current?.scopes??[]).map(normalize);
    if(this.definition.auth.kind==="oidc"){
      const claims=response.claims();
      if(!current&&!claims)throw fail();
      if(claims){
        if(typeof claims.sub!=="string")throw fail();
        const google=this.definition.adapterKey==="google-calendar-v1";
        if(google&&(typeof claims.email!=="string"||claims.email_verified!==true))throw fail();
        if(!google&&(!z.uuid().safeParse(claims.tid).success&&!this.testMetadata))throw fail();
        const nextSubject=google?claims.sub:`${claims.tid??"fixture"}:${claims.sub}`;
        if(current&&nextSubject!==current.subject)throw fail();
        subject=nextSubject;email=typeof claims.email==="string"?claims.email:typeof claims.preferred_username==="string"?claims.preferred_username:subject;
      }
      granted=[...new Set([...granted,...this.definition.auth.scopes])];
    }else{
      const auth=this.definition.auth,endpoint=this.testMetadata?.introspection_endpoint??auth.introspectionEndpoint;
      const fetcher=createBoundedFetch({authorizeUrl:url=>url.href===endpoint,headers:{"content-type":"application/x-www-form-urlencoded"},maxRequestBytes:16384,maxResponseBytes:65536,maxRequests:1,maxAttempts:1,deadlineAt:Date.now()+15000,testLoopback:!!this.testMetadata,returnProviderErrorResponses:true});
      const responseIdentity=await fetcher(endpoint,{method:"POST",body:new URLSearchParams({client_id:this.config.clientId,client_secret:this.config.clientSecret,token_type_hint:"access_token",token:response.access_token}).toString()});
      if(responseIdentity.status!==200)throw fail();
      const identity=z.object({active:z.literal(true),hub_id:z.number().int().positive(),client_id:z.string(),user:z.string().max(320).optional(),scopes:z.array(z.string().max(256)).max(32)}).parse(await responseIdentity.json());
      if(identity.client_id!==this.config.clientId)throw fail();subject=`hub:${identity.hub_id}`;email=identity.user??`HubSpot ${identity.hub_id}`;granted=identity.scopes;
      if(current&&subject!==current.subject)throw fail();
    }
    if(!scopes.every(scope=>granted.includes(normalize(scope))))throw new PlatformError("PROVIDER_SCOPES_REQUIRED",403,"Required provider permissions were not granted");
    return parseProviderTokens({accessToken:response.access_token,refreshToken:response.refresh_token??current?.refreshToken,expiresAt:new Date(Date.now()+response.expires_in*1000).toISOString(),scopes:granted,subject,email});
  }
  async complete(query:string,attempt:ProviderOAuthAttempt):Promise<ProviderOAuthTokens>{
    try{const isOidc=this.definition.auth.kind==="oidc",response=await oidc.authorizationCodeGrant(await this.configuration(),new URL(this.config.callbackUrl+query),{expectedState:attempt.state,...(isOidc?{pkceCodeVerifier:attempt.verifier,expectedNonce:attempt.nonce,idTokenExpected:true}:{})});
      return await this.tokens(response,attempt.scopes??providerScopes(this.definition,this.definition.operations.map(operation=>operation.id)));
    }catch(error){if(error instanceof PlatformError)throw error;throw fail();}
  }
  async refresh(refreshToken:string,current:ProviderOAuthTokens):Promise<ProviderOAuthTokens>{
    try{return await this.tokens(await oidc.refreshTokenGrant(await this.configuration(),refreshToken),current.scopes,current);}catch{throw new PlatformError("PROVIDER_RECONNECT_REQUIRED",401,"Reconnect the provider account");}
  }
}
