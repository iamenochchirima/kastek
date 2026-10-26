"""HTTP and manifest contract checks. These do not run an agent evaluation."""

import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx

from kasitek_harbor.channel import VisitorClient
from kasitek_harbor.client import PlatformClient
from kasitek_harbor.enquiries import validate_enquiries


def enquiry(agent_id=None, task_id=None, conversation_id=None):
    return {
        "id": str(uuid4()), "agentId": agent_id or str(uuid4()),
        "taskId": task_id or str(uuid4()), "conversationId": str(uuid4()),
        "customerConversationId": conversation_id,
        "fields": {"name": "Fixture customer", "message": "A repair enquiry"},
        "state": "pending", "requestDigest": "a" * 64,
        "createdAt": "2026-10-27T00:00:00Z",
        "expiresAt": "2026-10-27T00:15:00Z", "submittedAt": None,
    }


def scope():
    return SimpleNamespace(
        origin="http://127.0.0.1:4101", cookie_name="agents_session",
        organization_id=uuid4(), agent_id=uuid4(), version_id=uuid4(),
    )


class EnquiryClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_visitor_lists_and_decides_exact_native_enquiry_without_staff_cookie(self):
        prepared = scope()
        conversation, deployment = str(uuid4()), str(uuid4())
        row = enquiry(str(prepared.agent_id), conversation_id=conversation)
        requests = []

        def respond(request):
            requests.append(request)
            self.assertNotIn("cookie", request.headers)
            self.assertEqual(request.headers["authorization"], "Bearer visitor-token")
            if request.method == "GET":
                return httpx.Response(200, json={"enquiries": [row]})
            self.assertEqual(json.loads(request.content), {
                "decision": "reject", "requestDigest": row["requestDigest"],
            })
            return httpx.Response(200, json={"enquiry": {**row, "state": "rejected"}})

        async with VisitorClient(
            prepared, SimpleNamespace(deployment_id=deployment, origin="https://widget.test"),
            "visitor-token", timeout=1, transport=httpx.MockTransport(respond),
        ) as client:
            self.assertEqual((await client.enquiries(conversation))[0]["id"], row["id"])
            decided = await client.decide_enquiry(conversation, row["id"], "reject", row["requestDigest"])
            self.assertEqual(decided["state"], "rejected")
            with self.assertRaises(ValueError):
                await client.decide_enquiry(conversation, row["id"], "approve", "wrong")
        self.assertEqual(len(requests), 2)

    async def test_staff_task_scope_and_transport_retries_keep_exact_decision(self):
        prepared, task_id = scope(), str(uuid4())
        row = enquiry(str(prepared.agent_id), task_id)
        posts = []

        def respond(request):
            self.assertEqual(request.headers["cookie"], "agents_session=private-fixture-session")
            if request.url.path.endswith("/tasks/" + task_id):
                return httpx.Response(200, json={"task": {
                    "id": task_id, "state": "waiting_review", "versionId": str(prepared.version_id),
                }})
            if request.method == "POST":
                posts.append(request)
                if len(posts) == 1:
                    raise httpx.ReadError("Lost acknowledgement", request=request)
                return httpx.Response(200, json={"enquiry": {**row, "state": "approved"}})
            return httpx.Response(200, json={"enquiries": [row]})

        async with PlatformClient(prepared, "private-fixture-session", timeout=1, transport=httpx.MockTransport(respond)) as client:
            self.assertEqual(await client.task_enquiries(task_id), [row])
            decided = await client.decide_enquiry(task_id, row["id"], "approve", row["requestDigest"])
            self.assertEqual(decided["state"], "approved")
        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[0].url, posts[1].url)
        self.assertEqual(posts[0].content, posts[1].content)

    async def test_staff_outcomes_are_filtered_to_prepared_agent_and_submitted_state(self):
        prepared = scope()
        row = {**enquiry(str(prepared.agent_id)), "state": "submitted", "submittedAt": "2026-10-27T00:01:00Z"}

        def respond(request):
            self.assertEqual(request.url.params["agentId"], str(prepared.agent_id))
            self.assertEqual(request.url.params["limit"], "10")
            return httpx.Response(200, json={"enquiries": [row]})

        async with PlatformClient(prepared, "private-fixture-session", timeout=1, transport=httpx.MockTransport(respond)) as client:
            self.assertEqual(await client.submitted_enquiries(limit=10), [row])
            row["agentId"] = str(uuid4())
            with self.assertRaisesRegex(ValueError, "prepared agent"):
                await client.submitted_enquiries(limit=10)

    async def test_setup_readiness_retains_metadata_gaps_and_rejects_wrong_agent(self):
        prepared = scope()
        readiness = {
            "agentId": str(prepared.agent_id), "draftRevision": 3, "readyToTest": True,
            "requirements": {"bookings": {"state": "needs_setup", "code": "BOOKING_POLICY_REQUIRED"}},
            "channels": [{"kind": "website", "state": "needs_connection"}],
        }
        async with PlatformClient(prepared, "private-fixture-session", timeout=1, transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"readiness": readiness}))) as client:
            self.assertEqual((await client.setup_readiness())["requirements"]["bookings"]["state"], "needs_setup")
            readiness["agentId"] = str(uuid4())
            with self.assertRaises(ValueError):
                await client.setup_readiness()


class EnquiryContractTests(unittest.TestCase):
    def test_rejects_unbounded_fields_and_missing_authoritative_submission(self):
        for patch in [
            {"fields": {"unexpected": "value"}}, {"requestDigest": "missing"},
            {"fields": {"service": "x" * 201}}, {"state": "submitted"},
        ]:
            with self.assertRaises(ValueError):
                validate_enquiries({"enquiries": [{**enquiry(), **patch}]})
        validate_enquiries({"enquiries": [{**enquiry(), "state": "expired"}]})

    def test_guided_manifest_covers_independent_purposes_and_declares_owner_execution(self):
        path = Path(__file__).parents[1] / "cases/guided-setup.json"
        manifest = json.loads(path.read_text())
        self.assertFalse(manifest["runnableHarborSuite"])
        self.assertEqual(manifest["execution"], "owner-run; not executed by implementation")
        self.assertEqual(set(manifest["profiles"]), {"faq", "support", "booking", "intake", "combined"})
        identities = [case["id"] for case in manifest["cases"]]
        self.assertEqual(len(identities), len(set(identities)))
        for case in manifest["cases"]:
            self.assertIn(case["profile"], manifest["profiles"])
            self.assertTrue(case["authoritativeChecks"])
