"""Grade native sandbox execution, private artifact bytes and actual cleanup facts."""

import hashlib
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

logs = Path("/logs/agent")
reward = Path("/logs/verifier/reward.json")
reward.write_text(json.dumps({"isolated_analysis": 0.0}))
metadata = json.loads((logs / "evaluation-result.json").read_text())
assert metadata["mappingStatus"] == "supported"
assert metadata["nativeOutcome"] == "completed"
assert metadata["scriptCompleted"] is True
assert metadata["cleanup"]["revocationConfirmed"]
assert metadata["cleanup"]["terminalConfirmed"]
export = json.loads((logs / "native-export.json").read_text())
for key in (
    "modelInputs",
    "modelOutputs",
    "toolCalls",
    "toolResults",
    "artifacts",
    "observations",
):
    assert export["coverage"][key]["status"] == "complete", key
root = next(task for task in export["tasks"] if task["id"] == export["rootTaskId"])
assert len(root["modelCalls"]) == 2
planning, answer = root["modelCalls"]
assert (
    planning["outputMessage"]["tool_calls"][0]["function"]["name"] == "sandbox_analyze"
)
receipt = planning["toolResults"][0]
assert receipt["observedByOperationId"] == answer["operationId"]
native = receipt["nativeOutput"]
assert native["state"] == "completed" and native["exitCode"] == 0
assert native["stdout"].strip() == "42"
artifact = next(item for item in export["artifacts"] if item["name"] == "analysis.json")
content = (logs / "artifacts" / (artifact["id"] + ".bin")).read_bytes()
assert hashlib.sha256(content).hexdigest() == artifact["contentDigest"]
analysis = json.loads(content)
assert analysis["values"] == [7, 11, 24]
assert analysis["total"] == sum(analysis["values"]) == 42
assert artifact["id"] == native["artifacts"][0]["id"]
request = Request(
    os.environ["KASITEK_VERIFIER_ANALYSIS_URL"],
    headers={"authorization": "Bearer " + os.environ["KASITEK_VERIFIER_ANALYSIS_KEY"]},
)
with urlopen(request, timeout=10) as response:
    allocations = json.load(response)["allocations"]
assert len(allocations) == 1
allocation = allocations[0]
assert allocation["id"] == native["allocationId"]
assert allocation["task_id"] == root["id"]
assert allocation["operation_id"] == receipt["operationId"]
assert allocation["command_id"] == native["commandId"]
assert allocation["profile_id"] == "python-analysis-v1"
assert allocation["state"] == "destroyed"
assert allocation["command_state"] == "completed" and allocation["exit_code"] == 0
assert allocation["export_receipt"]["artifactRefs"][0]["id"] == artifact["id"]
reward.write_text(json.dumps({"isolated_analysis": 1.0}))
