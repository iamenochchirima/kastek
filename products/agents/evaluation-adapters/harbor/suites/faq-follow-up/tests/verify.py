"""Harbor verifier: inspect authorized native receipts, never agent claims alone."""

import json
from pathlib import Path

logs = Path("/logs/agent")
reward_path = Path("/logs/verifier/reward.json")
reward_path.write_text(json.dumps({"grounded_faq": 0.0}))
export = json.loads((logs / "native-export.json").read_text())
metadata = json.loads((logs / "evaluation-result.json").read_text())
assert export["schemaVersion"] == "execution-export.v1"
assert metadata["mappingStatus"] == "supported"
assert metadata["nativeOutcome"] == "completed"
assert metadata["cleanup"]["revocationConfirmed"] is True
assert metadata["cleanup"]["terminalConfirmed"] is True
for name in (
    "modelInputs",
    "modelOutputs",
    "toolCalls",
    "toolResults",
    "children",
    "observations",
):
    assert export["coverage"][name]["status"] == "complete", name
root = next(task for task in export["tasks"] if task["id"] == export["rootTaskId"])
assert len(export["tasks"]) == 1
assert root["parentTaskId"] is None
assert root["state"] == "completed"
assert "nine" in root["output"].lower()
assert root["evidenceReferences"], "Source provenance is required"
reference = root["evidenceReferences"][0]
assert reference["source_id"] and reference["revision_id"]
assert f"[{reference['citation_label']}]" in root["output"]
initial = [op for op in root["initialOperations"] if op["name"] == "knowledge.search"]
assert len(initial) == 1 and initial[0]["state"] == "completed"
assert initial[0]["output"]["passages"], (
    "Actual approved retrieval must precede the model"
)
assert root["modelCalls"] and root["modelCalls"][0]["inputMessages"]
assert root["modelCalls"][0]["outputMessage"]["content"] == root["output"]
assert any(
    "nine" in (message.get("content") or "").lower()
    for message in root["modelCalls"][0]["inputMessages"]
)
assert (
    export["effectiveComposition"]["digest"] == export["compositionSnapshot"]["digest"]
)
assert export["observations"] and all(
    observation["schemaVersion"] == "agent.observation.v1"
    for observation in export["observations"]
)
turns = json.loads((logs / "conversation-turns.json").read_text())
assert len(turns) == 2
assert turns[0]["id"] == "initial" and turns[1]["id"] == "confirm-hours"
assert turns[0]["taskId"] != turns[1]["taskId"]
assert (
    turns[0]["conversationId"] == turns[1]["conversationId"] == export["conversationId"]
)
first = json.loads((logs / turns[0]["nativeEvidenceFile"]).read_text())
first_root = next(task for task in first["tasks"] if task["id"] == first["rootTaskId"])
assert any(
    message["role"] == "assistant" and message["content"] == first_root["output"]
    for message in root["modelCalls"][0]["inputMessages"]
)
trajectory = json.loads((logs / "trajectory.json").read_text())
assert len(trajectory["extra"]["nativeConversationTurns"]) == 2
assert len([step for step in trajectory["steps"] if step["source"] == "user"]) == 2

reward_path.write_text(json.dumps({"grounded_faq": 1.0}))
