"""Check native activation/read receipts against the actual isolated provider namespace."""
import hashlib
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

logs = Path("/logs/agent")
reward = Path("/logs/verifier/reward.json")
reward.write_text(json.dumps({"connector_skill": 0.0}))
export = json.loads((logs / "native-export.json").read_text())
metadata = json.loads((logs / "evaluation-result.json").read_text())
assert metadata["mappingStatus"] == "supported"
assert metadata["nativeOutcome"] == "completed"
assert metadata["cleanup"]["revocationConfirmed"] is True
assert metadata["cleanup"]["terminalConfirmed"] is True
for name in ("modelInputs", "modelOutputs", "toolCalls", "toolResults", "children", "observations"):
    assert export["coverage"][name]["status"] == "complete", name
assert len(export["tasks"]) == 1
root = export["tasks"][0]
assert root["id"] == export["rootTaskId"] and root["state"] == "completed"
assert len(root["modelCalls"]) == 3
activation, connector, answer = root["modelCalls"]
assert activation["outputMessage"]["tool_calls"][0]["function"]["name"] == "skills_activate"
activated = activation["toolResults"][0]
assert activated["state"] == "completed"
skill = activated["nativeOutput"]
assert skill["evidence"]["path"] == "SKILL.md"
assert skill["evidence"]["packageDigest"]
assert any(skill["content"] in (message.get("content") or "") for message in connector["inputMessages"])
called = connector["outputMessage"]["tool_calls"][0]
result = connector["toolResults"][0]
assert result["state"] == "completed" and result["toolCallId"] == called["id"]
assert result["observedByOperationId"] == answer["operationId"]
observed = result["nativeOutput"]
assert observed["status"] == "ok"
assert observed["evidence"]["citation"] in root["output"]
request = Request(os.environ["KASITEK_VERIFIER_CONNECTOR_URL"], headers={"authorization": "Bearer " + os.environ["KASITEK_VERIFIER_CONNECTOR_KEY"]})
with urlopen(request, timeout=10) as response:
    provider = json.load(response)
assert provider["deniedRequests"] == 0
assert provider["skill"]["id"] == skill["skillId"]
assert provider["skill"]["content_digest"] == provider["skill"]["reviewed_digest"] == skill["evidence"]["packageDigest"]
assert provider["binding"]["id"] == observed["bindingId"]
assert any(binding["id"] == provider["binding"]["id"] and binding["digest"] == provider["binding"]["digest"] for binding in export["compositionSnapshot"]["connectedBindings"])
assert len(provider["reads"]) == 1
read = provider["reads"][0]
assert read["method"] == "GET" and read["namespace"] == provider["namespace"]
assert read["path"] == "/api/records/" + provider["namespace"]
canonical = json.dumps(provider["record"], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
assert hashlib.sha256(canonical.encode()).hexdigest() == provider["recordDigest"] == read["recordDigest"]
assert json.loads(called["function"]["arguments"]) == {"path": {"namespace": provider["namespace"]}}
assert provider["record"]["answer"] in observed["content"]
assert provider["record"]["answer"] in root["output"]
assert provider["namespace"] in observed["content"]
assert not export["effectReceipts"], "A policy read cannot establish a mutation outcome"
assert export["effectiveComposition"]["digest"] == export["compositionSnapshot"]["digest"]
trajectory = json.loads((logs / "trajectory.json").read_text())
assert trajectory["trajectory_id"] == root["id"]
reward.write_text(json.dumps({"connector_skill": 1.0}))
