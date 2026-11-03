import { createHash } from "node:crypto";
import { z } from "zod";
import { PlatformError,requestDigest } from "./contracts";
import { productInformationEnvelopeSchema } from "./product-information";

const id = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z.number().int().positive();
export const SOURCE_LIMITS = Object.freeze({ rawBytes: 10_485_760, textBytes: 1_048_576, pages: 200,
  chunks: 1000, organizationSources: 200, organizationChunks: 100_000, versionSources: 20,
  concurrentImports: 2, importWallMs: 600_000, manifestNodes: 1024 });

export const sourceSchema = z.strictObject({
  id, organizationId: id, importerAccountId: id.nullable(), importerService: z.strictObject({ product: z.literal("growth"), tenantId: z.string().min(1).max(256), agentId: id,
    actor: z.strictObject({ issuer: z.url().max(2048), subject: z.string().min(1).max(512) }), service: z.strictObject({ issuer: z.url().max(2048), clientId: z.string().min(1).max(128) }) }).optional(), title: z.string().trim().min(1).max(200),
  kind: z.enum(["upload", "public_url", "provider_snapshot"]), generation,
  state: z.enum(["active", "withdrawn"]), visibility: z.enum(["private", "public"]),
  createdAt: z.iso.datetime(),
}).refine(value => value.importerAccountId !== null ? value.importerService === undefined : value.importerService !== undefined, "A source requires one importer identity");
export const ingestionJobSchema = z.strictObject({
  id, sourceId: id, revisionId: id, revision: generation, acceptedGeneration: generation,
  state: z.enum(["queued", "acquiring", "extracting", "indexing", "ready", "failed", "cancelled"]),
  parserRelease: z.string().min(1).max(128), deadline: z.iso.datetime(),
});
export const sealedSourceRevisionSchema = z.strictObject({
  id, sourceId: id, organizationId: id, revision: generation,
  rawDigest: digest, textDigest: digest, chunkSetDigest: digest,
  rawBytes: z.number().int().positive().max(SOURCE_LIMITS.rawBytes),
  textBytes: z.number().int().positive().max(SOURCE_LIMITS.textBytes),
  chunkCount: z.number().int().positive().max(SOURCE_LIMITS.chunks),
  parserRelease: z.string().min(1).max(128), normalizerRelease: z.string().min(1).max(128),
  embeddingRelease: z.string().min(1).max(256).nullable(), embeddingDigest: digest.nullable(), acquiredAt: z.iso.datetime(), sealedAt: z.iso.datetime(),
});
export const sourceChunkSchema = z.strictObject({
  id, revisionId: id, ordinal: z.number().int().nonnegative().max(SOURCE_LIMITS.chunks - 1),
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
  page: z.number().int().positive().max(SOURCE_LIMITS.pages).nullable(),
  section: z.string().max(256).nullable(), text: z.string().min(1).max(SOURCE_LIMITS.textBytes), digest,
  tokens: z.number().int().positive().max(512),
}).superRefine((chunk, context) => {
  if (chunk.end - chunk.start !== chunk.text.length) context.addIssue({ code: "custom", message: "Chunk offsets must describe UTF-16 text units" });
  if (textDigest(chunk.text) !== chunk.digest) context.addIssue({ code: "custom", message: "Chunk digest does not match its text" });
});

const sourceDependency = z.strictObject({ kind: z.literal("source"), sourceId: id, revisionId: id, generation, visibility: z.enum(["private", "public"]) });
const connectionDependency = z.strictObject({ kind: z.literal("connection"), connectionId: id, policyRevision: generation,
  resource: z.string().min(1).max(2048), catalogDigest: digest });
const memoryTransition = z.strictObject({ memoryId: id, memoryRevision: generation });
const delegationDependency = z.strictObject({kind:z.literal("delegation_input"),referenceId:id,manifestDigest:digest,memoryTransition:memoryTransition.optional()});
const artifactDependency = z.strictObject({kind:z.literal("artifact"),referenceId:id,contentDigest:digest});
const memoryDependency = z.strictObject({ kind: z.literal("memory"), referenceId: id, generation,
  memoryId: id.optional(), memoryRevision: generation.optional() }).refine(value =>
  (value.memoryId === undefined) === (value.memoryRevision === undefined) && (value.memoryRevision === undefined || value.generation === value.memoryRevision),
  "Exact memory dependencies use the record revision as their generation");
const productDependency = z.strictObject({ kind: z.literal("product"), product: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/),
  tenantId: z.string().min(1).max(256), taskId: id, contextRevision: digest,bindingId:id.optional(),bindingDigest:digest.optional(), sourceId: z.string().min(1).max(1024),
  information: productInformationEnvelopeSchema.optional(), memoryTransition: memoryTransition.optional() });
const productAccessDependency = z.strictObject({ kind: z.literal("product_access"), product: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/),
  tenantId: z.string().min(1).max(256), taskId: id, bindingId: id, bindingDigest: digest,
  reference: z.string().min(1).max(1024), information: productInformationEnvelopeSchema,
  memoryTransition: memoryTransition.optional() });
const productContextDependency = z.strictObject({ kind: z.literal("product_context"), product: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/),
  tenantId: z.string().min(1).max(256), taskId: id, referenceDigest: digest, information: productInformationEnvelopeSchema, memoryTransition: memoryTransition.optional() });
const productArtifactDependency = z.strictObject({ kind: z.literal("product_artifact"), version: z.literal("1"), product: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/),
  tenantId: z.string().min(1).max(256), taskId: id, artifactId: id, contentDigest: digest,
  name: z.string().min(1).max(120), contentType: z.string().min(1).max(128), bytes: z.number().int().nonnegative().max(1048576),
  information: productInformationEnvelopeSchema, memoryTransition: memoryTransition.optional() });
export const evidenceDependencySchema = z.discriminatedUnion("kind", [productDependency, productAccessDependency, productContextDependency, productArtifactDependency, sourceDependency, connectionDependency, memoryDependency, delegationDependency, artifactDependency, z.strictObject({kind:z.literal("skill"),skillId:id,agentId:id,packageDigest:digest})]);
export const dependencyManifestSchema = z.strictObject({ version: z.literal(1), dependencies: z.array(evidenceDependencySchema).max(SOURCE_LIMITS.manifestNodes), digest });
export const evidenceReferenceSchema = z.strictObject({
  id, organizationId: id, rootTaskId: id, operationId: z.string().min(1).max(256),
  sourceId: id.nullable(), revisionId: id.nullable(), chunkId: id.nullable(),
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
  contentDigest: digest, acquiredAt: z.iso.datetime(), manifest: dependencyManifestSchema,
}).superRefine((reference, context) => {
  if (reference.end <= reference.start) context.addIssue({ code: "custom", message: "Evidence span must be nonempty" });
  if ((reference.sourceId === null) !== (reference.revisionId === null) || reference.chunkId !== null && reference.revisionId === null) {
    context.addIssue({ code: "custom", message: "Evidence source identity is incomplete" });
  }
  if (reference.manifest.dependencies.length === 0) context.addIssue({ code: "custom", message: "Evidence must declare its dependencies" });
});

export type Source = z.infer<typeof sourceSchema>;
export type IngestionJob = z.infer<typeof ingestionJobSchema>;
export type SourceRevision = z.infer<typeof sealedSourceRevisionSchema>;
export type SourceChunk = z.infer<typeof sourceChunkSchema>;
export type EvidenceDependency = z.infer<typeof evidenceDependencySchema>;
export type DependencyManifest = z.infer<typeof dependencyManifestSchema>;
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export const textDigest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function dependencyKey(dependency: EvidenceDependency): string {
  switch (dependency.kind) {
    case "product": return `product:${dependency.product}:${dependency.tenantId}:${dependency.taskId}:${dependency.bindingId??""}:${dependency.sourceId}:${dependency.memoryTransition ? `${dependency.memoryTransition.memoryId}:${dependency.memoryTransition.memoryRevision}` : ""}`;
    case "product_access": return `product_access:${dependency.product}:${dependency.tenantId}:${dependency.taskId}:${dependency.bindingId}:${dependency.reference}:${requestDigest(dependency.information)}:${dependency.memoryTransition ? `${dependency.memoryTransition.memoryId}:${dependency.memoryTransition.memoryRevision}` : ""}`;
    case "product_context": return `product_context:${dependency.product}:${dependency.tenantId}:${dependency.taskId}:${dependency.memoryTransition ? `${dependency.memoryTransition.memoryId}:${dependency.memoryTransition.memoryRevision}` : ""}`;
    case "product_artifact": return `product_artifact:${dependency.product}:${dependency.tenantId}:${dependency.taskId}:${dependency.artifactId}:${dependency.memoryTransition ? `${dependency.memoryTransition.memoryId}:${dependency.memoryTransition.memoryRevision}` : ""}`;
    case "skill": return `skill:${dependency.agentId}:${dependency.skillId}`;
    case "source": return `source:${dependency.sourceId}:${dependency.revisionId}`;
    case "connection": return `connection:${dependency.connectionId}:${dependency.resource}:${dependency.catalogDigest}`;
    case "memory": return `memory:${dependency.referenceId}:${dependency.memoryId ?? ""}`;
    case "delegation_input": return `delegation_input:${dependency.referenceId}:${dependency.memoryTransition ? `${dependency.memoryTransition.memoryId}:${dependency.memoryTransition.memoryRevision}` : ""}`;
    case "artifact": return `artifact:${dependency.referenceId}`;
  }
}
export function createDependencyManifest(inputs: readonly EvidenceDependency[]): DependencyManifest {
  const unique = new Map<string, EvidenceDependency>();
  for (const input of inputs) {
    const dependency = evidenceDependencySchema.parse(input), key = dependencyKey(dependency), prior = unique.get(key);
    if (prior && requestDigest(prior) !== requestDigest(dependency)) throw new PlatformError("EVIDENCE_POLICY_CONFLICT", 409, "Evidence policy changed during execution");
    unique.set(key, dependency);
    if (unique.size > SOURCE_LIMITS.manifestNodes) throw new PlatformError("EVIDENCE_LIMIT", 413, "Too many evidence dependencies");
  }
  const dependencies = [...unique.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
  return { version: 1, dependencies, digest: requestDigest({ version: 1, dependencies }) };
}
export function assertDependencyManifest(value: unknown): DependencyManifest {
  const manifest = dependencyManifestSchema.parse(value), canonical = createDependencyManifest(manifest.dependencies);
  if (canonical.digest !== manifest.digest || requestDigest(canonical.dependencies) !== requestDigest(manifest.dependencies)) {
    throw new PlatformError("EVIDENCE_INTEGRITY", 409, "Evidence dependencies are invalid");
  }
  return manifest;
}

export interface DependencyNode { id: string; manifest: DependencyManifest; parents: readonly string[] }
function inspectDependencyGraph(rootIds:readonly string[],nodes:ReadonlyMap<string,DependencyNode>) {
  const visiting=new Set<string>(),visited=new Set<string>(),referenced=new Set<string>(),dependencies=new Map<string,EvidenceDependency>();
  const pending=[...rootIds].reverse().map(id=>({id,exit:false}));
  while(pending.length){
    const entry=pending.pop()!;
    if(entry.exit){visiting.delete(entry.id);visited.add(entry.id);continue;}
    if(visiting.has(entry.id))throw new PlatformError("EVIDENCE_CYCLE",409,"Evidence graph contains a cycle");
    if(visited.has(entry.id))continue;
    const node=nodes.get(entry.id);
    if(!node||node.id!==entry.id)throw new PlatformError("EVIDENCE_MISSING",409,"Evidence dependency is unavailable");
    for(const dependency of assertDependencyManifest(node.manifest).dependencies){
      const key=dependencyKey(dependency),prior=dependencies.get(key);
      if(prior&&requestDigest(prior)!==requestDigest(dependency))throw new PlatformError("EVIDENCE_POLICY_CONFLICT",409,"Evidence policy changed during execution");
      dependencies.set(key,dependency);
      if(dependencies.size>SOURCE_LIMITS.manifestNodes)throw new PlatformError("EVIDENCE_LIMIT",413,"Too many evidence dependencies");
    }
    visiting.add(entry.id);pending.push({id:entry.id,exit:true});
    for(const id of [...node.parents].reverse()){referenced.add(id);pending.push({id,exit:false});}
  }
  return {manifest:createDependencyManifest([...dependencies.values()]),referenced};
}
/** Retained graph size is independent of the bounded actual dependency manifest. */
export function collectDependencyGraph(rootIds: readonly string[], nodes: ReadonlyMap<string, DependencyNode>): DependencyManifest {
  return inspectDependencyGraph(rootIds,nodes).manifest;
}
/** Keep new parent edges sparse without rewriting any already recorded node. */
export function dependencyFrontier<T extends DependencyNode>(candidates:readonly T[],nodes:ReadonlyMap<string,DependencyNode>):T[] {
  const {referenced}=inspectDependencyGraph(candidates.map(node=>node.id),nodes);
  return candidates.filter(node=>!referenced.has(node.id));
}

export function assertIngestionPublication(job: IngestionJob, source: Source, now = Date.now()): void {
  if (!["extracting", "indexing"].includes(job.state) || source.state !== "active" || job.sourceId !== source.id ||
    job.acceptedGeneration !== source.generation || Date.parse(job.deadline) <= now) {
    throw new PlatformError("INGESTION_INVALIDATED", 409, "Import is no longer eligible for publication");
  }
}

export const EVIDENCE_LOCK_ORDER = Object.freeze(["organization", "membership", "execution_root", "task", "source_by_id", "connection_by_id", "revision_by_id", "operation_by_id"] as const);
