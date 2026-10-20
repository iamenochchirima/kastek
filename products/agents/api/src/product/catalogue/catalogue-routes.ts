import { defaultConnectorRegistry } from "../../adapters/providers/connector-registry";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { PlatformError, type Product } from "../../contracts/contracts";
import type { ActionScope } from "../../contracts/connections";
import type { CapabilityBinding } from "../../contracts/capability-catalog";
import type { AgentRecord } from "../../contracts/records";
import { catalogueQuerySchema, queryCatalogue, type CatalogueSkill, type CatalogueConnection } from "./catalogue";

export interface CatalogueRouteOptions {
  resolveScope(request: FastifyRequest): Promise<ActionScope>;
  getAgent(scope: ActionScope, agentId: string): Promise<Pick<AgentRecord, "id" | "offering" | "draft">>;
  listConnections(scope: ActionScope): Promise<CatalogueConnection[]>;
  listBindings(scope: ActionScope): Promise<CapabilityBinding[]>;
  listSkills?(scope: ActionScope, agentId?: string): Promise<CatalogueSkill[]>;
  permissions(scope: ActionScope): Promise<readonly string[]>;
  product?: Product;
  connectorReadiness?:Record<string,{available:boolean;reasons?:{code:string;message:string}[]}>;
}

export function registerCatalogueRoutes(app: FastifyInstance, options: CatalogueRouteOptions): void {
  app.get(`/api/organizations/:organizationId/connectors`,async request=>{
    const scope=await options.resolveScope(request),organizationId=z.uuid().parse((request.params as Record<string,string>).organizationId);
    if(scope.organizationId!==organizationId)throw new PlatformError("ACCESS_DENIED",403,"Access denied");
    return {connectors:defaultConnectorRegistry.connectors.map(record=>({id:record.id,name:record.name,description:record.description,profileId:record.profileId,setup:record.setup,
      readiness:options.connectorReadiness?.[record.id]??(record.auth.kind==="oidc"?{available:false,reasons:[record.catalogue.unavailable??{code:"CONNECTOR_UNAVAILABLE",message:"This integration is not configured on the server."}]}:{available:true,reasons:[]}),
      ...(record.connectionDefaults?{connectionDefaults:record.connectionDefaults}:{})}))};
  });
  for (const kind of ["tools", "skills"] as const) {
    app.get(`/api/organizations/:organizationId/catalogue/${kind}`, async request => {
      const scope = await options.resolveScope(request);
      const organizationId = z.uuid().parse((request.params as Record<string, string>).organizationId);
      if (organizationId !== scope.organizationId) throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
      const query = catalogueQuerySchema.parse(request.query);
      const agent = query.agentId ? await options.getAgent(scope, query.agentId) : undefined;
      // Purpose describes the scoped agent. A query cannot change its product or offering authority.
      const purpose = agent ? agent.offering ?? "general" : query.purpose ?? "general";
      const [connections, bindings, skills, permissions] = await Promise.all([
        options.listConnections(scope), options.listBindings(scope),
        kind === "skills" ? options.listSkills?.(scope, agent?.id) ?? Promise.resolve([]) : Promise.resolve([]),
        options.permissions(scope),
      ]);
      return queryCatalogue(kind, query, { agentId: agent?.id, configuration: agent?.draft, purpose,
        product: options.product ?? "agents", connections, bindings, skills, permissions, connectorReadiness: options.connectorReadiness });
    });
  }
}
