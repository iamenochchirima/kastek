"""Model scope pins fail closed before evaluation evidence is accepted."""

from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

import httpx
from pydantic import ValidationError

from kasitek_harbor.agent import KasitekAgent
from kasitek_harbor.client import PlatformClient
from kasitek_harbor.config import PreparedScope
from kasitek_harbor.native import ExecutionExport, model_routes_digest
from kasitek_harbor.persistence import persist
from kasitek_harbor.trajectory import to_atif, to_atif_turns, UnsupportedMapping
from fixtures import native_export
from test_boundaries import scope_value


def scope_for(raw):
    return PreparedScope.model_validate(
        {
            **scope_value(),
            "organization_id": raw["organizationId"],
            "agent_id": raw["agentId"],
            "version_id": raw["versionId"],
            "model_routes_digest": raw["modelRoutesDigest"],
        }
    )


class ModelEvidenceTests(unittest.TestCase):
    def test_digest_matches_platform_canonical_json_with_unicode_and_integer_limits(
        self,
    ):
        self.assertEqual(
            model_routes_digest(
                {
                    "z": None,
                    "provider": "é-model",
                    "count": 2147483647,
                    "roles": ["primary", "compaction"],
                    "active": True,
                }
            ),
            "453dd312d813edc40d59d0feca975f01d5ceb388faefb129ef329136a24d5ef7",
        )

    def test_routes_and_call_policy_survive_atif_with_delegated_role(self):
        raw = native_export(with_child=True)
        trajectory = to_atif(ExecutionExport.model_validate(raw))
        self.assertEqual(
            trajectory.extra["modelRoutesDigest"], raw["modelRoutesDigest"]
        )
        call = next(step for step in trajectory.steps if step.source == "agent")
        self.assertEqual(
            call.extra["modelBinding"], raw["tasks"][0]["modelCalls"][0]["modelBinding"]
        )
        self.assertEqual(
            trajectory.subagent_trajectories[0].extra["modelRoutes"]["primary"][
                "binding"
            ]["role"],
            "delegated",
        )

    def test_missing_and_contradictory_model_evidence_is_rejected(self):
        for corruption in (
            "missing",
            "digest",
            "binding",
            "policy",
            "compaction",
            "task_root",
        ):
            raw = native_export()
            task = raw["tasks"][0]
            with (
                self.subTest(corruption=corruption),
                self.assertRaises(ValidationError),
            ):
                if corruption == "missing":
                    del raw["modelRoutes"]
                elif corruption == "digest":
                    raw["modelRoutesDigest"] = task["modelRoutesDigest"] = "f" * 64
                elif corruption == "binding":
                    task["modelCalls"][0]["modelBinding"]["connectionId"] = str(uuid4())
                elif corruption == "policy":
                    task["modelCalls"][0]["effectivePolicy"]["maxRootTokens"] = 32768
                elif corruption == "compaction":
                    task["compactions"] = [
                        {
                            "modelBinding": task["modelRoutes"]["primary"]["binding"],
                            "effectivePolicy": task["modelRoutes"]["primary"]["policy"],
                        }
                    ]
                else:
                    task["modelRoutes"] = deepcopy(task["modelRoutes"])
                    task["modelRoutes"]["primary"]["policy"]["maxRootTokens"] = 32768
                    task["modelRoutesDigest"] = model_routes_digest(task["modelRoutes"])
                ExecutionExport.model_validate(raw)

    def test_child_snapshot_cannot_change_provider_identity_or_expand_policy(self):
        for mutation in ("identity", "budget"):
            raw = native_export(with_child=True)
            child = raw["tasks"][1]
            if mutation == "identity":
                child["modelRoutes"]["primary"]["binding"]["connectionId"] = str(
                    uuid4()
                )
            else:
                child["modelRoutes"]["primary"]["policy"]["maxRootTokens"] += 1
            child["modelRoutesDigest"] = model_routes_digest(child["modelRoutes"])
            child["modelCalls"][0]["modelBinding"] = child["modelRoutes"]["primary"][
                "binding"
            ]
            child["modelCalls"][0]["effectivePolicy"] = child["modelRoutes"]["primary"][
                "policy"
            ]
            with self.subTest(mutation=mutation), self.assertRaises(ValidationError):
                ExecutionExport.model_validate(raw)

    def test_scope_requires_new_pins_and_exact_adapter_allocation(self):
        value = scope_value()
        for change in (
            {"schema_version": "kasitek-prepared-scope.v1"},
            {"root_token_limit": 32769},
            {"model_routes_digest": "invalid"},
        ):
            with self.subTest(change=change), self.assertRaises(ValidationError):
                PreparedScope.model_validate({**value, **change})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "scope.json"
            persist(path, value)
            agent = KasitekAgent(
                logs_dir=Path(directory) / "logs",
                scope_path=str(path),
                root_token_limit=8192,
            )
            agent.context_id = uuid4()
            with self.assertRaisesRegex(ValueError, "prepared model policy"):
                agent._mapping("Public question")

    def test_conversation_cannot_switch_a_valid_model_snapshot_between_turns(self):
        first = native_export()
        first["conversationId"] = str(uuid4())
        second = deepcopy(first)
        second["rootTaskId"] = second["tasks"][0]["id"] = str(uuid4())
        for route in second["modelRoutes"].values():
            route["binding"]["connectionId"] = str(uuid4())
        second["tasks"][0]["modelRoutes"] = second["modelRoutes"]
        second["modelRoutesDigest"] = second["tasks"][0]["modelRoutesDigest"] = (
            model_routes_digest(second["modelRoutes"])
        )
        for call in second["tasks"][0]["modelCalls"]:
            call["modelBinding"] = second["modelRoutes"]["primary"]["binding"]
        with self.assertRaises(UnsupportedMapping):
            to_atif_turns(
                [
                    ExecutionExport.model_validate(first),
                    ExecutionExport.model_validate(second),
                ]
            )


class ModelTransportPinsTests(unittest.IsolatedAsyncioTestCase):
    async def test_prepare_and_recovery_lookup_reject_changed_pins(self):
        raw = native_export()
        scope = scope_for(raw)
        native_id, trial_key = str(uuid4()), "harbor:scope:context"
        request = {
            "trialId": trial_key,
            "expectedModelRoutesDigest": scope.model_routes_digest,
            "rootTokenLimit": scope.root_token_limit,
            "maxTokens": scope.max_tokens,
        }
        prefix = f"/api/organizations/{scope.organization_id}"
        for field, wrong in (
            ("modelRoutesDigest", "f" * 64),
            ("rootTokenLimit", 8192),
            ("maxTokens", 65536),
        ):
            trial = {
                "id": native_id,
                "trialId": trial_key,
                "organizationId": str(scope.organization_id),
                "agentId": str(scope.agent_id),
                "versionId": str(scope.version_id),
                "compositionDigest": scope.composition_digest,
                "modelRoutesDigest": scope.model_routes_digest,
                "rootTokenLimit": scope.root_token_limit,
                "maxTokens": scope.max_tokens,
                "state": "active",
                field: wrong,
            }
            response = {
                "trial": trial,
                "rootTaskIds": [],
                "submitPath": prefix + "/tasks",
                "taskBinding": {"evaluationTrialId": native_id},
                "revokePath": prefix + f"/evaluation-trials/{native_id}/revoke",
            }
            async with PlatformClient(
                scope,
                "private-session-token-never-log",
                timeout=1,
                transport=httpx.MockTransport(
                    lambda _: httpx.Response(200, json=response)
                ),
            ) as client:
                with self.subTest(field=field), self.assertRaises(ValueError):
                    await client.prepare(request)
                with self.subTest(field=field), self.assertRaises(ValueError):
                    await client.trial(native_id=native_id)

    async def test_export_must_match_the_prepared_digest_and_root_allocation(self):
        raw = native_export()
        scope = scope_for(raw)
        async with PlatformClient(
            scope,
            "private-session-token-never-log",
            timeout=1,
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=raw)),
        ) as client:
            await client.history(raw["rootTaskId"])
        wrong_scope = scope.model_copy(update={"model_routes_digest": "f" * 64})
        async with PlatformClient(
            wrong_scope,
            "private-session-token-never-log",
            timeout=1,
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=raw)),
        ) as client:
            with self.assertRaises(ValueError):
                await client.history(raw["rootTaskId"])
        wrong_scope = scope.model_copy(update={"root_token_limit": 8192})
        async with PlatformClient(
            wrong_scope,
            "private-session-token-never-log",
            timeout=1,
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=raw)),
        ) as client:
            with self.assertRaises(ValueError):
                await client.history(raw["rootTaskId"])
