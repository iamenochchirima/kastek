import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { activateSkillPackage, parseSkillPackage, parseSkillZip, readSkillPackageFile, skillPackageCatalog, SKILL_PACKAGE_LIMITS } from "../src/capabilities/skills/package";

const skill = "---\nname: report-helper\ndescription: Build reports when requested.\ncompatibility: Requires an approved sandbox for scripts.\nmetadata:\n  author: example\n---\nRead [guide](references/guide.md). Scripts require separate sandbox permission.";
const manifest = (text = "Review source evidence.") => ({ files: [
  { path: "SKILL.md", content: skill }, { path: "references/guide.md", content: text },
  { path: "scripts/check.py", content: "raise Exception('must never execute during import')" },
  { path: "assets/template.bin", content: "AP8=", encoding: "base64" },
] });
function zip(entries: { path: string; text?: string; mode?: number; declaredSize?: number }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path), bytes = Buffer.from(entry.text ?? "");
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(entry.declaredSize ?? bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(bytes), 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(entry.declaredSize ?? bytes.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(((entry.mode ?? 0x8000) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(directory, name); offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

describe("Agent Skills package review and progressive disclosure", () => {
  it("loads YAML metadata only into catalogue and instructions only on exact reviewed activation", () => {
    const pkg = parseSkillPackage(manifest());
    expect(skillPackageCatalog(pkg)).toEqual({ name: "report-helper", description: "Build reports when requested.", contentDigest: pkg.contentDigest });
    expect(skillPackageCatalog(pkg)).not.toHaveProperty("body");
    expect(() => activateSkillPackage(pkg, "0".repeat(64))).toThrow("exact revision");
    const active = activateSkillPackage(pkg, pkg.contentDigest);
    expect(active.body).toContain("Read [guide]"); expect(active.body).not.toContain("Review source evidence");
    expect(active.resources).toHaveLength(3); expect(active.evidence.path).toBe("SKILL.md");
    const read = readSkillPackageFile(pkg, "references/guide.md", pkg.contentDigest);
    expect(read.content).toBe("Review source evidence.");
    expect(read.evidence.packageDigest).toBe(pkg.contentDigest);
    expect(read.evidence.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(() => readSkillPackageFile(pkg, "assets/template.bin", pkg.contentDigest)).toThrow("UTF-8");
    expect(() => readSkillPackageFile(pkg, "absent.md", pkg.contentDigest)).toThrow("unavailable");
  });
  it("hashes every exact file byte and path independent of file order or transport encoding", () => {
    const input = manifest(), pkg = parseSkillPackage(input);
    const reversed = { files: [...input.files].reverse().map(file => file.path === "SKILL.md" ? { ...file, content: Buffer.from(file.content).toString("base64"), encoding: "base64" } : file) };
    expect(parseSkillPackage(reversed).contentDigest).toBe(pkg.contentDigest);
    for (const path of input.files.map(file => file.path)) {
      const changed = { files: input.files.map(file => file.path !== path ? file : { ...file, content: file.encoding === "base64" ? "AAE=" : file.content + "\n" }) };
      expect(parseSkillPackage(changed).contentDigest).not.toBe(pkg.contentDigest);
    }
    expect(Object.isFrozen(pkg)).toBe(true); expect(Object.isFrozen(pkg.files)).toBe(true); expect(Object.isFrozen(pkg.files[0])).toBe(true);
  });
  it("revalidates persisted files rather than trusting caller-supplied parsed metadata", () => {
    const pkg = parseSkillPackage(manifest()), changed = parseSkillPackage(manifest("Changed instructions"));
    expect(() => activateSkillPackage({ ...pkg, files: changed.files }, pkg.contentDigest)).toThrow("exact revision");
    const active = activateSkillPackage({ ...pkg, body: "Unreviewed injected instruction", name: "injected" }, pkg.contentDigest);
    expect(active.body).toBe(pkg.body); expect(active.name).toBe(pkg.name);
  });
  it.each(["../secret", "/etc/passwd", "C:/test", "ref\\secret", "./guide", "ref//guide", "ref/../guide", "ref/%2e%2e/guide", "ref/file?x", "ref/file\u0000", "ref/ guide"]) ("rejects hostile package path %s", path => {
    expect(() => parseSkillPackage({ files: [...manifest().files, { path, content: "unsafe" }] })).toThrow();
  });
  it("rejects duplicate, Unicode ambiguous, mixed-case and file/directory collisions", () => {
    for (const paths of [["references/guide.md", "references/GUIDE.md"], ["é.md", "e\u0301.md"], ["ref", "ref/file.md"]]) {
      expect(() => parseSkillPackage({ files: [{ path: "SKILL.md", content: skill }, ...paths.map(path => ({ path, content: "unsafe" }))] })).toThrow();
    }
  });
  it.each([
    "name: report-helper\n", "description: Reports\n", "name: BAD\ndescription: Reports\n",
    "name: report--helper\ndescription: Reports\n", "name: a\nname: b\ndescription: Reports\n",
    "name: a\ndescription: &x Reports\ncompatibility: *x\n", "name: a\ndescription: [Reports]\n",
  ])("rejects missing or malformed metadata %s", metadata => {
    expect(() => parseSkillPackage({ files: [{ path: "SKILL.md", content: `---\n${metadata}---\nBody` }] })).toThrow();
  });
  it("supports ordinary YAML multiline descriptions and optional fields without granting tools", () => {
    const pkg = parseSkillPackage({ files: [{ path: "SKILL.md", content: "---\nname: example\ndescription: >\n  Build reports\n  when requested.\nallowed-tools: Bash(*)\nlicense: Apache-2.0\n---\nInstructions" }] });
    expect(pkg.description).toContain("Build reports when requested."); expect(pkg).not.toHaveProperty("allowedTools");
  });
  it("rejects oversized files and manifests", () => {
    expect(() => parseSkillPackage({ files: [...manifest().files, { path: "large", content: "x".repeat(SKILL_PACKAGE_LIMITS.fileBytes + 1) }] })).toThrow();
    expect(() => parseSkillPackage({ files: [...manifest().files, ...Array.from({ length: 125 }, (_, index) => ({ path: `extra-${index}`, content: "" }))] })).toThrow();
    expect(() => parseSkillPackage({ files: [{ path: "SKILL.md", content: skill + "x".repeat(SKILL_PACKAGE_LIMITS.instructionBytes) }] })).toThrow();
    expect(() => parseSkillPackage({ files: [...manifest().files, { path: "bad", content: "abc", encoding: "base64" }] })).toThrow();
  });
  it("imports real ZIP files, wrappers and scripts without extraction or execution", async () => {
    const zipped = zip([{ path: "report-helper/SKILL.md", text: skill }, { path: "report-helper/references/guide.md", text: "Reference" }, { path: "report-helper/scripts/run.py", text: "raise Exception('inert')" }]);
    const pkg = await parseSkillZip(zipped);
    expect(pkg.name).toBe("report-helper"); expect(pkg.files.map(file => file.path)).toEqual(["SKILL.md", "references/guide.md", "scripts/run.py"]);
    expect((await parseSkillZip(zip([{ path: "SKILL.md", text: skill }]))).name).toBe(pkg.name);
  });
  it("rejects malicious archives before reading link or oversized contents", async () => {
    for (const entries of [
      [{ path: "SKILL.md", text: skill }, { path: "../outside", text: "escape" }],
      [{ path: "SKILL.md", text: skill }, { path: "link", text: "/etc/passwd", mode: 0xa000 }],
      [{ path: "SKILL.md", text: skill }, { path: "huge", declaredSize: SKILL_PACKAGE_LIMITS.fileBytes + 1 }],
      [{ path: "SKILL.md", text: skill }, { path: "SKILL.md", text: skill }],
      [{ path: "different/SKILL.md", text: skill }],
      [{ path: "one/SKILL.md", text: skill }, { path: "two/SKILL.md", text: skill }],
    ]) await expect(parseSkillZip(zip(entries))).rejects.toThrow();
    await expect(parseSkillZip(Buffer.alloc(SKILL_PACKAGE_LIMITS.archiveBytes + 1))).rejects.toThrow();
    await expect(parseSkillZip(Buffer.from("invalid"))).rejects.toThrow();
    const damaged = zip([{ path: "SKILL.md", text: skill }]);
    damaged[30 + Buffer.byteLength("SKILL.md") + 1] ^= 1;
    await expect(parseSkillZip(damaged)).rejects.toThrow();
  });
});
