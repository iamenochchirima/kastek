import { randomUUID } from "node:crypto";
import { GROWTH_AGENT_EXTENSIONS_PATH, isGrowthResourceOperation, parseGrowthAgentCommand, parseProductAgentCommand,
  productAgentGatewayPath, parseProductAgentExtension, type GrowthAgentActor, type GrowthAgentCommand, type GrowthAgentCommandInputs,
  type GrowthAgentCommandOperation, type GrowthAgentCommandOutputs, type ProductAgentInputs, type ProductAgentOperation } from "@kasitek-labs/contracts";
import type { CoreConfig } from "../config.js";
import { ApiError } from "../error.js";
import { outboundTraceHeaders } from "../observability/context.js";
import { providerSpan } from "../observability/operations.js";
import { growthAgentApiUrl, signGrowthAgentCommand } from "./security.js";
import { growthAgentPublication } from "./manifest.js";
export interface GrowthAgentTransport { fetch?: typeof fetch }

/** Shared gateway operations return the same projections the Growth routes already expose. */
export interface SharedAgentOutputs {
  "conversations.create": GrowthAgentCommandOutputs["conversations.create"];
  "conversations.get": GrowthAgentCommandOutputs["conversations.get"];
  "conversations.list": GrowthAgentCommandOutputs["conversations.list"];
  "conversations.context": GrowthAgentCommandOutputs["conversations.context"];
  "runs.start": GrowthAgentCommandOutputs["turns.submit"];
  "runs.get": GrowthAgentCommandOutputs["tasks.get"];
  "runs.list": GrowthAgentCommandOutputs["tasks.list"];
  "runs.activity": GrowthAgentCommandOutputs["tasks.observe"];
  "runs.events": GrowthAgentCommandOutputs["tasks.events"];
  "runs.steer": GrowthAgentCommandOutputs["tasks.instructions"];
  "runs.cancel": GrowthAgentCommandOutputs["tasks.cancel"];
  "runs.continue": GrowthAgentCommandOutputs["tasks.continue"];
  "reviews.list": GrowthAgentCommandOutputs["reviews.list"];
  "reviews.decide": GrowthAgentCommandOutputs["reviews.decide"];
  "artifacts.list": GrowthAgentCommandOutputs["artifacts.list"];
  "artifacts.get": GrowthAgentCommandOutputs["artifacts.get"];
  "tasks.export": GrowthAgentCommandOutputs["tasks.export"];
  "models.list": GrowthAgentCommandOutputs["models.list"];
  "models.select": GrowthAgentCommandOutputs["models.select"];
}
export type SharedAgentOperation = keyof SharedAgentOutputs;

export class GrowthAgentClient {
  private readonly publications=new Map<string,Promise<void>>();
  constructor(private readonly config: CoreConfig, private readonly transport: GrowthAgentTransport = {}) {}
  configured(): boolean { return Boolean(growthAgentApiUrl(this.config) && this.config.env.GROWTH_AGENTS_SIGNING_PRIVATE_KEY); }
  async command<K extends GrowthAgentCommandOperation>(scope: { tenantId: string; actor: GrowthAgentActor }, operation: K,
    input: GrowthAgentCommandInputs[K], requestId: string = randomUUID()): Promise<GrowthAgentCommandOutputs[K]> {
    if(operation==="features.list"){
      const result=await this.send(scope,operation,{...input,publication:growthAgentPublication} as GrowthAgentCommandInputs[K],requestId);
      this.publications.set(scope.tenantId,Promise.resolve());return result;
    }
    if(operation==="turns.submit"||operation==="conversations.create"||operation==="features.configure"||operation==="features.profile"||operation.startsWith("models.")||operation.startsWith("memory.")||isGrowthResourceOperation(operation)){
      await this.ensurePublication(scope);
    }
    return this.send(scope,operation,input,requestId);
  }
  /** Sends a shared operation through the product agent gateway. */
  async shared<K extends SharedAgentOperation>(scope: { tenantId: string; actor: GrowthAgentActor }, operation: K,
    input: ProductAgentInputs[K], requestId: string = randomUUID()): Promise<SharedAgentOutputs[K]> {
    if(operation==="conversations.create"||operation==="runs.start") await this.ensurePublication(scope);
    const body=parseProductAgentCommand(JSON.parse(JSON.stringify({version:"1",requestId,product:"growth",tenantId:scope.tenantId,actor:scope.actor,operation,input})));
    return await this.request(productAgentGatewayPath("growth"),body,requestId) as SharedAgentOutputs[K];
  }
  private async ensurePublication(scope:{tenantId:string;actor:GrowthAgentActor}):Promise<void>{
    let published=this.publications.get(scope.tenantId);
    if(!published){published=this.send(scope,"features.list",{publication:growthAgentPublication},randomUUID()).then(()=>{});this.publications.set(scope.tenantId,published);}
    try{await published;}catch(error){if(this.publications.get(scope.tenantId)===published)this.publications.delete(scope.tenantId);throw error;}
  }
  private async send<K extends GrowthAgentCommandOperation>(scope:{tenantId:string;actor:GrowthAgentActor},operation:K,input:GrowthAgentCommandInputs[K],requestId:string):Promise<GrowthAgentCommandOutputs[K]>{
    const command = parseGrowthAgentCommand(JSON.parse(JSON.stringify({ version: "1", requestId, ...scope, operation, input }))) as GrowthAgentCommand;
    const body = parseProductAgentExtension({ version: "1", requestId, product: "growth", tenantId: scope.tenantId, actor: scope.actor,
      operation: `growth.${operation}`, input: command.input });
    return await this.request(GROWTH_AGENT_EXTENSIONS_PATH,body,requestId) as GrowthAgentCommandOutputs[K];
  }
  private async request(path:string,body:unknown,requestId:string):Promise<unknown>{
    const base = growthAgentApiUrl(this.config);
    if (!base) throw new ApiError(503, "agent_service_unavailable", "Agents is not configured");
    const token = await signGrowthAgentCommand(this.config, body);
    let response: Response;
    try {
      response = await providerSpan("kasitek-agents", "http.request", () => {
        const traceHeaders = outboundTraceHeaders();
        return (this.transport.fetch ?? fetch)(base + path, {
          method: "POST", headers: { ...traceHeaders, authorization: `Bearer ${token}`, "content-type": "application/json",
            "x-correlation-id": traceHeaders["x-correlation-id"] ?? requestId },
          body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: "error",
        });
      });
    } catch { throw new ApiError(503, "agent_service_unavailable", "Agents is temporarily unavailable"); }
    const text = await response.text();
    if (Buffer.byteLength(text) > 2097152) throw new ApiError(502, "agent_response_invalid", "Agent response is unavailable");
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new ApiError(502, "agent_response_invalid", "Agent response is unavailable"); }
    if (!response.ok) {
      const error = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const detail=error.error&&typeof error.error==="object"&&!Array.isArray(error.error)?error.error as Record<string,unknown>:error;
      throw new ApiError(response.status >= 500 ? 503 : response.status,
        typeof detail.code === "string" ? detail.code : "agent_request_failed",
        typeof detail.message === "string" ? detail.message : typeof error.error === "string" ? error.error : "Agent request could not be completed");
    }
    return value;
  }
}
