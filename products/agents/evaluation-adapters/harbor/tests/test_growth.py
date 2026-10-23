"""Pure Growth HTTP/mapping contracts. No evaluations, native execution or models."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

import httpx
from pydantic import ValidationError

from kasitek_harbor.growth import (
    GrowthAdapterOptions,
    GrowthHarborAgent,
    GrowthPreparedScope,
    private_json,
)
from kasitek_harbor.growth_client import GrowthClient, GrowthRequestError
from kasitek_harbor.persistence import persist


def scope_value(feature="assistant"):
    return {
        "schema_version": "kasitek-growth-prepared-scope.v1",
        "scope_id": str(uuid4()),
        "origin": "http://127.0.0.1:3101",
        "business_id": "trial-business",
        "user_id": "trial-staff",
        "feature_id": feature,
        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
        "max_turns": 2,
        "isolation": "operator-provisioned-per-trial-business",
    }


def bootstrap(scope):
    return {
        "scope": {"businessId": scope.business_id, "userId": scope.user_id},
        "features": [{"id": scope.feature_id, "ready": True}],
    }


class GrowthScopeTests(unittest.TestCase):
    def test_all_features_are_product_scoped_and_forbid_hidden_grader_or_standalone_identity_fields(
        self,
    ):
        for feature in ("assistant", "research", "content", "campaigns"):
            self.assertEqual(
                GrowthPreparedScope.model_validate(scope_value(feature)).feature_id,
                feature,
            )
        for extra in (
            {"organization_id": str(uuid4())},
            {"expected_answer": "hidden"},
            {"session": "secret"},
        ):
            with self.assertRaises(ValidationError):
                GrowthPreparedScope.model_validate({**scope_value(), **extra})
        for origin in (
            "http://169.254.169.254",
            "https://u:p@example.test",
            "https://example.test/path",
        ):
            with self.assertRaises(ValidationError):
                GrowthPreparedScope.model_validate({**scope_value(), "origin": origin})
        with self.assertRaises(ValidationError):
            GrowthAdapterOptions(
                scope_path=Path("/private/scope.json"), expected_answer="hidden"
            )
        self.assertFalse(GrowthHarborAgent.capabilities.atif)

    def test_one_prepared_business_is_claimed_by_one_harbor_trial_and_requests_recover_stably(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "scope.json"
            persist(path, scope_value())
            agent = GrowthHarborAgent(
                logs_dir=root / "logs",
                scope_path=str(path),
                follow_ups=[{"id": "follow", "instruction": "Continue"}],
            )
            agent.context_id = uuid4()
            scope = agent._scope()
            mapping, _ = agent._mapping(scope, "Start")
            recovered, _ = agent._mapping(scope, "Start")
            self.assertEqual(
                mapping["conversationRequest"], recovered["conversationRequest"]
            )
            self.assertNotEqual(
                mapping["turns"][0]["request"]["requestId"],
                mapping["turns"][1]["request"]["requestId"],
            )
            with self.assertRaises(ValueError):
                agent._mapping(scope, "Changed instruction")
            agent.context_id = uuid4()
            with self.assertRaises(ValueError):
                agent._mapping(scope, "Start")
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                private_json(path)


class GrowthHttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_cookie_business_pin_and_bootstrap_reject_another_user_without_standalone_routes(
        self,
    ):
        scope = GrowthPreparedScope.model_validate(scope_value())
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(
                200,
                json={
                    **bootstrap(scope),
                    "scope": {"businessId": "foreign", "userId": scope.user_id},
                },
                headers={"set-cookie": "kasitek_active_org=foreign"},
            )

        async with GrowthClient(
            scope,
            "private-session-token-never-log",
            transport=httpx.MockTransport(respond),
        ) as client:
            with self.assertRaises(ValueError):
                await client.bootstrap()
            with self.assertRaises(ValueError):
                await client.request("GET", "/api/organizations/foreign/tasks")
            with self.assertRaises(ValueError):
                await client.request("GET", "/api/agents/../orgs")
        self.assertEqual(requests[0].url.path, "/api/agents/bootstrap")
        self.assertIn(
            "kasitek_active_org=trial-business", requests[0].headers["cookie"]
        )
        self.assertEqual(requests[0].headers["origin"], scope.origin)
        self.assertNotIn("authorization", requests[0].headers)

    async def test_redirect_error_text_and_oversized_responses_never_become_evidence(
        self,
    ):
        scope = GrowthPreparedScope.model_validate(scope_value())
        async with GrowthClient(
            scope,
            "private-session-token-never-log",
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    302,
                    headers={"location": "https://foreign.example"},
                    json={"secret": "do-not-reflect"},
                )
            ),
        ) as client:
            with self.assertRaises(GrowthRequestError) as caught:
                await client.bootstrap()
            self.assertNotIn("do-not-reflect", str(caught.exception))
        async with GrowthClient(
            scope,
            "private-session-token-never-log",
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, content=b"x" * 64)
            ),
        ) as client:
            with self.assertRaises(ValueError):
                await client.request("GET", "/api/agents/bootstrap", max_bytes=16)

    async def test_submit_uses_normal_conversation_endpoint_and_rejects_foreign_task(
        self,
    ):
        scope = GrowthPreparedScope.model_validate(scope_value())
        conversation_id, task_id = str(uuid4()), str(uuid4())
        sent = []

        def respond(request):
            sent.append(json.loads(request.content))
            return httpx.Response(
                202,
                json={
                    "task": {
                        "id": task_id,
                        "conversationId": str(uuid4()),
                        "featureId": "assistant",
                        "state": "accepted",
                    }
                },
            )

        async with GrowthClient(
            scope,
            "private-session-token-never-log",
            transport=httpx.MockTransport(respond),
        ) as client:
            body = {"requestId": str(uuid4()), "text": "Public task", "context": None}
            with self.assertRaises(ValueError):
                await client.submit(conversation_id, body)
            self.assertEqual(sent, [body])

    async def test_approval_binds_the_exact_current_review_and_selected_prepared_destination(
        self,
    ):
        scope = GrowthPreparedScope.model_validate(scope_value("content"))
        conversation_id, task_id, review_id = str(uuid4()), str(uuid4()), str(uuid4())
        review = {
            "id": review_id,
            "taskId": task_id,
            "conversationId": conversation_id,
            "featureId": "content",
            "payloadDigest": "a" * 64,
            "draft": {
                "title": "Title",
                "content": "Text",
                "channels": ["FACEBOOK"],
                "channelSelections": {"FACEBOOK": "fixture-channel"},
            },
            "state": "proposed",
        }
        sent = []

        def respond(request):
            if request.method == "POST":
                sent.append(json.loads(request.content))
                return httpx.Response(
                    200, json={"review": {**review, "state": "approved"}}
                )
            if request.url.path.endswith("draft-destinations"):
                return httpx.Response(
                    200,
                    json={
                        "destinations": [
                            {
                                "id": "fixture-channel",
                                "platform": "FACEBOOK",
                                "ready": True,
                            }
                        ]
                    },
                )
            return httpx.Response(200, json={"reviews": [review]})

        async with GrowthClient(
            scope,
            "private-session-token-never-log",
            transport=httpx.MockTransport(respond),
        ) as client:
            request_id = str(uuid4())
            await client.decide(conversation_id, task_id, review, "approve", request_id)
            self.assertEqual(
                sent,
                [
                    {
                        "requestId": request_id,
                        "payloadDigest": "a" * 64,
                        "decision": "approve",
                    }
                ],
            )
            with self.assertRaises(ValueError):
                await client.decide(
                    conversation_id,
                    task_id,
                    {**review, "payloadDigest": "b" * 64},
                    "approve",
                    request_id,
                )

    async def test_saved_receipt_requires_the_normal_growth_record_and_never_retains_provider_fields(
        self,
    ):
        scope = GrowthPreparedScope.model_validate(scope_value("content"))
        conversation_id, task_id, review_id = str(uuid4()), str(uuid4()), str(uuid4())
        receipt = {
            "reviewId": review_id,
            "payloadDigest": "a" * 64,
            "actorId": scope.user_id,
            "recordId": "post-fixture",
            "revision": "2026-10-23T08:00:00.000Z",
            "state": "saved",
        }
        review = {
            "id": review_id,
            "taskId": task_id,
            "conversationId": conversation_id,
            "featureId": "content",
            "payloadDigest": "a" * 64,
            "state": "saved",
            "result": receipt,
            "draft": {
                "title": "Title",
                "content": " Text ",
                "channels": ["FACEBOOK"],
                "channelSelections": {"FACEBOOK": "fixture-channel"},
            },
        }
        post = {
            "id": "post-fixture",
            "updated_at": "2026-10-23T08:00:00.000Z",
            "user_id": scope.user_id,
            "title": "Title",
            "content": "Text",
            "channels": ["FACEBOOK"],
            "status": "DRAFT",
            "metadata": {
                "growthAgentReviewId": review_id,
                "growthAgentPayloadDigest": "a" * 64,
                "growthAgentTaskId": task_id,
            },
            "publishJobs": [
                {"platform": "FACEBOOK", "channel_connection_id": "fixture-channel"}
            ],
            "variants": [
                {"platform": "FACEBOOK", "content": "Text", "status": "DRAFT"}
            ],
            "primaryChannel": {"access_token": "do-not-retain-provider-token"},
        }

        def respond(request):
            if request.url.path == "/api/agents/bootstrap":
                return httpx.Response(200, json=bootstrap(scope))
            if request.url.path.endswith("/reviews"):
                return httpx.Response(200, json={"reviews": [review]})
            self.assertEqual(request.url.path, "/api/social/posts/post-fixture")
            return httpx.Response(200, json={"post": post})

        async with GrowthClient(
            scope,
            "private-session-token-never-log",
            transport=httpx.MockTransport(respond),
        ) as client:
            outcome = await client.saved_outcome(conversation_id, task_id, review)
            self.assertEqual(outcome["record"]["content"], "Text")
            self.assertNotIn("do-not-retain-provider-token", json.dumps(outcome))
            changed = deepcopy(post)
            changed["content"] = "A different business result"
            post.update(changed)
            with self.assertRaises(ValueError):
                await client.saved_outcome(conversation_id, task_id, review)


class GrowthDriverContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_host_adapter_uses_only_mocked_product_http_and_retains_no_invented_native_trace(
        self,
    ):
        from unittest.mock import patch
        from harbor.models.agent.context import AgentContext

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "scope.json"
            persist(path, scope_value())
            scope = GrowthPreparedScope.model_validate(private_json(path))
            conversation_id, task_id = str(uuid4()), str(uuid4())
            task = {
                "id": task_id,
                "conversationId": conversation_id,
                "featureId": "assistant",
                "state": "completed",
                "output": "Product response",
            }
            admitted = False
            requests = []

            def respond(request):
                nonlocal admitted
                requests.append(request.url.path)
                if request.url.path.endswith("/bootstrap"):
                    return httpx.Response(200, json=bootstrap(scope))
                if request.url.path == "/api/agents/conversations":
                    if request.method == "GET":
                        return httpx.Response(
                            200, json={"conversations": [], "nextCursor": None}
                        )
                    return httpx.Response(
                        201,
                        json={
                            "conversation": {
                                "id": conversation_id,
                                "featureId": "assistant",
                                "context": None,
                            }
                        },
                    )
                if request.url.path.endswith("/messages"):
                    admitted = True
                    return httpx.Response(202, json={"task": task})
                if request.url.path == "/api/agents/tasks":
                    return httpx.Response(
                        200,
                        json={"tasks": [task] if admitted else [], "nextCursor": None},
                    )
                if request.url.path.endswith("/events"):
                    return httpx.Response(200, json={"events": [], "nextCursor": None})
                if request.url.path.endswith("/artifacts"):
                    return httpx.Response(200, json={"artifacts": []})
                raise AssertionError("Unexpected mocked product endpoint")

            client = GrowthClient(
                scope,
                "private-session-token-never-log",
                transport=httpx.MockTransport(respond),
            )
            agent = GrowthHarborAgent(logs_dir=root / "logs", scope_path=str(path))
            agent.context_id = uuid4()
            context = AgentContext()
            with (
                patch("kasitek_harbor.growth.GrowthClient", return_value=client),
                patch.dict(
                    "os.environ",
                    {scope.session_cookie_env: "private-session-token-never-log"},
                ),
            ):
                await agent.run("Public request", None, context)
            result = private_json(root / "logs" / "evaluation-result.json")
            self.assertTrue(result["scriptCompleted"])
            self.assertTrue(result["cleanup"]["terminalConfirmed"])
            self.assertFalse(result["cleanup"]["admissionFenced"])
            self.assertEqual(
                result["coverage"]["nativeModelToolSnapshots"], "unavailable"
            )
            self.assertFalse((root / "logs" / "trajectory.json").exists())
            self.assertTrue(all(url.startswith("/api/agents/") for url in requests))
            self.assertNotIn("private-session-token-never-log", json.dumps(result))
