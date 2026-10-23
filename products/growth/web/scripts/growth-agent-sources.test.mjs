import assert from "node:assert/strict";
import { test } from "node:test";
import { safeGrowthRoute, safeSourceLink, sourceCitationParts, sourceCitations } from "../src/lib/growth-agent-sources.ts";

const label = "E" + "a".repeat(32);
const source = { id: "business", title: "Business overview", route: "/workspace/settings", citationLabel: label };
test("maps a verified label to a numbered source with its safe route", () => {
  assert.deepEqual(sourceCitationParts(`Business [${label}].`, [source]), [
    { kind: "text", text: "Business " },
    { kind: "source", number: 1, title: source.title, href: source.route },
    { kind: "text", text: "." },
  ]);
});
test("reuses numbers for repeated aggregate labels and preserves every distinct source", () => {
  const second = { ...source, id: "post", title: "Content draft", route: "/content/posts/one" };
  const parts = sourceCitationParts(`[${label}] and [${label}]`, [source, second]);
  assert.deepEqual(parts.filter(part => part.kind === "source").map(part => part.number), [1, 2, 1, 2]);
  assert.deepEqual(parts.filter(part => part.kind === "source").map(part => part.href), [source.route, second.route, source.route, second.route]);
});
test("leaves unknown and missing labels unchanged instead of attributing them", () => {
  const text = `Unknown [E${"b".repeat(32)}] and [Eshort].`;
  assert.deepEqual(sourceCitationParts(text, [source]), [{ kind: "text", text }]);
  assert.deepEqual(sourceCitationParts(`[${label}]`, [{ ...source, citationLabel: undefined }]), [{ kind: "text", text: `[${label}]` }]);
});
test("unsafe or credential-bearing URLs remain numbered plain text", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd", "//foreign.example/path", "https://user:secret@foreign.example/path"]) {
    const unsafe = { ...source, route: undefined, url };
    assert.equal(safeSourceLink(unsafe), null);
    const tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: `[${label}]` }] }] };
    sourceCitations([unsafe])()(tree);
    assert.deepEqual(tree.children[0].children, [{ type: "text", value: "[1]" }]);
  }
});
test("safe external sources work and authorized record routes take precedence", () => {
  assert.equal(safeSourceLink({ ...source, route: undefined, url: "https://sources.example/report" }), "https://sources.example/report");
  assert.equal(safeSourceLink({ ...source, url: "https://sources.example/report" }), source.route);
  assert.equal(safeSourceLink({ ...source, route: "/api/admin/export" }), null);
});
test("remark changes only prose and preserves code and existing link contents", () => {
  const token = `[${label}]`;
  const tree = { type: "root", children: [{ type: "paragraph", children: [
    { type: "text", value: token }, { type: "inlineCode", value: token },
    { type: "link", url: "/content", children: [{ type: "text", value: token }] },
  ] }, { type: "code", value: token }] };
  sourceCitations([source])()(tree);
  assert.deepEqual(tree.children[0].children[0], { type: "link", url: source.route, title: source.title, children: [{ type: "text", value: "[1]" }] });
  assert.equal(tree.children[0].children[1].value, token);
  assert.equal(tree.children[0].children[2].children[0].value, token);
  assert.equal(tree.children[1].value, token);
});
test("source numbering remains stable when one source lacks a citation label", () => {
  const unlabelled = { id: "other", title: "Other source" };
  assert.equal(sourceCitationParts(`[${label}]`, [unlabelled, source])[0].number, 2);
});
test("the route guard accepts only supported pages and exact download shapes", () => {
  assert.equal(safeGrowthRoute("/inbox"), "/inbox");
  assert.equal(safeGrowthRoute("/inbox-foreign"), null);
  const download = "/api/agents/tasks/11111111-1111-4111-8111-111111111111/artifacts/22222222-2222-4222-8222-222222222222/download";
  assert.equal(safeGrowthRoute(download), download);
  for (const path of ["//evil.example/workspace", "/\\evil.example/workspace", "https://evil.example/workspace", "/api/admin/export", "/api/agents/tasks/no/artifacts/no/download"]) assert.equal(safeGrowthRoute(path), null);
});
