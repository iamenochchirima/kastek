"""Grade actual search evidence, reviewed artifact and independent receiver state."""

import hashlib
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

from conflict import verify_conflict

logs = Path("/logs/agent")
reward_path = Path("/logs/verifier/reward.json")
reward_path.write_text(json.dumps({"research_report": 0.0}))
export = json.loads((logs / "native-export.json").read_text())
metadata = json.loads((logs / "evaluation-result.json").read_text())
assert (
    metadata["mappingStatus"] == "supported"
    and metadata["nativeOutcome"] == "completed"
)
assert metadata["scriptCompleted"] is True
assert (
    metadata["cleanup"]["revocationConfirmed"]
    and metadata["cleanup"]["terminalConfirmed"]
)
for key in (
    "modelInputs",
    "modelOutputs",
    "toolCalls",
    "toolResults",
    "children",
    "artifacts",
    "observations",
    "effects",
):
    assert export["coverage"][key]["status"] == "complete", key
root = next(task for task in export["tasks"] if task["id"] == export["rootTaskId"])
assert len(root["modelCalls"]) == 2
call = root["modelCalls"][0]
assert call["outputMessage"]["tool_calls"][0]["function"]["name"] == "knowledge_search"
result = call["toolResults"][0]
assert result["operationId"].startswith(f"tool:{root['id']}:")
assert result["toolCallId"] == call["outputMessage"]["tool_calls"][0]["id"]
assert result["observedByOperationId"] == root["modelCalls"][1]["operationId"]
assert result["nativeOutput"]["passages"]
assert "42" in root["output"] and root["evidenceReferences"]
assert len(export["effectReceipts"]) == 1
receipt = export["effectReceipts"][0]
assert (
    receipt["schemaVersion"] == "report-delivery-receipt.v1"
    and receipt["state"] == "delivered"
)
assert receipt["approvedAt"] and receipt["claimedAt"]
assert any(decision["state"] == "approved" for decision in receipt["reviewRecords"])
artifact = next(
    item for item in export["artifacts"] if item["id"] == receipt["artifactId"]
)
content = (logs / "artifacts" / (artifact["id"] + ".bin")).read_bytes()
assert (
    hashlib.sha256(content).hexdigest()
    == receipt["artifactDigest"]
    == artifact["contentDigest"]
)
assert "42" in content.decode()
# A distinct verifier-only credential reads the actual isolated receiver's database.
request = Request(
    os.environ["KASITEK_VERIFIER_RECEIVER_URL"] + "/verification/receipts",
    headers={"authorization": "Bearer " + os.environ["KASITEK_VERIFIER_READ_KEY"]},
)
with urlopen(request, timeout=10) as response:
    audit = json.load(response)
verify_conflict(audit, receipt, content)
reward_path.write_text(json.dumps({"research_report": 1.0}))
