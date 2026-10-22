import {describe,it,expect} from "vitest";
import defaults from "../src/adapters/providers/default-connectors.json";
import {connectorConfiguration,connectorExecutionDigest,defaultConnectorRegistry,googleCalendarConnector,loadConnectorRegistry} from "../src/adapters/providers/connector-registry";
import {GoogleCalendarOAuth,googleOAuthConfigFromEnvironment,GOOGLE_CALENDAR_SCOPES} from "../src/product/connections/google-calendar-oauth";
const copy=()=>JSON.parse(JSON.stringify(defaults));
describe("versioned installed connector configurations",()=>{
 it("loads immutable JSON records through the same future database snapshot boundary",()=>{
   expect(loadConnectorRegistry(JSON.stringify(defaults))).toEqual(defaultConnectorRegistry);expect(defaultConnectorRegistry.connectors.map(record=>record.id)).toEqual(["google-calendar","microsoft-calendar","hubspot","github","stash","deepwiki"]);
   expect(Object.isFrozen(defaultConnectorRegistry.connectors[0]!.auth)).toBe(true);expect(Object.isFrozen(googleCalendarConnector.auth.scopes)).toBe(true);expect(GOOGLE_CALENDAR_SCOPES).toEqual([...new Set([...googleCalendarConnector.auth.scopes,...googleCalendarConnector.operations.flatMap(operation=>operation.scopes)])]);
   expect(()=>connectorConfiguration("missing")).toThrow();
 });
 it("accepts additional metadata records only for already installed compatible handlers",()=>{
   const input=copy();input.connectors.push({...input.connectors.find((record:any)=>record.id==="github"),id:"project-api",profileId:"custom-api-v1",adapterKey:"native-api",auth:{kind:"connection_defined"},apiBaseUrl:"https://api.example.com"});
   input.connectors.push({...input.connectors.find((record:any)=>record.id==="stash"),id:"project-mcp",profileId:"remote-mcp-v1",adapterKey:"remote-mcp",connectionDefaults:{endpoint:"https://mcp.example.com/mcp",authentication:"oauth"}});
   expect(loadConnectorRegistry(input).connectors).toHaveLength(defaults.connectors.length+2);
   input.connectors.at(-1).adapterKey="arbitrary-plugin";expect(()=>loadConnectorRegistry(input)).toThrow("installed compatible handler");
 });
 it.each(["http://accounts.google.com","https://localhost","https://localhost.","https://127.0.0.1","https://0x7f000001","https://[::1]","https://provider.internal","https://user:secret@accounts.google.com","https://accounts.google.com?secret=token","https://accounts.google.com/#token","file:///etc/passwd"])("rejects unsafe fixed endpoint %s",endpoint=>{
   const input=copy();input.connectors[0].auth.tokenEndpoint=endpoint;expect(()=>loadConnectorRegistry(input)).toThrow();
 });
 it("rejects duplicates, unsupported versions, handler/profile mismatch, executable fields and literal secrets",()=>{
   const duplicate=copy();duplicate.connectors.push(duplicate.connectors[0]);expect(()=>loadConnectorRegistry(duplicate)).toThrow("unique");
   const unknown=copy();unknown.schemaVersion=2;expect(()=>loadConnectorRegistry(unknown)).toThrow();
   const mismatch=copy();mismatch.connectors[0].profileId="custom-api-v1";expect(()=>loadConnectorRegistry(mismatch)).toThrow();
   for(const field of ["module","script","clientSecret"]){const input=copy();input.connectors[0][field]="secret-or-code";expect(()=>loadConnectorRegistry(input)).toThrow();}
   const auth=copy();auth.connectors[0].auth.environment.clientSecret="literal-secret";expect(()=>loadConnectorRegistry(auth)).toThrow();
   const path=copy();path.connectors[0].setup.apiPath="../arbitrary";expect(()=>loadConnectorRegistry(path)).toThrow();
   expect(()=>loadConnectorRegistry(" ".repeat(262145))).toThrow("byte limit");
 });
 it("changes execution authority for transport/auth edits while display edits preserve it",()=>{
   const original=connectorExecutionDigest(googleCalendarConnector),display=copy();Object.assign(display.connectors[0],{name:"Calendar display",description:"Updated description",revision:2});
   expect(connectorExecutionDigest(loadConnectorRegistry(display).connectors[0]!)).toBe(original);
   for(const change of [(record:any)=>{record.auth.issuer="https://identity.example.com";},(record:any)=>{record.auth.scopes.push("https://www.googleapis.com/auth/calendar.readonly");},(record:any)=>{record.apiBaseUrl="https://api.example.com/calendar";},(record:any)=>{record.auth.environment.clientId="ANOTHER_CLIENT_ID";}]){const input=copy();change(input.connectors[0]);expect(connectorExecutionDigest(loadConnectorRegistry(input).connectors[0]!)).not.toBe(original);}
 });
 it("pins actual OAuth client identity without exposing or hashing secret text into connector records",()=>{
   const base={clientId:"client-one",clientSecret:"private-secret-one",callbackUrl:"https://agents.example.com/api/google-calendar/callback",appUrl:"https://agents.example.com"};
   const first=new GoogleCalendarOAuth(base),rotated=new GoogleCalendarOAuth({...base,clientSecret:"private-secret-two"}),changed=new GoogleCalendarOAuth({...base,clientId:"client-two"});
   expect(first.configurationDigest).toBe(rotated.configurationDigest);expect(first.configurationDigest).not.toBe(changed.configurationDigest);expect(JSON.stringify(defaultConnectorRegistry)).not.toContain("private-secret");
   const refs=googleCalendarConnector.auth.environment;expect(googleOAuthConfigFromEnvironment({NODE_ENV:"production",[refs.clientId]:"client",[refs.clientSecret]:"secret",[refs.callbackUrl]:base.callbackUrl,AGENTS_PUBLIC_URL:base.appUrl})).toMatchObject({clientId:"client",callbackUrl:base.callbackUrl});
 });
});
