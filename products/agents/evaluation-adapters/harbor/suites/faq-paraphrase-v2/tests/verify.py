"""Transcript verifier v2: same fact/citation rubric, complete native model rounds."""

import json
from rubric import states_approved_opening_time
from transcript import assert_native_transcript, has_required_citation
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
assert states_approved_opening_time(root["output"]), (
    "Answer must state the approved opening time without a conflicting or negated opening claim"
)
assert root["evidenceReferences"], "Source provenance is required"
reference = root["evidenceReferences"][0]
assert reference["source_id"] and reference["revision_id"]
assert has_required_citation(root["output"], reference["citation_label"])
initial = [op for op in root["initialOperations"] if op["name"] == "knowledge.search"]
assert len(initial) == 1 and initial[0]["state"] == "completed"
assert initial[0]["output"]["passages"], (
    "Actual approved retrieval must precede the model"
)
assert root["modelCalls"] and root["modelCalls"][0]["inputMessages"]
trajectory = json.loads((logs / "trajectory.json").read_text())
assert export["effectiveComposition"]["programId"] == "grounded-conversation"
assert_native_transcript(root, trajectory)
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
reward_path.write_text(json.dumps({"grounded_faq": 1.0}))
