import assert from "node:assert/strict";
import { agentVersionOptionLabel } from "./agent-version-state";

const deployments = {
  playground: { version: { versionId: "version-2" } },
  live: { version: { versionId: "version-1" } },
};

assert.equal(agentVersionOptionLabel({ id: "version-2", version_number: 2, status: "published" }, deployments), "v2 · Test");
assert.equal(agentVersionOptionLabel({ id: "version-1", version_number: 1, status: "published" }, deployments), "v1 · Live");
assert.equal(agentVersionOptionLabel({ id: "version-3", version_number: 3, status: "draft" }, deployments), "v3 · Draft");
assert.equal(agentVersionOptionLabel({ id: "version-4", version_number: 4, status: "published" }, deployments), "v4 · Saved");
assert.equal(agentVersionOptionLabel({ id: "version-1", version_number: 1, status: "published" }, {
  playground: { version: { versionId: "version-1" } },
  live: { version: { versionId: "version-1" } },
}), "v1 · Test · Live");

console.log("agent version lifecycle labels: ok");
