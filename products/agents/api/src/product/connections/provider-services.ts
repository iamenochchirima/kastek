import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { nativeProviderConnectors } from "../../adapters/providers/connector-registry";
import type { ActionScope,ConnectionCredentialPort } from "../../contracts/connections";
import { PlatformError } from "../../contracts/contracts";
import type { ConnectionVault } from "../../infrastructure/vault";
import { ProviderConnectionStore } from "./provider-connections";
import { NativeProviderOAuth,providerOAuthConfigFromEnvironment,type ProviderOAuthPort } from "./provider-oauth";

export class ProviderServices {
  readonly stores:ReadonlyMap<string,ProviderConnectionStore>;
  constructor(readonly pool:Pool,vault:ConnectionVault|undefined,options:{appUrl:string;environment?:NodeJS.ProcessEnv;tests?:Record<string,{oauth?:ProviderOAuthPort;testApiBaseUrl?:string}>}){
    this.stores=new Map(nativeProviderConnectors.map(definition=>{
      const config=providerOAuthConfigFromEnvironment(definition,{...options.environment??process.env,AGENTS_PUBLIC_URL:options.appUrl}),test=options.tests?.[definition.id];
      return [definition.id,new ProviderConnectionStore(pool,vault,{definition,appUrl:options.appUrl,oauth:test?.oauth??(config?new NativeProviderOAuth(definition,config):undefined),testApiBaseUrl:test?.testApiBaseUrl})];
    }));
  }
  store(id:string){const store=this.stores.get(id);if(!store)throw new PlatformError("PROVIDER_NOT_FOUND",404,"Provider not found");return store;}
  readiness(){return Object.fromEntries([...this.stores].map(([id,store])=>[id,store.providerStatus()]));}
  async forConnection(scope:ActionScope,id:string,db:Pool|PoolClient=this.pool){
    z.uuid().parse(id);const row=(await db.query("SELECT p.provider_id FROM agents_platform.native_provider_connections p JOIN agents_platform.connections c ON c.id=p.connection_id WHERE c.id=$1 AND c.organization_id=$2 AND c.account_id=$3",[id,scope.organizationId,scope.accountId])).rows[0];
    return row?this.store(row.provider_id):undefined;
  }
  async ensureFresh(scope:ActionScope,id:string){const store=await this.forConnection(scope,id);if(!store)throw new PlatformError("PROVIDER_CONNECTION_NOT_FOUND",404,"Provider connection not found");await store.ensureCredentialFresh(scope,id);}
  async resolveCalendar(db:PoolClient,scope:ActionScope,id:string,policyRevision:number,options:{requireOrganizationService:boolean;operation?:"calendar.availability"|"calendar.book"}){const store=await this.forConnection(scope,id,db);if(!store)throw new PlatformError("PROVIDER_CONNECTION_NOT_FOUND",404,"Provider connection not found");return store.resolveBookingCalendar(db,scope,id,policyRevision,options);}
  credentials(fallback:ConnectionCredentialPort):ConnectionCredentialPort {return {resolveCredential:async(db,scope,id,revision)=>{const store=await this.forConnection(scope,id,db);return store?store.resolveCredential(db,scope,id,revision):fallback.resolveCredential(db,scope,id,revision);}};}
  async catalogueConnections(scope:ActionScope){
    if(!(await this.pool.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL",[scope.organizationId,scope.accountId])).rowCount)return [];
    return (await Promise.all([...this.stores.values()].map(store=>store.catalogueConnections(scope)))).flat();
  }
  async calendars(scope:ActionScope){return (await Promise.all([...this.stores.values()].filter(store=>store.definition.setup?.kind==="calendar_service").map(async store=>(await store.list(scope)).map(connection=>({...connection,providerName:store.definition.name}))))).flat();}
}
