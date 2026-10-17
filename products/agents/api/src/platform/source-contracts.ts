import { createHash } from "node:crypto";
import { z } from "zod";
import { PlatformError, requestDigest } from "./contracts";

const id = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z.number().int().positive();
export const SOURCE_LIMITS = Object.freeze({ rawBytes: 10_485_760, textBytes: 1_048_576, pages: 200,
  chunks: 1000, organizationSources: 200, organizationChunks: 100_000, versionSources: 20,
  concurrentImports: 2, importWallMs: 600_000, manifestNodes: 1024, manifestEdges: 4096, manifestDepth: 32 });

export const sourceSchema = z.strictObject({
  id, organizationId: id, importerAccountId: id, title: z.string().trim().min(1).max(200),
  kind: z.enum(["upload", "public_url", "provider_snapshot"]), generation,
  state: z.enum(["active", "withdrawn"]), visibility: z.enum(["private", "public"]),
  createdAt: z.iso.datetime(),
});
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
  embeddingRelease: z.string().min(1).max(256).nullable(), acquiredAt: z.iso.datetime(), sealedAt: z.iso.datetime(),
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
const memoryDependency = z.strictObject({ kind: z.literal("memory"), referenceId: id, generation });
export const evidenceDependencySchema = z.discriminatedUnion("kind", [sourceDependency, connectionDependency, memoryDependency]);
export const dependencyManifestSchema = z.strictObject({ version: z.literal(1), dependencies: z.array(evidenceDependencySchema).max(SOURCE_LIMITS.manifestNodes), digest });
export const evidenceReferenceSchema = z.strictObject({
  id, organizationId: id, rootTaskId: id, operationId: id,
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
    case "source": return `source:${dependency.sourceId}:${dependency.revisionId}`;
    case "connection": return `connection:${dependency.connectionId}:${dependency.resource}:${dependency.catalogDigest}`;
    case "memory": return `memory:${dependency.referenceId}`;
  }
}
export function createDependencyManifest(inputs: readonly EvidenceDependency[]): DependencyManifest {
  if (inputs.length > SOURCE_LIMITS.manifestEdges) throw new PlatformError("EVIDENCE_LIMIT", 413, "Too many evidence dependencies");
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
export function collectDependencyGraph(rootIds: readonly string[], nodes: ReadonlyMap<string, DependencyNode>): DependencyManifest {
  let edges = 0;
  const visiting = new Set<string>(), visited = new Set<string>(), dependencies: EvidenceDependency[] = [];
  function visit(nodeId: string, depth: number): void {
    if (++edges > SOURCE_LIMITS.manifestEdges || depth > SOURCE_LIMITS.manifestDepth) throw new PlatformError("EVIDENCE_LIMIT", 413, "Evidence graph exceeds its limit");
    if (visiting.has(nodeId)) throw new PlatformError("EVIDENCE_CYCLE", 409, "Evidence graph contains a cycle");
    if (visited.has(nodeId)) return;
    if (visited.size + visiting.size >= SOURCE_LIMITS.manifestNodes) throw new PlatformError("EVIDENCE_LIMIT", 413, "Evidence graph exceeds its limit");
    const node = nodes.get(nodeId);
    if (!node || node.id !== nodeId) throw new PlatformError("EVIDENCE_MISSING", 409, "Evidence dependency is unavailable");
    visiting.add(nodeId);
    dependencies.push(...assertDependencyManifest(node.manifest).dependencies);
    if (dependencies.length > SOURCE_LIMITS.manifestEdges) throw new PlatformError("EVIDENCE_LIMIT", 413, "Too many evidence dependencies");
    for (const parent of node.parents) visit(parent, depth + 1);
    visiting.delete(nodeId); visited.add(nodeId);
  }
  for (const root of rootIds) visit(root, 0);
  return createDependencyManifest(dependencies);
}

export function assertIngestionPublication(job: IngestionJob, source: Source, now = Date.now()): void {
  if (!["extracting", "indexing"].includes(job.state) || source.state !== "active" || job.sourceId !== source.id ||
    job.acceptedGeneration !== source.generation || Date.parse(job.deadline) <= now) {
    throw new PlatformError("INGESTION_INVALIDATED", 409, "Import is no longer eligible for publication");
  }
}

export const EVIDENCE_LOCK_ORDER = Object.freeze(["organization", "membership", "execution_root", "task", "source_by_id", "connection_by_id", "revision_by_id", "operation_by_id"] as const);
