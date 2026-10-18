import { z } from "zod";
import { createHash } from "node:crypto";
import { createBoundedFetch, type NetworkAttempt } from "./connected-network";
import { PlatformError, requestDigest } from "./contracts";
import type { ResourceHandle } from "./capability-catalog";

export const GITHUB_ADAPTER_RELEASE = "github-public-read-v3";
export const GITHUB_LIMITS = Object.freeze({ responseBytes: 2097152, modelResultBytes: 8192, wallMs: 30000,
  physicalRequests: 3, releasesPerPage: 20, treeEntries: 2000, fileBytes: 1048576 });
export const githubOperationSchema = z.enum(["get_repository", "list_releases", "resolve_ref", "list_tree", "read_file"]);
export type GithubOperation = z.infer<typeof githubOperationSchema>;
export const githubRepositorySelectionSchema = z.strictObject({
  owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).refine(value => value !== "." && value !== ".."),
  ref: z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
});
export type GithubRepositorySelection = z.infer<typeof githubRepositorySelectionSchema>;
export function githubRepositoryHandle(selection: Pick<GithubRepositorySelection, "owner" | "repository">): ResourceHandle {
  const parsed = githubRepositorySelectionSchema.parse({ ...selection, ref: "HEAD" });
  return { kind: "github.repository", id: `${parsed.owner.toLowerCase()}/${parsed.repository.toLowerCase()}` };
}
export function assertGithubOperation(operation: string): GithubOperation { return githubOperationSchema.parse(operation); }
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const githubRevisionSchema = z.strictObject({
  version: z.literal(1), repository: githubRepositorySelectionSchema, selectionDigest: digest,
  commitSha: sha, treeSha: sha, resolvedAt: z.iso.datetime(), digest,
});
export type GithubRevision = z.infer<typeof githubRevisionSchema>;
export const githubFileHandleSchema = z.strictObject({
  version: z.literal(1), revisionDigest: digest, path: z.string().min(1).max(1024), blobSha: sha,
  size: z.number().int().nonnegative().max(GITHUB_LIMITS.fileBytes), mode: z.enum(["100644", "100755"]), digest,
});
export type GithubFileHandle = z.infer<typeof githubFileHandleSchema>;
export interface GithubObservation<T> {
  value: T; observedAt: string; etag: string | null; digest: string;
  provenance: { kind: "commit_snapshot"; commitSha: string } | { kind: "timestamped_observation" };
  responses: { etag: string | null; digest: string; observedAt: string }[]; attempts: NetworkAttempt[];
}
export class GithubAdapterError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export interface GithubAdapterOptions {
  authorization: string; authentication?: "none"; selections: readonly GithubRepositorySelection[]; deadlineAt: number; signal?: AbortSignal;
  maxPhysicalRequests?: number;
  beforeAttempt?: () => Promise<void>;
  onAttempt?: (attempt: NetworkAttempt) => Promise<void>;
  onResponse?: (response: GithubProviderResponse) => Promise<void>;
  /** Dedicated integration fixture; the production origin cannot be configured through a connection or model. */
  testLoopbackOrigin?: string;
}
export interface GithubProviderResponse { body: unknown; etag: string | null; digest: string; observedAt: string }
interface ResponseRecord extends GithubProviderResponse { headers: Headers }
type Repository = { id: number; fullName: string; description: string | null; defaultBranch: string; updatedAt: string; stars: number };
type Release = { id: number; tag: string; name: string | null; body: string | null; publishedAt: string | null; prerelease: boolean };
function failure(code: string): never { throw new GithubAdapterError(code); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failure("PROVIDER_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
function string(value: unknown, maximum: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum) failure("PROVIDER_RESPONSE_INVALID");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) failure("PROVIDER_RESPONSE_INVALID");
  return value;
}
function nullableString(value: unknown, maximum: number): string | null { return value === null ? null : string(value, maximum); }

/** Callers pass only persisted trusted selections/revisions/handles, never model URLs or credentials. */
export class GithubReadAdapter {
  private readonly origin: string;
  private readonly selections: readonly GithubRepositorySelection[];
  constructor(private readonly options: GithubAdapterOptions) {
    if (options.maxPhysicalRequests !== undefined && (!Number.isInteger(options.maxPhysicalRequests) || options.maxPhysicalRequests < 1 || options.maxPhysicalRequests > GITHUB_LIMITS.physicalRequests)) failure("REQUEST_LIMIT");
    if (options.authentication === "none" ? options.authorization !== "" : !options.authorization || /[\r\n]/.test(options.authorization) || Buffer.byteLength(options.authorization) > 4096) failure("CREDENTIAL_INVALID");
    this.selections = options.selections.map(selection => Object.freeze(githubRepositorySelectionSchema.parse(selection)));
    if (!this.selections.length || this.selections.length > 20 || new Set(this.selections.map(selection => githubRepositoryHandle(selection).id)).size !== this.selections.length) failure("REPOSITORY_SELECTION_INVALID");
    this.origin = "https://api.github.com";
    if (options.testLoopbackOrigin !== undefined) {
      const fixture = new URL(options.testLoopbackOrigin);
      if (fixture.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(fixture.hostname) || fixture.pathname !== "/" || fixture.username || fixture.password || fixture.search || fixture.hash) failure("DESTINATION_DENIED");
      this.origin = fixture.origin;
    }
  }
  private selection(input: GithubRepositorySelection): GithubRepositorySelection {
    const parsed = githubRepositorySelectionSchema.parse(input);
    const selected = this.selections.find(selection => requestDigest(selection) === requestDigest(parsed));
    if (!selected) failure("REPOSITORY_SCOPE_DENIED");
    return selected;
  }
  private revision(input: GithubRevision): GithubRevision {
    const parsed = githubRevisionSchema.parse(input), { digest: revisionDigest, ...content } = parsed;
    const selected = this.selection(parsed.repository);
    if (requestDigest(content) !== revisionDigest || parsed.selectionDigest !== requestDigest(selected)) failure("REVISION_INVALID");
    return parsed;
  }
  private base(selection: GithubRepositorySelection): string {
    return `/repos/${encodeURIComponent(selection.owner)}/${encodeURIComponent(selection.repository)}`;
  }
  private session() {
    const attempts: NetworkAttempt[] = [], responses: ResponseRecord[] = [], authorized = new Set<string>();
    const fetcher = createBoundedFetch({ authorizeUrl: url => authorized.has(url.href),
      headers: { ...(this.options.authentication === "none" ? {} : {authorization: `Bearer ${this.options.authorization}`}), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "Kasitek-Agents" },
      maxRequestBytes: 0, maxResponseBytes: GITHUB_LIMITS.responseBytes,
      deadlineAt: Math.min(this.options.deadlineAt, Date.now() + GITHUB_LIMITS.wallMs), maxAttempts: 3, maxRequests: this.options.maxPhysicalRequests ?? GITHUB_LIMITS.physicalRequests,
      signal: this.options.signal, testLoopback: this.options.testLoopbackOrigin !== undefined,
      beforeAttempt: this.options.beforeAttempt,
      onAttempt: async attempt => { attempts.push(attempt); await this.options.onAttempt?.(attempt); } });
    const read = async (path: string): Promise<ResponseRecord> => {
      const url = new URL(path, this.origin);
      if (url.origin !== this.origin || !path.startsWith("/repos/")) failure("DESTINATION_DENIED");
      authorized.add(url.href);
      const response = await fetcher(url, { method: "GET", redirect: "error" });
      if (response.status === 404) failure("RESOURCE_UNAVAILABLE");
      if (!response.ok) failure("PROVIDER_RESPONSE_FAILED");
      let body: unknown;
      try { body = await response.json(); } catch { failure("PROVIDER_RESPONSE_INVALID"); }
      const value = { body, etag: response.headers.get("etag"), digest: requestDigest(body), observedAt: new Date().toISOString(), headers: response.headers };
      await this.options.onResponse?.({ body: value.body, etag: value.etag, digest: value.digest, observedAt: value.observedAt });
      responses.push(value); return value;
    };
    const observe = <T>(value: T, provenance: GithubObservation<T>["provenance"]): GithubObservation<T> => ({ value,
      observedAt: new Date().toISOString(), etag: responses.length === 1 ? responses[0]!.etag : null,
      digest: requestDigest({ value, responses: responses.map(response => response.digest) }), provenance,
      responses: responses.map(({ etag, digest, observedAt }) => ({ etag, digest, observedAt })), attempts });
    const publicRepository = async (selection: GithubRepositorySelection): Promise<Repository> => {
      const body = record((await read(this.base(selection))).body);
      if (body.private !== false || body.visibility !== undefined && body.visibility !== "public") failure("REPOSITORY_NOT_PUBLIC");
      if (typeof body.full_name !== "string" || body.full_name.toLowerCase() !== githubRepositoryHandle(selection).id) failure("REPOSITORY_IDENTITY_CHANGED");
      return { id: number(body.id), fullName: body.full_name, description: nullableString(body.description, 16384),
        defaultBranch: string(body.default_branch, 256), updatedAt: string(body.updated_at, 64), stars: number(body.stargazers_count) };
    };
    return { read, observe, publicRepository };
  }
  async getRepository(input: GithubRepositorySelection): Promise<GithubObservation<Repository>> {
    const selection = this.selection(input), session = this.session();
    return session.observe(await session.publicRepository(selection), { kind: "timestamped_observation" });
  }
  async resolveRevision(input: GithubRepositorySelection): Promise<GithubObservation<GithubRevision>> {
    const selection = this.selection(input), session = this.session();
    await session.publicRepository(selection);
    const body = record((await session.read(`${this.base(selection)}/commits/${encodeURIComponent(selection.ref)}`)).body);
    const content = { version: 1 as const, repository: selection, selectionDigest: requestDigest(selection),
      commitSha: sha.parse(body.sha), treeSha: sha.parse(record(record(body.commit).tree).sha), resolvedAt: new Date().toISOString() };
    const revision = githubRevisionSchema.parse({ ...content, digest: requestDigest(content) });
    return session.observe(revision, { kind: "commit_snapshot", commitSha: revision.commitSha });
  }
  async listTree(input: GithubRevision): Promise<GithubObservation<{ revision: GithubRevision; files: GithubFileHandle[]; omittedUnsupported: number }>> {
    const revision = this.revision(input), session = this.session();
    await session.publicRepository(revision.repository);
    const body = record((await session.read(`${this.base(revision.repository)}/git/trees/${revision.treeSha}?recursive=1`)).body);
    if (body.sha !== revision.treeSha || body.truncated !== false || !Array.isArray(body.tree) || body.tree.length > GITHUB_LIMITS.treeEntries) failure("TREE_INCOMPLETE");
    const files: GithubFileHandle[] = []; let omittedUnsupported = 0;
    for (const value of body.tree) {
      const item = record(value), path = string(item.path, 1024);
      if (path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..") || /[\u0000-\u001f\u007f]/.test(path)) failure("PROVIDER_RESPONSE_INVALID");
      if (item.type !== "blob" || !["100644", "100755"].includes(String(item.mode)) || typeof item.size !== "number" || item.size > GITHUB_LIMITS.fileBytes) { omittedUnsupported++; continue; }
      const content = { version: 1 as const, revisionDigest: revision.digest, path, blobSha: sha.parse(item.sha), size: number(item.size), mode: item.mode as "100644" | "100755" };
      files.push(githubFileHandleSchema.parse({ ...content, digest: requestDigest(content) }));
    }
    if (new Set(files.map(file => file.path)).size !== files.length) failure("PROVIDER_RESPONSE_INVALID");
    return session.observe({ revision, files, omittedUnsupported }, { kind: "commit_snapshot", commitSha: revision.commitSha });
  }
  async readFile(input: GithubRevision, handleInput: GithubFileHandle): Promise<GithubObservation<{ path: string; content: string; blobSha: string }>> {
    const revision = this.revision(input), handle = githubFileHandleSchema.parse(handleInput), { digest: handleDigest, ...content } = handle;
    if (handle.revisionDigest !== revision.digest || requestDigest(content) !== handleDigest) failure("FILE_HANDLE_INVALID");
    const session = this.session(); await session.publicRepository(revision.repository);
    const body = record((await session.read(`${this.base(revision.repository)}/git/blobs/${handle.blobSha}`)).body);
    if (body.sha !== handle.blobSha || body.encoding !== "base64" || body.size !== handle.size || typeof body.content !== "string" || !/^[A-Za-z0-9+/=\r\n]*$/.test(body.content)) failure("PROVIDER_RESPONSE_INVALID");
    const bytes = Buffer.from(body.content.replaceAll("\n", "").replaceAll("\r", ""), "base64");
    if (bytes.length !== handle.size || bytes.length > GITHUB_LIMITS.fileBytes) failure("PROVIDER_RESPONSE_INVALID");
    if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== handle.blobSha) failure("BLOB_INTEGRITY_CONFLICT");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { failure("BINARY_FILE_UNSUPPORTED"); }
    if (text.includes("\u0000")) failure("BINARY_FILE_UNSUPPORTED");
    return session.observe({ path: handle.path, content: text, blobSha: handle.blobSha }, { kind: "commit_snapshot", commitSha: revision.commitSha });
  }
  /** GitHub offers no cross-page snapshot token. Return one timestamped page and an explicit continuation limit. */
  async listReleases(input: GithubRepositorySelection): Promise<GithubObservation<{ releases: Release[]; hasMore: boolean; pageSize: number }>> {
    const selection = this.selection(input), session = this.session(); await session.publicRepository(selection);
    const path = `${this.base(selection)}/releases?per_page=${GITHUB_LIMITS.releasesPerPage}&page=1`;
    const response = await session.read(path);
    if (!Array.isArray(response.body) || response.body.length > GITHUB_LIMITS.releasesPerPage) failure("PROVIDER_RESPONSE_INVALID");
    const releases: Release[] = [], ids = new Set<number>();
    for (const value of response.body) {
      const item = record(value), id = number(item.id);
      if (ids.has(id)) failure("OBSERVATION_CONFLICT");
      if (item.draft !== false || typeof item.prerelease !== "boolean") failure("PROVIDER_RESPONSE_INVALID");
      ids.add(id); releases.push({ id, tag: string(item.tag_name, 256), name: nullableString(item.name, 1024), body: nullableString(item.body, 131072), publishedAt: nullableString(item.published_at, 64), prerelease: item.prerelease });
    }
    const link = response.headers.get("link"), next = link?.match(/<([^>]+)>;\s*rel="next"/);
    if (next) {
      const expected = new URL(`${this.base(selection)}/releases?per_page=${GITHUB_LIMITS.releasesPerPage}&page=2`, this.origin);
      if (new URL(next[1]!, this.origin).href !== expected.href) failure("PAGINATION_SCOPE_DENIED");
    }
    return session.observe({ releases, hasMore: Boolean(next), pageSize: GITHUB_LIMITS.releasesPerPage }, { kind: "timestamped_observation" });
  }
}

export function projectGithubObservation(observation: GithubObservation<unknown>): { text: string; truncated: boolean; digest: string } {
  const serialized = JSON.stringify(observation.value), bytes = Buffer.from(serialized);
  const truncated = bytes.length > GITHUB_LIMITS.modelResultBytes;
  let text = serialized;
  if (truncated) {
    const suffix = "\n[truncated; full observation retained as evidence]";
    const prefix = bytes.subarray(0, GITHUB_LIMITS.modelResultBytes - Buffer.byteLength(suffix));
    text = new TextDecoder().decode(prefix, { stream: true }) + suffix;
  }
  if (Buffer.byteLength(text) > GITHUB_LIMITS.modelResultBytes) throw new PlatformError("TOOL_RESULT_LIMIT", 413, "Native result projection exceeds its limit");
  return { text, truncated, digest: observation.digest };
}
