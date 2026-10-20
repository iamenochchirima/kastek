import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { parseDocument } from "yaml";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";

export const SKILL_PACKAGE_LIMITS = Object.freeze({ archiveBytes: 2_097_152, totalBytes: 2_097_152,
  fileBytes: 524_288, instructionBytes: 65_536, files: 128, pathBytes: 256, depth: 8, archiveEntries: 256 });
export interface SkillPackageFile { readonly path: string; readonly content: string; readonly encoding: "base64"; readonly digest: string; readonly size: number }
export interface SkillPackage {
  readonly format: "agent-skills-v1"; readonly name: string; readonly description: string;
  readonly compatibility: string | null; readonly body: string; readonly contentDigest: string;
  readonly files: readonly SkillPackageFile[]; readonly totalBytes: number;
}
export interface SkillFileEvidence { packageDigest: string; path: string; contentDigest: string }
const fileInput = z.strictObject({ path: z.string().max(SKILL_PACKAGE_LIMITS.pathBytes),
  content: z.string().max(SKILL_PACKAGE_LIMITS.fileBytes * 2), encoding: z.enum(["utf8", "base64"]).default("utf8") });
const packageInput = z.strictObject({ files: z.array(fileInput).min(1).max(SKILL_PACKAGE_LIMITS.files) });
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function fail(message: string): never { throw new PlatformError("SKILL_PACKAGE_INVALID", 400, message); }

export function validateSkillPath(path: string): string {
  if (!path || Buffer.byteLength(path) > SKILL_PACKAGE_LIMITS.pathBytes || /[\\\x00-\x1f\x7f:#?%]/.test(path) || path.startsWith("/") || path.endsWith("/") ||
    path.split("/").length > SKILL_PACKAGE_LIMITS.depth || path.split("/").some(part => !part || part === "." || part === ".." || part.trim() !== part)) {
    fail("Skill files require bounded relative paths without traversal");
  }
  return path;
}
function utf8(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail("Skill instructions and requested text files must use UTF-8"); }
}
function decode(content: string, encoding: "base64" | "utf8"): Buffer {
  if (encoding === "utf8") return Buffer.from(content, "utf8");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) fail("Invalid base64 skill file");
  return Buffer.from(content, "base64");
}

/** The digest covers exact file bytes and paths, including frontmatter, scripts and binary assets. */
export function parseSkillPackage(input: unknown): SkillPackage {
  const parsed = packageInput.safeParse(input);
  if (!parsed.success) fail("Expected a bounded skill package file manifest");
  let totalBytes = 0;
  const paths = new Set<string>();
  const files = parsed.data.files.map(file => {
    const path = validateSkillPath(file.path), collisionKey = path.normalize("NFC").toLowerCase();
    if (paths.has(collisionKey)) fail("Duplicate or ambiguous skill file path");
    paths.add(collisionKey);
    const bytes = decode(file.content, file.encoding);
    totalBytes += bytes.length;
    if (bytes.length > SKILL_PACKAGE_LIMITS.fileBytes || totalBytes > SKILL_PACKAGE_LIMITS.totalBytes) fail("Skill package exceeds file or total byte limits");
    return Object.freeze({ path, encoding: "base64" as const, content: bytes.toString("base64"), size: bytes.length, digest: hash(bytes) });
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const file of files) {
    if (files.some(other => other.path.toLowerCase().startsWith(file.path.toLowerCase() + "/"))) fail("Skill path is both a file and a directory");
  }
  const main = files.find(file => file.path === "SKILL.md");
  if (!main || main.size > SKILL_PACKAGE_LIMITS.instructionBytes) fail("Package requires a bounded root SKILL.md");
  const text = utf8(Buffer.from(main.content, "base64"));
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) fail("SKILL.md requires YAML frontmatter");
  let metadata: unknown;
  try {
    const document = parseDocument(match[1]!, { uniqueKeys: true, strict: true });
    if (document.errors.length) fail("Invalid skill YAML frontmatter");
    metadata = document.toJS({ maxAliasCount: 0 });
  } catch { return fail("Invalid skill YAML frontmatter"); }
  const frontmatter = z.object({ name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().min(1).max(1024), compatibility: z.string().trim().min(1).max(500).optional(),
    license: z.string().max(1024).optional(), metadata: z.record(z.string(), z.string()).optional(), "allowed-tools": z.string().max(4096).optional() }).passthrough().safeParse(metadata);
  if (!frontmatter.success) fail("SKILL.md requires a valid name and description");
  const body = match[2]!.trim();
  const manifest = files.map(file => [file.path, file.size, file.digest]);
  const contentDigest = hash(JSON.stringify(["agent-skills-v1", manifest]));
  return Object.freeze({ format: "agent-skills-v1", name: frontmatter.data.name, description: frontmatter.data.description,
    compatibility: frontmatter.data.compatibility ?? null, body, contentDigest, files: Object.freeze(files), totalBytes });
}

/** ZIP decoding never extracts to disk and never executes bundled scripts. */
export async function parseSkillZip(bytes: Buffer): Promise<SkillPackage> {
  if (!bytes.length || bytes.length > SKILL_PACKAGE_LIMITS.archiveBytes) fail("Skill ZIP exceeds archive byte limits");
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, archive) => {
      if (error || !archive) { reject(new PlatformError("SKILL_PACKAGE_INVALID", 400, "Invalid skill ZIP")); return; }
      let settled = false, expandedBytes = 0, entries = 0;
      const files: { path: string; content: string; encoding: "base64" }[] = [];
      const names = new Set<string>();
      const abort = (cause: unknown) => { if (settled) return; settled = true; archive.close(); reject(cause instanceof PlatformError ? cause : new PlatformError("SKILL_PACKAGE_INVALID", 400, "Invalid skill ZIP")); };
      archive.on("error", abort);
      archive.on("entry", (entry: Entry) => {
        try {
          if (++entries > SKILL_PACKAGE_LIMITS.archiveEntries) fail("Skill ZIP has too many entries");
          const directory = entry.fileName.endsWith("/"), path = validateSkillPath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode && mode !== 0x8000 && mode !== 0x4000) fail("Skill ZIP cannot contain links or special files");
          if ((mode === 0x4000) !== directory && mode) fail("Skill ZIP entry type mismatch");
          if (entry.generalPurposeBitFlag & 1) fail("Encrypted skill ZIP files are unsupported");
          const key = path.normalize("NFC").toLowerCase();
          if (names.has(key)) fail("Duplicate or ambiguous ZIP entry");
          names.add(key);
          if (directory) { archive.readEntry(); return; }
          if (files.length >= SKILL_PACKAGE_LIMITS.files || entry.uncompressedSize > SKILL_PACKAGE_LIMITS.fileBytes || expandedBytes + entry.uncompressedSize > SKILL_PACKAGE_LIMITS.totalBytes) fail("Skill ZIP exceeds expanded byte limits");
          readEntry(archive, entry, SKILL_PACKAGE_LIMITS.totalBytes - expandedBytes).then(content => {
            if (settled) return;
            expandedBytes += content.length;
            files.push({ path, content: content.toString("base64"), encoding: "base64" });
            archive.readEntry();
          }).catch(abort);
        } catch (cause) { abort(cause); }
      });
      archive.on("end", () => {
        if (settled) return;
        try {
          // Standard archives may wrap one skill directory; preserve its name check before stripping it.
          if (!files.some(file => file.path === "SKILL.md")) {
            const root = files[0]?.path.split("/")[0];
            if (!root || !files.every(file => file.path.startsWith(root + "/"))) fail("ZIP must contain exactly one skill package");
            for (const file of files) file.path = file.path.slice(root.length + 1);
            const result = parseSkillPackage({ files });
            if (result.name !== root) fail("Skill name must match the package directory");
            settled = true; resolve(result); return;
          }
          const result = parseSkillPackage({ files }); settled = true; resolve(result);
        } catch (cause) { abort(cause); }
      });
      archive.readEntry();
    });
  });
}
async function readEntry(archive: ZipFile, entry: Entry, remainingBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => archive.openReadStream(entry, (error, stream) => {
    if (error || !stream) { reject(error ?? new Error("Missing ZIP stream")); return; }
    const chunks: Buffer[] = []; let size = 0, checksum = 0;
    stream.on("error", reject);
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > SKILL_PACKAGE_LIMITS.fileBytes || size > remainingBytes) { stream.destroy(new Error("Skill ZIP exceeds expanded byte limits")); return; }
      checksum = crc32(chunk, checksum);
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (checksum !== entry.crc32 || size !== entry.uncompressedSize) { reject(new Error("Skill ZIP entry integrity mismatch")); return; }
      resolve(Buffer.concat(chunks));
    });
  }));
}

function reviewed(pkg: SkillPackage, reviewedDigest: string): SkillPackage {
  const current = parseSkillPackage({ files: pkg.files.map(file => ({ path: file.path, content: file.content, encoding: file.encoding })) });
  if (current.contentDigest !== reviewedDigest || pkg.contentDigest !== current.contentDigest) throw new PlatformError("SKILL_REVIEW_REQUIRED", 409, "Skill package requires review of this exact revision");
  return current;
}
export function skillPackageCatalog(pkg: SkillPackage) {
  return { name: pkg.name, description: pkg.description, contentDigest: pkg.contentDigest };
}
export function activateSkillPackage(pkg: SkillPackage, reviewedDigest: string) {
  const current = reviewed(pkg, reviewedDigest), main = current.files.find(file => file.path === "SKILL.md")!;
  return { name: current.name, compatibility: current.compatibility, body: current.body,
    resources: current.files.filter(file => file.path !== "SKILL.md").map(file => ({ path: file.path, size: file.size, contentDigest: file.digest })),
    evidence: { packageDigest: current.contentDigest, path: main.path, contentDigest: main.digest } satisfies SkillFileEvidence };
}
export function readSkillPackageFile(pkg: SkillPackage, path: string, reviewedDigest: string) {
  const current = reviewed(pkg, reviewedDigest), normalized = validateSkillPath(path), file = current.files.find(item => item.path === normalized);
  if (!file) throw new PlatformError("SKILL_FILE_NOT_FOUND", 404, "Skill package file is unavailable");
  return { content: utf8(Buffer.from(file.content, "base64")),
    evidence: { packageDigest: current.contentDigest, path: file.path, contentDigest: file.digest } satisfies SkillFileEvidence };
}
