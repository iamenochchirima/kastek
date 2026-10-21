"""Judge canonical delivery evidence; a model reply alone cannot establish a send."""

import json
from pathlib import Path

logs = Path("/logs/agent")
reward = Path("/logs/verifier/reward.json")
reward.write_text(json.dumps({"channel_delivery_evidence": 0.0}))
history = json.loads((logs / "native-channel-history.json").read_text())
result = json.loads((logs / "evaluation-result.json").read_text())
export = json.loads((logs / "native-export.json").read_text())
assert result["mappingStatus"] == "supported"
assert history["fixture"]["kind"] in {"telegram", "whatsapp", "facebook", "instagram"}
assert len(history["rootTaskIds"]) == 1
assert (
    history["conversation"]["channel_deployment_id"]
    == history["fixture"]["deploymentId"]
)
assert history["rootTaskIds"][0] == export["tasks"][0]["id"]
assert len(history["effects"]) >= 1
assert len({item["id"] for item in history["effects"]}) == len(history["effects"])
for effect in history["effects"]:
    assert len(effect["request_digest"]) == 64
    assert effect["outcome"] in {"accepted", "rejected", "lost_ack"}
    assert bool(effect["provider_message_id"]) == (effect["outcome"] != "rejected")
# Native acceptance is not delivered/read, and a lost acknowledgement stays uncertain.
for delivery in history["deliveries"]:
    assert delivery["state"] in {
        "accepted",
        "sent",
        "delivered",
        "read",
        "failed",
        "unknown",
        "suppressed",
    }
    if delivery["state"] == "accepted":
        assert delivery["provider_message_id"]
if any(effect["outcome"] == "lost_ack" for effect in history["effects"]):
    assert any(delivery["state"] == "unknown" for delivery in history["deliveries"])
reward.write_text(json.dumps({"channel_delivery_evidence": 1.0}))
