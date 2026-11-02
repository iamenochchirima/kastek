"""Conflict contract v2: independent receiver audit, not adapter assertions."""

import base64
import hashlib
import json
import re


def digest(payload):
    return hashlib.sha256(
        json.dumps(
            payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()


def valid_payload(payload):
    assert set(payload) == {"schema", "resource", "title", "report"}
    assert payload["schema"] == "report-delivery-v1"
    for value in (payload["resource"], payload["title"]):
        assert isinstance(value, str) and 1 <= len(value) <= 120
    report = payload["report"]
    assert set(report) == {"name", "contentType", "digest", "contentBase64"}
    assert isinstance(report["name"], str) and 1 <= len(report["name"]) <= 120
    assert report["contentType"] in ("text/plain", "text/markdown", "application/json")
    assert re.fullmatch("[a-f0-9]{64}", report["digest"])
    content = base64.b64decode(report["contentBase64"], validate=True)
    assert len(content) <= 1_048_576
    assert base64.b64encode(content).decode() == report["contentBase64"]
    assert hashlib.sha256(content).hexdigest() == report["digest"]
    text = content.decode("utf-8")
    if report["contentType"] == "application/json":
        json.loads(text)
    return content


def verify_conflict(audit, receipt, content):
    """Require exactly one accepted native body and one attributed changed-body 409."""
    assert audit["conflictVerified"] is True
    assert audit["receiverPosts"] == 2
    accepted = audit["receipts"]
    assert len(accepted) == 1
    actual = accepted[0]
    assert actual["id"] == receipt["actionId"] == receipt["receipt"]["id"]
    assert (
        actual["payloadDigest"]
        == receipt["payloadDigest"]
        == receipt["receipt"]["payloadDigest"]
    )
    assert actual["artifactDigest"] == receipt["artifactDigest"]
    assert actual["reportContent"].encode() == content
    attempts = audit["attempts"]
    assert len(attempts) == 2
    native = [item for item in attempts if item["actor"] == "native-workflow"]
    probes = [item for item in attempts if item["actor"] == "fixture-negative-probe"]
    assert len(native) == len(probes) == 1
    native, probe = native[0], probes[0]
    assert native["status_code"] == 200 and probe["status_code"] == 409
    for attempt in (native, probe):
        assert attempt["delivery_id"] == actual["id"]
        assert digest(attempt["payload"]) == attempt["payload_digest"]
        assert valid_payload(attempt["payload"]) == content
    assert native["payload_digest"] == actual["payloadDigest"]
    assert probe["payload_digest"] != actual["payloadDigest"]
    assert probe["payload"]["resource"] == native["payload"]["resource"]
    assert probe["payload"] != native["payload"]
