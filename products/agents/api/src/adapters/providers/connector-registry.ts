import {isIP} from "node:net";
import {z} from "zod";
import defaults from "./default-connectors.json";
import {PlatformError,executionKindSchema,productSchema,requestDigest} from "../../contracts/contracts";

const identifier=z.string().min(1).max(100).regex(/^[a-z][a-z0-9_.-]*$/);
const label=z.string().trim().min(1).max(2048).refine(value=>!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
const httpsEndpoint=z.string().min(1).max(2048).refine(value=>{
  try{
    const url=new URL(value),host=url.hostname.toLowerCase().replace(/\.$/,"");
    return url.protocol==="https:"&&!url.username&&!url.password&&!/[?#\x00-\x20\x7f]/.test(value)
      &&!value.match(/^https:\/\/[^/]*@/i)&&host.includes(".")&&!isIP(host.replace(/^\[|\]$/g,""))
      &&!["localhost","local","internal"].some(suffix=>host===suffix||host.endsWith(`.${suffix}`));
  }catch{return false;}
},"Connector endpoints must be fixed public HTTPS URLs without credentials or query parameters");
const environmentKey=z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/);
const uniqueIdentifiers=z.array(identifier).min(1).max(32).refine(values=>new Set(values).size===values.length);
const oidcSchema=z.strictObject({
  kind:z.literal("oidc"),issuer:httpsEndpoint,authorizationEndpoint:httpsEndpoint,tokenEndpoint:httpsEndpoint,jwksUri:httpsEndpoint,
  scopes:z.array(z.string().min(1).max(256).regex(/^[^\s\x00-\x1f\x7f]+$/)).min(1).max(32).refine(values=>new Set(values).size===values.length),
  callbackPath:z.string().min(1).max(256).regex(/^\/api\/[a-z0-9/-]+$/).refine(value=>!value.includes("//")&&!value.endsWith("/")),
  environment:z.strictObject({clientId:environmentKey,clientSecret:environmentKey,callbackUrl:environmentKey}),
});
const oauthSchema=z.strictObject({
  kind:z.literal("oauth2"),authorizationEndpoint:httpsEndpoint,tokenEndpoint:httpsEndpoint,introspectionEndpoint:httpsEndpoint,
  scopes:z.array(z.string().min(1).max(256).regex(/^[^\s\x00-\x1f\x7f]+$/)).max(32),
  callbackPath:z.string().regex(/^\/api\/[a-z0-9/-]+$/),
  environment:z.strictObject({clientId:environmentKey,clientSecret:environmentKey,callbackUrl:environmentKey}),
});
const operationSchema=z.strictObject({id:identifier,name:label,description:label,effect:z.enum(["read","reviewed_write"]),scopes:z.array(z.string().min(1).max(256)).min(1).max(8)});
const reason=z.strictObject({code:z.string().min(1).max(100).regex(/^[A-Z][A-Z0-9_]*$/),message:label});
const catalogueSchema=z.strictObject({
  purposes:uniqueIdentifiers,products:z.array(productSchema).min(1).max(3).refine(values=>new Set(values).size===values.length),
  executionKinds:z.array(executionKindSchema).min(1).max(2).refine(values=>new Set(values).size===values.length),permissions:uniqueIdentifiers,
  selection:z.discriminatedUnion("kind",[z.strictObject({kind:z.literal("bindings")}),z.strictObject({kind:z.literal("capability"),capability:z.literal("businessActions"),profileId:identifier,setup:z.literal("booking")})]),
  configurationRequired:reason.optional(),unavailable:reason.optional(),
});
export const connectorConfigurationSchema=z.strictObject({
  id:identifier,revision:z.number().int().positive().max(2147483647),profileId:identifier,adapterKey:identifier,kind:z.enum(["mcp","native_api"]),
  name:label,description:label,publisher:z.strictObject({id:identifier,name:label,verified:z.boolean()}),
  auth:z.discriminatedUnion("kind",[oidcSchema,oauthSchema,z.strictObject({kind:z.literal("connection_defined")}),z.strictObject({kind:z.literal("none")})]),
  apiBaseUrl:httpsEndpoint.optional(),catalogue:catalogueSchema,
  operations:z.array(operationSchema).min(1).max(8).refine(items=>new Set(items.map(item=>item.id)).size===items.length).optional(),
  setup:z.discriminatedUnion("kind",[z.strictObject({kind:z.literal("calendar_service"),apiPath:identifier,identityLabel:label}),z.strictObject({kind:z.literal("crm_service"),apiPath:identifier,identityLabel:label}),z.strictObject({kind:z.literal("existing_connections")})]).optional(),
  connectionDefaults:z.strictObject({endpoint:httpsEndpoint,authentication:z.enum(["auto","none","oauth","bearer","header"])}).optional(),
});
export type ConnectorConfiguration=z.infer<typeof connectorConfigurationSchema>;
export type OidcConnectorConfiguration=ConnectorConfiguration&{auth:z.infer<typeof oidcSchema>;apiBaseUrl:string};
export type NativeConnectorConfiguration=ConnectorConfiguration&{auth:z.infer<typeof oidcSchema>|z.infer<typeof oauthSchema>;apiBaseUrl:string;operations:z.infer<typeof operationSchema>[]};
export interface ConnectorRegistry {readonly schemaVersion:1;readonly connectors:readonly ConnectorConfiguration[]}
// Configuration selects installed handlers; it never supplies executable code or imports a module.
const handlers:Readonly<Record<string,{profileId:string;kind:ConnectorConfiguration["kind"]}>>=Object.freeze({
  "google-calendar-v1":{profileId:"google-calendar-v1",kind:"native_api"},
  "microsoft-calendar-v1":{profileId:"microsoft-calendar-v1",kind:"native_api"},
  "hubspot-contacts-v1":{profileId:"hubspot-contacts-v1",kind:"native_api"},
  "github-native-read":{profileId:"github-public-read-v1",kind:"native_api"},
  "github-mcp-read":{profileId:"github-public-read-v1",kind:"mcp"},
  "stash-mcp-read":{profileId:"stash-read-v1",kind:"mcp"},
  "deepwiki-mcp-read":{profileId:"public-repository-read-v1",kind:"mcp"},
  "remote-mcp":{profileId:"remote-mcp-v1",kind:"mcp"},"native-api":{profileId:"custom-api-v1",kind:"native_api"},
});
function immutable<T>(value:T):T {
  if(value&&typeof value==="object"){for(const child of Object.values(value))immutable(child);Object.freeze(value);}return value;
}
/** Same bounded validation boundary accepts bundled JSON now and an explicit database snapshot later. */
export function loadConnectorRegistry(data:unknown):ConnectorRegistry {
  let input:unknown=data;
  if(typeof input==="string"){
    if(Buffer.byteLength(input)>262144)throw new PlatformError("CONNECTOR_CONFIGURATION_INVALID",400,"Connector configuration exceeds its byte limit");
    try{input=JSON.parse(input);}catch{throw new PlatformError("CONNECTOR_CONFIGURATION_INVALID",400,"Connector configuration must be valid JSON");}
  }
  const parsed=z.strictObject({schemaVersion:z.literal(1),connectors:z.array(connectorConfigurationSchema).min(1).max(64)}).safeParse(input);
  if(!parsed.success)throw new PlatformError("CONNECTOR_CONFIGURATION_INVALID",400,"Connector configuration does not match the supported record schema");
  if(Buffer.byteLength(JSON.stringify(parsed.data))>262144)throw new PlatformError("CONNECTOR_CONFIGURATION_INVALID",400,"Connector configuration exceeds its byte limit");
  const ids=new Set<string>();
  for(const record of parsed.data.connectors){
    if(ids.has(record.id))throw new PlatformError("CONNECTOR_CONFIGURATION_INVALID",400,"Connector identities must be unique");ids.add(record.id);
    const handler=Object.hasOwn(handlers,record.adapterKey)?handlers[record.adapterKey]:undefined;
    if(!handler||handler.profileId!==record.profileId||handler.kind!==record.kind)throw new PlatformError("CONNECTOR_HANDLER_UNAVAILABLE",400,"Connector configuration requires an installed compatible handler");
    const calendar=["google-calendar-v1","microsoft-calendar-v1"].includes(record.adapterKey),crm=record.adapterKey==="hubspot-contacts-v1",native=calendar||crm;
    if(calendar&&(record.catalogue.selection.kind!=="capability"||record.auth.kind!=="oidc"||!record.apiBaseUrl||!record.auth.scopes.includes("openid")||!record.auth.scopes.includes("email")))throw new PlatformError("CONNECTOR_CONFIGURATION_INVALID",400,"The installed calendar handler requires OIDC identity and fixed API configuration");
    if(crm&&(record.auth.kind!=="oauth2"||!record.apiBaseUrl||record.catalogue.selection.kind!=="bindings"||record.setup?.kind!=="crm_service"))throw new PlatformError("CONNECTOR_CONFIGURATION_INVALID",400,"CRM setup requires its installed OAuth handler");
    const allowed=calendar?["calendar.availability","calendar.book"]:crm?["contacts.search","contacts.create"]:[];
    if(native&&(!record.operations||record.operations.some(operation=>!allowed.includes(operation.id)||operation.effect!==(operation.id.endsWith(".book")||operation.id.endsWith(".create")?"reviewed_write":"read"))))throw new PlatformError("CONNECTOR_CONFIGURATION_INVALID",400,"Provider operations must match the installed handler");
    if(record.connectionDefaults&&record.adapterKey!=="remote-mcp")throw new PlatformError("CONNECTOR_HANDLER_UNAVAILABLE",400,"Connection defaults require the installed configurable MCP handler");
    if(record.setup?.kind==="calendar_service"&&!calendar)throw new PlatformError("CONNECTOR_HANDLER_UNAVAILABLE",400,"Calendar setup requires its installed handler");
    if(!native&&(record.auth.kind==="oidc"||record.auth.kind==="oauth2"||record.catalogue.selection.kind!=="bindings"||record.operations))throw new PlatformError("CONNECTOR_HANDLER_UNAVAILABLE",400,"This installed handler does not support the requested authentication or capability setup");
    if(record.catalogue.selection.kind==="capability"&&record.catalogue.selection.profileId!=="calendar-booking-v1")throw new PlatformError("CONNECTOR_HANDLER_UNAVAILABLE",400,"The capability setup requires an installed profile");
  }
  return immutable(parsed.data);
}
export const defaultConnectorRegistry=loadConnectorRegistry(defaults);
export function connectorConfiguration(id:string,registry:ConnectorRegistry=defaultConnectorRegistry):ConnectorConfiguration {
  const found=registry.connectors.find(record=>record.id===id);
  if(!found)throw new PlatformError("CONNECTOR_CONFIGURATION_UNAVAILABLE",404,"Connector configuration is unavailable");return found;
}
export const googleCalendarConnector=connectorConfiguration("google-calendar") as OidcConnectorConfiguration;
export const nativeProviderConnectors=defaultConnectorRegistry.connectors.filter((record):record is NativeConnectorConfiguration=>record.auth.kind==="oidc"||record.auth.kind==="oauth2");

/** Display edits do not change credential authority; transport and auth edits do. */
export function connectorExecutionDigest(record:ConnectorConfiguration):string {
  return requestDigest({id:record.id,profileId:record.profileId,adapterKey:record.adapterKey,auth:record.auth,
    apiBaseUrl:record.apiBaseUrl??null,operations:record.operations??null,connectionDefaults:record.connectionDefaults??null,selection:record.catalogue.selection});
}
export const googleCalendarConnectorDigest=connectorExecutionDigest(googleCalendarConnector);
