import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMessageContent, AgentExecutionView, AgentToolRow, AgentSubagentRow, AgentComposer, agentIsActive, formatAgentDuration, mergeAgentEntries, safeAgentLink, orderAgentEntries } from "../dist/agent.js";

test("safe message rendering rejects executable URLs, embedded HTML and remote image loads", () => {
  const html = renderToStaticMarkup(createElement(AgentMessageContent, { text: "[bad](javascript:alert(1)) <script>secret()</script> ![alt](https://tracker.example/pixel) [source](https://example.org/source)" }));
  assert.doesNotMatch(html, /<script|<img|javascript:/);
  assert.match(html, /href="https:\/\/example.org\/source"/);
  assert.match(html, /rel="noreferrer"/);
  assert.match(html, /alt/);
});

test("customer message plain mode retains literal Markdown and escapes HTML", () => {
  const html = renderToStaticMarkup(createElement(AgentMessageContent, { text: "**literal** <img src=x>", format: "plain" }));
  assert.match(html, /\*\*literal\*\*/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<strong>|<img/);
});

test("product link policy can deny sources and cannot introduce executable links", () => {
  for (const resolved of [null, "javascript:alert(1)", "//evil.example/path", "/\\evil.example"]) {
    const html = renderToStaticMarkup(createElement(AgentMessageContent, { text: "[record](https://example.org)", resolveLink: () => resolved }));
    assert.doesNotMatch(html, /<a /);
  }
  assert.equal(safeAgentLink("https://user:password@example.org"), null);
  assert.equal(safeAgentLink("/content/123"), "/content/123");
});

test("entry replay replaces by identity without allowing an older decimal revision", () => {
  const previous = [{ id: "tool", revision: "9007199254740994", state: "completed" }];
  const merged = mergeAgentEntries(previous, [{ id: "tool", revision: "9007199254740993", state: "running" }, { id: "other", revision: "1", state: "running" }]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].state, "completed");
  assert.equal(mergeAgentEntries(previous, [{ id: "tool", revision: "9007199254740995", state: "failed" }])[0].state, "failed");
});

test("tool details obey explicit restricted availability even when an adapter has stale data", () => {
  const html = renderToStaticMarkup(createElement(AgentToolRow, { operation: { id: "op", label: "Read source", state: "completed", details: "stale-private-detail", detailAvailability: "redacted" } }));
  assert.match(html, /Details are restricted/);
  assert.doesNotMatch(html, /stale-private-detail/);
});

test("running subagents are actionable and identical names retain separate task identity", () => {
  const render = id => renderToStaticMarkup(createElement(AgentSubagentRow, { child: { id, name: "Research", state: "running", assignment: "Check the brief" }, onOpen() {} }));
  assert.match(render("a"), /data-subagent-id="a"/);
  assert.match(render("b"), /data-subagent-id="b"/);
  assert.match(render("a"), /aria-label="Open Research activity"/);
  assert.match(render("a"), /<button/);
});

test("completed output remains primary and context is an explicit secondary control", () => {
  const execution = { id: "root", state: "completed", output: "Drafts ready", context: { utilizationPercent: 11, windowTokens: 1000 } };
  const html = renderToStaticMarkup(createElement(AgentExecutionView, { execution }));
  assert.match(html, /Drafts ready/);
  assert.doesNotMatch(html, /Context|Verified/);
  const detailed = renderToStaticMarkup(createElement(AgentExecutionView, { execution, showContext: true }));
  assert.match(detailed, /Context · 11%/);
  assert.match(detailed, /not task progress/);
  assert.equal(agentIsActive("waiting_review"), true);
  assert.equal(agentIsActive("cancel_requested"), true);
  assert.equal(agentIsActive("failed"), false);
});

test("shared composer preserves controlled text and host actions without unsupported features", () => {
  const html = renderToStaticMarkup(createElement(AgentComposer, { value: "A correction", onChange() {}, onSubmit() {}, maxLength: 4000, sending: true, actions: createElement("button", { type: "button" }, "Stop"), context: "Context" }));
  assert.match(html, /A correction/);
  assert.match(html, /maxLength="4000"/);
  assert.match(html, /aria-label="Send message"/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/);
  assert.match(html, />Stop<\/button>/);
  assert.doesNotMatch(html, /type="file"|Voice|Microphone/);
});

test("public updates and operations retain recorded chronology without inventing missing timestamps", () => {
  const ordered = orderAgentEntries([{ id: "late", createdAt: "2026-11-02T10:00:02Z" }, { id: "unknown" }, { id: "early", startedAt: "2026-11-02T10:00:01Z" }, { id: "unknown2", createdAt: "invalid" }]);
  assert.deepEqual(ordered.map(item => item.id), ["early", "late", "unknown", "unknown2"]);
  const html = renderToStaticMarkup(createElement(AgentExecutionView, { execution: {
    id: "task", state: "running", updates: [{ id: "update", text: "Found the brief", createdAt: "2026-11-02T10:00:02Z" }], operations: [{ id: "read", label: "Read brief", state: "completed", startedAt: "2026-11-02T10:00:01Z" }],
  } }));
  assert.ok(html.indexOf("Read brief") < html.indexOf("Found the brief"));
  assert.equal((html.match(/Found the brief/g) ?? []).length, 1);
});


test("execution duration is readable and remains separate from model timings", () => {
  assert.equal(formatAgentDuration(0), "<1s");
  assert.equal(formatAgentDuration(59000), "59s");
  assert.equal(formatAgentDuration(154000), "2m 34s");
  assert.equal(formatAgentDuration(3660000), "1h 1m");
  for (const invalid of [undefined, null, -1, Infinity, NaN]) assert.equal(formatAgentDuration(invalid), null);
  const html = renderToStaticMarkup(createElement(AgentExecutionView, { execution: { id: "turn", state: "completed", elapsedMs: 154000 } }));
  assert.match(html, /aria-label="Execution time"/);
  assert.match(html, /2m 34s/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(AgentExecutionView, { execution: { id: "turn", state: "completed" } })), /Execution time/);
});
