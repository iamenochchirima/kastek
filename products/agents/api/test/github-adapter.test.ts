import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { GithubReadAdapter, githubRepositoryHandle, projectGithubObservation, assertGithubOperation,
  type GithubRepositorySelection, type GithubProviderResponse } from "../src/platform/github-adapter";

const selection: GithubRepositorySelection = { owner: "approved", repository: "public-repo", ref: "main" };
const commitA = "a".repeat(40), commitB = "b".repeat(40), treeA = "c".repeat(40), treeB = "d".repeat(40);
const file = Buffer.from("# Public repository\nContent remains pinned.\n");
const blobSha = createHash("sha1").update(`blob ${file.length}\0`).update(file).digest("hex");
const metadata = { id: 123, full_name: "approved/public-repo", private: false, visibility: "public", description: "An approved public repository",
  default_branch: "main", updated_at: "2026-10-17T20:00:00Z", stargazers_count: 4 };
function json(response: ServerResponse, value: unknown, headers: Record<string, string> = {}) {
  response.writeHead(200, { "content-type": "application/json", etag: '"fixture-etag"', ...headers }); response.end(JSON.stringify(value));
}
async function fixture(run: (adapter: GithubReadAdapter, seen: { path: string; authorization: string | undefined }[], origin: string) => Promise<void>,
  handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const seen: { path: string; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => { seen.push({ path: request.url!, authorization: request.headers.authorization }); handle(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const adapter = new GithubReadAdapter({ authorization: "fixture-public-repo-only-token", selections: [selection], deadlineAt: Date.now() + 10000, testLoopbackOrigin: origin });
    await run(adapter, seen, origin);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function repositoryRoute(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.url === "/repos/approved/public-repo") { json(response, metadata); return true; }
  return false;
}

describe("native GitHub public read profile over actual bounded HTTP", () => {
  it("resolves a branch once and keeps tree/blob reads on its persisted commit", async () => {
    let currentCommit = commitA, currentTree = treeA;
    await fixture(async (adapter, seen) => {
      const resolved = await adapter.resolveRevision(selection);
      currentCommit = commitB; currentTree = treeB;
      const listing = await adapter.listTree(resolved.value);
      expect(listing.value.files).toHaveLength(1);
      expect(listing.value.omittedUnsupported).toBe(2);
      const content = await adapter.readFile(resolved.value, listing.value.files[0]!);
      expect(content.value.content).toBe(file.toString());
      expect(content.provenance).toEqual({ kind: "commit_snapshot", commitSha: commitA });
      expect(content.responses).toHaveLength(2);
      expect(content.responses.every(response => response.etag && response.digest.length === 64 && response.observedAt)).toBe(true);
      expect(seen.filter(request => request.path.includes("/commits/"))).toHaveLength(1);
      expect(seen.some(request => request.path.includes(treeA))).toBe(true);
      expect(seen.some(request => request.path.includes(treeB))).toBe(false);
      expect(seen.every(request => request.authorization === "Bearer fixture-public-repo-only-token")).toBe(true);
      expect(content.attempts).toHaveLength(2);
      expect(githubRepositoryHandle(selection)).toEqual({ kind: "github.repository", id: "approved/public-repo" });
    }, (request, response) => {
      if (repositoryRoute(request, response)) return;
      if (request.url === "/repos/approved/public-repo/commits/main") return json(response, { sha: currentCommit, commit: { tree: { sha: currentTree } } });
      if (request.url === `/repos/approved/public-repo/git/trees/${treeA}?recursive=1`) return json(response, { sha: treeA, truncated: false, tree: [
        { path: "README.md", type: "blob", mode: "100644", sha: blobSha, size: file.length },
        { path: "outside", type: "blob", mode: "120000", sha: blobSha, size: file.length },
        { path: "submodule", type: "commit", mode: "160000", sha: commitB },
      ] });
      if (request.url === `/repos/approved/public-repo/git/blobs/${blobSha}`) return json(response, { sha: blobSha, encoding: "base64", size: file.length, content: file.toString("base64") });
      response.writeHead(500); response.end();
    });
  });

  it("rejects model-added repositories/refs/URLs before any provider request", async () => {
    await fixture(async (adapter, seen) => {
      for (const changed of [{ repository: "private-repo" }, { ref: "private-value-to-exfiltrate" }, { owner: "https://outside.example" }]) await expect(adapter.getRepository({ ...selection, ...changed })).rejects.toThrow();
      await expect(adapter.getRepository({ ...selection, url: "https://outside.example" } as GithubRepositorySelection)).rejects.toThrow();
      expect(() => assertGithubOperation("delete_repository")).toThrow();
      expect(seen).toHaveLength(0);
    }, (_request, response) => json(response, metadata));
  });

  it("checks current publicness before fetching old pinned content", async () => {
    let privateNow = false;
    await fixture(async (adapter, seen) => {
      const resolved = await adapter.resolveRevision(selection);
      privateNow = true;
      await expect(adapter.listTree(resolved.value)).rejects.toMatchObject({ code: "REPOSITORY_NOT_PUBLIC" });
      expect(seen.filter(request => request.path.includes("/git/trees/"))).toHaveLength(0);
    }, (request, response) => {
      if (request.url === "/repos/approved/public-repo") return json(response, { ...metadata, private: privateNow, visibility: privateNow ? "private" : "public" });
      json(response, { sha: commitA, commit: { tree: { sha: treeA } } });
    });
  });

  it("refuses public-host redirects containing unapproved path/query disclosure", async () => {
    await fixture(async (adapter, seen) => {
      await expect(adapter.getRepository(selection)).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
      expect(seen).toHaveLength(1);
    }, (_request, response) => { response.writeHead(302, { location: "https://api.github.com/repos/approved/public-repo?private-data=secret" }); response.end(); });
  });

  it("records metadata as observations and bounds model projection by UTF-8 bytes", async () => {
    await fixture(async adapter => {
      const observation = await adapter.getRepository(selection);
      expect(observation.provenance).toEqual({ kind: "timestamped_observation" });
      expect(observation.etag).toBe('"fixture-etag"');
      const projection = projectGithubObservation({ ...observation, value: { text: "🙂".repeat(3000) } });
      expect(projection.truncated).toBe(true);
      expect(Buffer.byteLength(projection.text)).toBeLessThanOrEqual(8192);
      expect(projection.text).not.toContain("�");
    }, (_request, response) => json(response, metadata));
  });

  it("records release changes as separate observations and reports a single-page limit", async () => {
    let paginationOrigin = "", releaseId = 1;
    await fixture(async (adapter, seen, origin) => {
      paginationOrigin = origin;
      const first = await adapter.listReleases(selection);
      releaseId = 2;
      const changed = await adapter.listReleases(selection);
      expect(first.value).toMatchObject({ hasMore: true, pageSize: 20 });
      expect(first.value.releases[0]!.id).toBe(1);
      expect(changed.value.releases[0]!.id).toBe(2);
      expect(changed.digest).not.toBe(first.digest);
      expect(changed.provenance.kind).toBe("timestamped_observation");
      expect(seen.filter(request => new URL(request.path, origin).searchParams.get("page") === "2")).toHaveLength(0);
    }, (request, response) => {
      if (repositoryRoute(request, response)) return;
      json(response, [{ id: releaseId, tag_name: `v${releaseId}`, name: null, body: null, published_at: null, draft: false, prerelease: false }],
        { link: `<${paginationOrigin}/repos/approved/public-repo/releases?per_page=20&page=2>; rel="next"` });
    });
  });

  it("rejects conflicting release rows and provider next URLs outside the exact scope", async () => {
    let duplicates = true;
    await fixture(async adapter => {
      await expect(adapter.listReleases(selection)).rejects.toMatchObject({ code: "OBSERVATION_CONFLICT" });
      duplicates = false;
      await expect(adapter.listReleases(selection)).rejects.toMatchObject({ code: "PAGINATION_SCOPE_DENIED" });
    }, (request, response) => {
      if (repositoryRoute(request, response)) return;
      const release = { id: 1, tag_name: "v1", name: null, body: null, published_at: null, draft: false, prerelease: false };
      json(response, duplicates ? [release, release] : [release], { link: '<https://outside.example/?private=data>; rel="next"' });
    });
  });

  it("shares the three physical request ceiling across metadata, retries and content reads", async () => {
    let requests = 0;
    await fixture(async (adapter, seen) => {
      await expect(adapter.resolveRevision(selection)).rejects.toMatchObject({ code: "REQUEST_LIMIT" });
      expect(seen).toHaveLength(3);
      expect(seen.every(request => !request.path.includes("/commits/"))).toBe(true);
    }, (_request, response) => {
      requests++;
      if (requests < 3) { response.writeHead(503, { "retry-after": "0" }); response.end(); }
      else json(response, metadata);
    });
  });

  it("persists per-attempt admission before wire IO and supports a one-request publicness check", async () => {
    let admitted = 0, recorded = 0;
    await fixture(async (_adapter, seen, origin) => {
      const bounded = new GithubReadAdapter({ authorization: "fixture-public-repo-only-token", selections: [selection], deadlineAt: Date.now() + 10000,
        testLoopbackOrigin: origin, maxPhysicalRequests: 1, beforeAttempt: async () => { admitted++; }, onAttempt: async () => { recorded++; } });
      await expect(bounded.getRepository(selection)).rejects.toMatchObject({ code: "REQUEST_LIMIT" });
      expect(seen).toHaveLength(1); expect(admitted).toBe(1); expect(recorded).toBe(1);
      const denied = new GithubReadAdapter({ authorization: "fixture-public-repo-only-token", selections: [selection], deadlineAt: Date.now() + 10000,
        testLoopbackOrigin: origin, beforeAttempt: async () => { throw new Error("Durable attempt allocation denied"); } });
      await expect(denied.getRepository(selection)).rejects.toThrow("Durable attempt allocation denied"); expect(seen).toHaveLength(1);
    }, (_request, response) => { expect(admitted).toBeGreaterThan(recorded); response.writeHead(503, { "retry-after": "0" }); response.end(); });
  });

  it("awaits full provider-body storage before returning a normalized model observation", async () => {
    await fixture(async (_adapter, _seen, origin) => {
      let stored: GithubProviderResponse | undefined;
      const adapter = new GithubReadAdapter({ authorization: "fixture-public-repo-only-token", selections: [selection], deadlineAt: Date.now() + 10000,
        testLoopbackOrigin: origin, onResponse: async response => { await new Promise(resolve => setTimeout(resolve, 5)); stored = response; } });
      const observation = await adapter.getRepository(selection);
      expect(stored?.body).toMatchObject({ ...metadata, license: { key: "mit", name: "MIT License" } });
      expect(stored?.digest).toBe(observation.responses[0]!.digest);
      expect(observation.value).not.toHaveProperty("license");
      expect(observation).not.toHaveProperty("rawResponses");
    }, (_request, response) => json(response, { ...metadata, license: { key: "mit", name: "MIT License" } }));
  });

  it("rejects truncated trees and corrupt immutable blobs without retaining usable content", async () => {
    let truncated = true;
    await fixture(async adapter => {
      const resolved = await adapter.resolveRevision(selection);
      await expect(adapter.listTree(resolved.value)).rejects.toMatchObject({ code: "TREE_INCOMPLETE" });
      truncated = false;
      const files = await adapter.listTree(resolved.value);
      const handle = files.value.files[0]!;
      await expect(adapter.readFile(resolved.value, { ...handle, path: "other.md" })).rejects.toMatchObject({ code: "FILE_HANDLE_INVALID" });
      await expect(adapter.readFile(resolved.value, handle)).rejects.toMatchObject({ code: "BLOB_INTEGRITY_CONFLICT" });
    }, (request, response) => {
      if (repositoryRoute(request, response)) return;
      if (request.url!.includes("/commits/")) return json(response, { sha: commitA, commit: { tree: { sha: treeA } } });
      if (request.url!.includes("/trees/")) return json(response, { sha: treeA, truncated, tree: [{ path: "README.md", type: "blob", mode: "100644", sha: blobSha, size: file.length }] });
      json(response, { sha: blobSha, encoding: "base64", size: file.length, content: Buffer.alloc(file.length, "x").toString("base64") });
    });
  });
});
