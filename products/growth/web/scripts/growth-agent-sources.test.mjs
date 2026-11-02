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

// The explicit router must retain the complete audited URL contract.
const { readFileSync } = await import("node:fs");
const { checkRouteContract } = await import("./check-canonical-routes.mjs");
const routeSource = readFileSync(new URL("../src/routes.ts", import.meta.url), "utf8");
const routeContract = JSON.parse(readFileSync(new URL("./route-contract.json", import.meta.url), "utf8"));
test("all 50 audited routes are mounted once with their original modules", () => {
  assert.deepEqual(checkRouteContract(routeSource, routeContract, () => true), []);
});
test("route validation catches missing, duplicate and unrecorded routes", () => {
  assert.ok(checkRouteContract(routeSource.replace('route("calls", "app/(dashboard)/calls/page.tsx"),', ""), routeContract, () => true).includes("canonical route is missing: /calls"));
  const duplicate = routeSource.replace('route("calls",', 'route("inbox",');
  assert.ok(checkRouteContract(duplicate, routeContract, () => true).includes("duplicate configured route: /inbox"));
  const unknown = routeSource.replace('route("calls",', 'route("unknown",');
  assert.ok(checkRouteContract(unknown, routeContract, () => true).includes("route is absent from the contract: /unknown"));
});
test("route validation rejects a wrong module, missing file and incomplete baseline", () => {
  const wrongModule = routeSource.replace('"app/(dashboard)/calls/page.tsx"', '"app/(dashboard)/inbox/page.tsx"');
  assert.ok(checkRouteContract(wrongModule, routeContract, () => true).includes("route module changed without a contract update: /calls"));
  assert.ok(checkRouteContract(routeSource, routeContract, file => !file.includes("calls/")).includes("route module is missing: app/(dashboard)/calls/page.tsx"));
  assert.ok(checkRouteContract(routeSource, { routes: routeContract.routes.slice(1) }, () => true).includes("baseline must contain all 50 audited routes"));
});

const ts = (await import("typescript")).default;
const { createRequire } = await import("node:module");
const { runInThisContext } = await import("node:vm");
const requireModule = createRequire(import.meta.url);
function loadPageModule(file, api = {}) {
  const text = readFileSync(new URL(`../src/app/${file}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  runInThisContext(`(function(require, exports) { ${compiled}\n})`, { filename: file })(
    name => {
      if (name === "react-router" || name === "react/jsx-runtime") return requireModule(name);
      if (name === "@/lib/core-auth") return { getWorkspaceSession: async () => ({ user: { id: "member" } }), getCoreSession: async () => ({ user: { id: "member" } }) };
      if (name === "@/lib/core-server-api") return api;
      return {};
    }, exports,
  );
  return exports;
}
function loaderArgs(path) {
  return { request: new Request(`https://growth.example${path}`), params: { id: "record" } };
}
test("billing and profile aliases retain payment receipts and query values", async () => {
  const billing = loadPageModule("(dashboard)/billing/page.tsx");
  await assert.rejects(() => billing.clientLoader(loaderArgs("/billing?payment=success&reference=receipt-1&trxref=receipt-2")), error => {
    assert.equal(error.status, 302);
    assert.equal(error.headers.get("Location"), "/workspace/settings?section=billing&payment=success&reference=receipt-1&trxref=receipt-2");
    return true;
  });
  const profile = loadPageModule("(dashboard)/workspace/profile/page.tsx");
  await assert.rejects(() => profile.clientLoader(loaderArgs("/workspace/profile?section=wrong&token=first&token=second")), error => {
    assert.equal(error.headers.get("Location"), "/workspace/settings?section=profile&token=first");
    return true;
  });
});
test("account aliases leave the SPA for the backend account endpoint", () => {
  for (const file of ["set-password", "verify-request"]) {
    const page = loadPageModule(`(auth)/${file}/page.tsx`);
    assert.throws(() => page.clientLoader(), error => {
      assert.equal(error.headers.get("Location"), "/api/auth/account");
      assert.equal(error.headers.get("X-Remix-Reload-Document"), "true");
      return true;
    });
  }
});
test("private page metadata remains excluded from indexing when it sets a title", () => {
  const page = loadPageModule("(dashboard)/agents/page.tsx");
  assert.ok(page.meta().some(meta => meta.name === "robots" && meta.content === "noindex, nofollow"));
});
test("record loaders preserve real not-found errors without hiding backend failures", async () => {
  class TestApiError extends Error { constructor(status) { super("API failure"); this.status = status; } }
  for (const file of ["contacts", "campaigns", "content/posts"]) {
    for (const status of [404, 503]) {
      const apiError = new TestApiError(status);
      const page = loadPageModule(`(dashboard)/${file}/[id]/page.tsx`, { ApiError: TestApiError, fetchCoreJson: async () => { throw apiError; } });
      await assert.rejects(() => page.clientLoader(loaderArgs(`/${file}/record`)), error => {
        if (status === 404) assert.equal(error.status, 404);
        else assert.equal(error, apiError);
        return true;
      });
    }
  }
});
