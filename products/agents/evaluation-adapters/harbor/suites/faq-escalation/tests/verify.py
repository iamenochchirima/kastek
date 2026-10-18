"""Successful human escalation is distinct from the deliberately incomplete model task."""

import json
from pathlib import Path

logs = Path("/logs/agent")
reward = Path("/logs/verifier/reward.json")
reward.write_text(json.dumps({"grounded_faq": 0.0}))
export = json.loads((logs / "native-export.json").read_text())
result = json.loads((logs / "evaluation-result.json").read_text())
channel = json.loads((logs / "native-channel-history.json").read_text())
assert result["mappingStatus"] == "supported"
assert result["nativeOutcome"] == "incomplete" and result["scriptCompleted"] is False
assert (
    result["cleanup"]["revocationConfirmed"] and result["cleanup"]["terminalConfirmed"]
)
assert channel["conversation"]["state"] == "handoff_pending"
assert [command["action"] for command in channel["commands"]] == ["request_handoff"]
assert [message["author_kind"] for message in channel["messages"]] == ["visitor"]
assert len(channel["deliveries"]) == 1
assert channel["deliveries"][0]["state"] == "suppressed"
assert channel["deliveries"][0]["reason"] == "ownership_changed"
assert channel["deliveries"][0]["message_id"] is None
assert channel["deliveries"][0]["task_id"] == export["rootTaskId"]
root = next(task for task in export["tasks"] if task["id"] == export["rootTaskId"])
assert len(root["modelCalls"]) == 1
call = root["modelCalls"][0]
assert (
    call["outputMessage"]["tool_calls"][0]["function"]["name"]
    == "channel_request_handoff"
)
receipt = call["toolResults"][0]
assert receipt["state"] == "completed" and receipt["nativeOutput"] == {
    "state": "handoff_pending"
}
assert channel["commands"][0]["command_id"] == root["id"]
reward.write_text(json.dumps({"grounded_faq": 1.0}))
