"""Withdrawn source payloads cannot establish a passing answer-quality grade."""

import json
from pathlib import Path

logs = Path("/logs/agent")
result = json.loads((logs / "evaluation-result.json").read_text())
export = json.loads((logs / "native-export.json").read_text())
assert result["nativeOutcome"] == "completed"
assert export["coverage"]["modelInputs"]["status"] == "partial"
assert export["coverage"]["modelOutputs"]["status"] == "partial"
assert all(
    task["input"] is None and task["output"] is None and not task["modelCalls"]
    for task in export["tasks"]
)
assert "Harbor fixture opens at nine." not in json.dumps(export)
Path("/logs/verifier/classification.json").write_text(
    json.dumps({"classification": "inconclusive", "reason": "current-source-withdrawal"})
)
# No reward is emitted: missing authorized answer evidence cannot mean success.
