"""Native capture contract checks only. No evaluations, model or agent execution."""

import unittest
from uuid import uuid4
from datetime import datetime, timedelta, timezone
import httpx
from kasitek_harbor.growth import GrowthPreparedScope, verify_growth_capture_pins
from kasitek_harbor.growth_client import GrowthClient
from kasitek_harbor.native import ExecutionExport
from fixtures import native_export


def prepared(**pins):
    return GrowthPreparedScope.model_validate(
        {
            "schema_version": "kasitek-growth-prepared-scope.v1",
            "scope_id": str(uuid4()),
            "origin": "http://localhost:3000",
            "business_id": "business",
            "user_id": "staff",
            "feature_id": "assistant",
            "expires_at": (
                datetime.now(timezone.utc) + timedelta(minutes=5)
            ).isoformat(),
            "isolation": "operator-provisioned-per-trial-business",
            **pins,
        }
    )


class CapturePins(unittest.TestCase):
    def test_pins_match_actual_export_and_reject_changed_policy(self):
        native = ExecutionExport.model_validate(native_export())
        verify_growth_capture_pins(
            prepared(
                expected_composition_digest=native.effectiveComposition.digest,
                expected_model_routes_digest=native.modelRoutesDigest,
            ),
            native,
        )
        for pin in ("expected_composition_digest", "expected_model_routes_digest"):
            with self.assertRaises(ValueError):
                verify_growth_capture_pins(prepared(**{pin: "f" * 64}), native)

    def test_model_output_cannot_claim_an_expected_manifest(self):
        value = native_export()
        value["tasks"][0]["untrustedResult"] = {"manifestDigest": "b" * 64}
        native = ExecutionExport.model_validate(value)
        with self.assertRaises(ValueError):
            verify_growth_capture_pins(
                prepared(expected_manifest_digest="b" * 64), native
            )
        value["tasks"][0]["productBindings"] = [
            {"authority": {"kind": "product", "manifestDigest": "b" * 64}}
        ]
        verify_growth_capture_pins(
            prepared(expected_manifest_digest="b" * 64),
            ExecutionExport.model_validate(value),
        )


class CaptureHTTP(unittest.IsolatedAsyncioTestCase):
    async def test_capture_is_bound_to_the_prepared_task_and_conversation(self):
        value = native_export()
        conversation = str(uuid4())
        value["conversationId"] = conversation

        async def respond(_):
            return httpx.Response(200, json={"capture": value})

        async with GrowthClient(
            prepared(),
            "private-session-token-never-log",
            transport=httpx.MockTransport(respond),
        ) as client:
            result = await client.capture(value["rootTaskId"], conversation)
            self.assertEqual(result.rootTaskId, value["rootTaskId"])
            with self.assertRaises(ValueError):
                await client.capture(str(uuid4()), conversation)
            with self.assertRaises(ValueError):
                await client.capture(value["rootTaskId"], str(uuid4()))
