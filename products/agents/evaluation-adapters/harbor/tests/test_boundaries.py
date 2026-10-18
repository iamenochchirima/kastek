import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

import httpx
from pydantic import ValidationError

from kasitek_harbor.agent import KasitekAgent
from kasitek_harbor.client import PlatformClient, PlatformRequestError
from kasitek_harbor.config import PreparedScope, load_scope
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
