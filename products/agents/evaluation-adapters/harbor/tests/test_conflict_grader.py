"""Independent conflict grading must fail without attributable negative evidence."""

import base64
from copy import deepcopy
import hashlib
import importlib.util
from pathlib import Path
import unittest

path = (
    Path(__file__).parents[1]
    / "suites/controlled-transaction-conflict/tests/conflict.py"
)
spec = importlib.util.spec_from_file_location("conflict_grader", path)
grader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grader)


class ConflictGraderTests(unittest.TestCase):
    def fixture(self):
        content = b"Audited total: 42."
        artifact_digest = hashlib.sha256(content).hexdigest()
        payload = {
            "schema": "report-delivery-v1",
            "resource": "fixture",
            "title": "Approved",
            "report": {
                "name": "report",
                "contentType": "text/plain",
                "digest": artifact_digest,
                "contentBase64": base64.b64encode(content).decode(),
            },
        }
        changed = deepcopy(payload)
        changed["title"] = "Conflicting"
        receipt = {
            "actionId": "delivery",
            "payloadDigest": grader.digest(payload),
            "artifactDigest": artifact_digest,
            "receipt": {"id": "delivery", "payloadDigest": grader.digest(payload)},
        }
        audit = {
            "conflictVerified": True,
            "receiverPosts": 2,
            "receipts": [
                {
                    "id": "delivery",
                    "payloadDigest": grader.digest(payload),
                    "artifactDigest": artifact_digest,
                    "reportContent": content.decode(),
                }
            ],
            "attempts": [
                {
                    "delivery_id": "delivery",
                    "payload_digest": grader.digest(payload),
                    "status_code": 200,
                    "actor": "native-workflow",
                    "payload": payload,
                },
                {
                    "delivery_id": "delivery",
                    "payload_digest": grader.digest(changed),
                    "status_code": 409,
                    "actor": "fixture-negative-probe",
                    "payload": changed,
                },
            ],
        }
        return audit, receipt, content

    def test_accepts_real_conflict_contract(self):
        grader.verify_conflict(*self.fixture())

    def test_rejects_missing_probe_wrong_status_actor_and_extra_accept(self):
        for reason in (
            "absent",
            "status",
            "actor",
            "extra-accept",
            "same-body",
            "invalid-body",
            "wrong-digest",
            "replaced-receipt",
            "unverified",
        ):
            audit, receipt, content = self.fixture()
            if reason == "absent":
                audit["attempts"].pop()
            elif reason == "status":
                audit["attempts"][1]["status_code"] = 200
            elif reason == "actor":
                audit["attempts"][1]["actor"] = "native-workflow"
            elif reason == "extra-accept":
                audit["receipts"].append(deepcopy(audit["receipts"][0]))
            elif reason == "same-body":
                audit["attempts"][1]["payload"] = deepcopy(
                    audit["attempts"][0]["payload"]
                )
                audit["attempts"][1]["payload_digest"] = audit["attempts"][0][
                    "payload_digest"
                ]
            elif reason == "invalid-body":
                audit["attempts"][1]["payload"]["title"] = ""
                audit["attempts"][1]["payload_digest"] = grader.digest(
                    audit["attempts"][1]["payload"]
                )
            elif reason == "wrong-digest":
                audit["attempts"][1]["payload_digest"] = "0" * 64
            elif reason == "replaced-receipt":
                audit["receipts"][0]["payloadDigest"] = audit["attempts"][1][
                    "payload_digest"
                ]
            else:
                audit["conflictVerified"] = False
            with self.subTest(reason=reason), self.assertRaises(AssertionError):
                grader.verify_conflict(audit, receipt, content)
