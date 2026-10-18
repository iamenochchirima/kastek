import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

import httpx
from pydantic import ValidationError

from kasitek_harbor.agent import KasitekAgent
from kasitek_harbor.client import PlatformClient, PlatformRequestError
from kasitek_harbor.config import (
    AdapterOptions,
    ChannelOptions,
    PreparedScope,
    load_scope,
)
from kasitek_harbor.channel import VisitorClient
from kasitek_harbor.persistence import persist


def scope_value():
    return {
        "schema_version": "kasitek-prepared-scope.v1",
        "scope_id": str(uuid4()),
        "origin": "http://127.0.0.1:8099",
        "organization_id": str(uuid4()),
        "agent_id": str(uuid4()),
        "version_id": str(uuid4()),
        "composition_digest": "a" * 64,
        "expires_at": "2099-01-01T00:00:00Z",
        "max_tokens": 8192,
        "isolation": "operator-provisioned-per-trial",
    }


class OperatorConfigTests(unittest.TestCase):
    def test_rejects_public_plain_http_credentials_paths_unknown_config_and_nonprivate_files(
        self,
    ):
        for origin in [
            "http://example.test",
            "https://user:password@example.test",
            "https://example.test/path",
            "https://example.test/?leak=1",
        ]:
            with self.subTest(origin=origin), self.assertRaises(ValidationError):
                PreparedScope.model_validate({**scope_value(), "origin": origin})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "scope.json"
            persist(path, scope_value())
            self.assertEqual(load_scope(path).origin, "http://127.0.0.1:8099")
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                load_scope(path)
            path.chmod(0o600)
            link = Path(directory) / "symlink.json"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                load_scope(link)
            with self.assertRaises(ValueError):
                KasitekAgent(
                    logs_dir=Path(directory) / "logs",
                    scope_path=str(path),
                    expected_answer="Do not expose graders",
                )


class TransportBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_no_redirect_following_no_error_body_reflection_and_no_foreign_org_requests(
        self,
    ):
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(
                302,
                headers={"location": "https://foreign.example"},
                json={"error": {"message": "private-session-token-never-log"}},
            )

        scope = PreparedScope.model_validate(scope_value())
        async with PlatformClient(
            scope,
            "private-session-token-never-log",
            timeout=1,
            transport=httpx.MockTransport(respond),
        ) as client:
            with self.assertRaises(PlatformRequestError) as error:
                await client.status(str(uuid4()))
            self.assertNotIn("private-session-token-never-log", str(error.exception))
            with self.assertRaises(ValueError):
                await client.request("GET", f"/api/organizations/{uuid4()}/tasks")
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].headers["origin"], scope.origin)
        self.assertNotEqual(requests[0].url.host, "foreign.example")

    async def test_export_bound_identity_and_composition_are_checked(self):
        scope = PreparedScope.model_validate(scope_value())
        async with PlatformClient(
            scope,
            "private-session-token-never-log",
            timeout=1,
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, content=b'"' + b"x" * 128 + b'"')
            ),
        ) as client:
            with self.assertRaises(ValueError):
                await client.request(
                    "GET",
                    f"/api/organizations/{scope.organization_id}/tasks",
                    max_bytes=16,
                )
        wrong = {
            "versions": [
                {
                    "id": str(scope.version_id),
                    "effectiveComposition": {"digest": "b" * 64},
                }
            ]
        }
        async with PlatformClient(
            scope,
            "private-session-token-never-log",
            timeout=1,
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=wrong)),
        ) as client:
            with self.assertRaises(ValueError):
                await client.version()


class ScriptedTurnTests(unittest.TestCase):
    def test_configured_turn_ids_are_unique_bounded_and_not_hidden_grader_fields(self):
        for follows in (
            [{"id": "initial", "instruction": "question"}],
            [
                {"id": "same", "instruction": "one"},
                {"id": "same", "instruction": "two"},
            ],
            [{"id": "a", "instruction": "q", "expected_answer": "hidden"}],
        ):
            with self.assertRaises(ValidationError):
                AdapterOptions(
                    scope_path=Path("/private/scope.json"), follow_ups=follows
                )
        with self.assertRaises(ValidationError):
            AdapterOptions(
                scope_path=Path("/private/scope.json"),
                follow_ups=[{"id": str(i), "instruction": "q"} for i in range(8)],
            )

    def test_scripted_request_ids_and_text_are_checkpointed_before_submission(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scope_path = root / "scope.json"
            persist(scope_path, scope_value())
            agent = KasitekAgent(
                logs_dir=root / "logs",
                scope_path=str(scope_path),
                root_token_limit=2048,
                follow_ups=[{"id": "confirm", "instruction": "Same literal question"}],
            )
            agent.context_id = uuid4()
            _, mapping, _ = agent._mapping("Same literal question")
            self.assertEqual(
                [turn["id"] for turn in mapping["turns"]], ["initial", "confirm"]
            )
            self.assertNotEqual(
                mapping["turns"][0]["request"]["requestKey"],
                mapping["turns"][1]["request"]["requestKey"],
            )
            recovered = KasitekAgent(
                logs_dir=root / "logs",
                scope_path=str(scope_path),
                root_token_limit=2048,
                follow_ups=[{"id": "confirm", "instruction": "Changed instruction"}],
            )
            recovered.context_id = agent.context_id
            with self.assertRaises(ValueError):
                recovered._mapping("Same literal question")


class VisitorBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_visitor_origin_and_bearer_transport_never_carry_operator_cookies(
        self,
    ):
        requests = []
        conversation_id = str(uuid4())

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json={"conversation": {"id": conversation_id}})

        scope = PreparedScope.model_validate(scope_value())
        channel = ChannelOptions(deployment_id=uuid4(), origin="https://widget.example")
        async with VisitorClient(
            scope,
            channel,
            "visitor-fixture-token",
            timeout=1,
            transport=httpx.MockTransport(respond),
        ) as visitor:
            self.assertEqual(await visitor.open(), conversation_id)
        self.assertNotIn("cookie", requests[0].headers)
        self.assertEqual(requests[0].headers["origin"], "https://widget.example")
        self.assertEqual(
            requests[0].headers["authorization"], "Bearer visitor-fixture-token"
        )
