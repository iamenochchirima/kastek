"""Harbor checks native absence of scoped evidence; provider response is a fixture."""

import json
from pathlib import Path

logs = Path("/logs/agent")
reward = Path("/logs/verifier/reward.json")
reward.write_text(json.dumps({"grounded_faq": 0.0}))
export = json.loads((logs / "native-export.json").read_text())
result = json.loads((logs / "evaluation-result.json").read_text())
assert (
    result["nativeOutcome"] == "completed" and result["cleanup"]["revocationConfirmed"]
)
assert result["cleanup"]["terminalConfirmed"] and result["mappingStatus"] == "supported"
for field in (
    "modelInputs",
    "modelOutputs",
    "toolCalls",
    "toolResults",
    "children",
    "observations",
):
    assert export["coverage"][field]["status"] == "complete", field
assert len(export["tasks"]) == 1
root = export["tasks"][0]
assert root["output"] == "The approved sources do not answer that question."
assert len(root["modelCalls"]) == 1
assert not root["evidenceReferences"]
initial = [op for op in root["initialOperations"] if op["name"] == "knowledge.search"]
assert len(initial) == 1 and initial[0]["state"] == "completed"
assert initial[0]["output"]["passages"] == []
assert "CONFIDENTIAL-CODE-7429" not in json.dumps(export)
assert "Harbor fixture opens at nine." not in json.dumps(
    root["modelCalls"][0]["inputMessages"]
)
reward.write_text(json.dumps({"grounded_faq": 1.0}))
