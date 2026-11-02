"""Controlled HTTP contract checks, never an agent evaluation."""
import json
import unittest
from types import SimpleNamespace
from uuid import uuid4

import httpx

from kasitek_harbor.client import PlatformClient
from kasitek_harbor.records import validate_record, validate_record_command


def fixture_record(agent_id):
    return {"id": str(uuid4()), "agentId": str(agent_id), "revision": "1", "status": "new",
            "fields": {"name": "Fixture"}, "createdAt": "2026-10-27T01:00:00Z",
            "updatedAt": "2026-10-27T01:00:00Z", "dueAt": None}


class RecordClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_agent_scoped_page_and_explicit_command_preserve_retry_identity(self):
        scope = SimpleNamespace(origin="http://127.0.0.1:4101", cookie_name="agents_session",
                                organization_id=uuid4(), agent_id=uuid4())
        row = fixture_record(scope.agent_id)
        command = {"commandId": str(uuid4()), "expectedRevision": "1", "action": "claim"}
        posts = []

        def respond(request):
            self.assertEqual(request.headers["cookie"], "agents_session=private-fixture-session")
            if request.method == "POST":
                posts.append(json.loads(request.content))
                if len(posts) == 1:
                    raise httpx.ReadError("Lost acknowledgement", request=request)
                return httpx.Response(200, json={"enquiry": {**row, "revision": "2"}})
            if request.url.path.endswith("/enquiries"):
                self.assertEqual(request.url.params["agentId"], str(scope.agent_id))
                return httpx.Response(200, json={"enquiries": [row], "nextCursor": None})
            return httpx.Response(200, json={"enquiry": row})

        async with PlatformClient(scope, "private-fixture-session", timeout=1,
                                  transport=httpx.MockTransport(respond)) as client:
            self.assertEqual((await client.customer_records())["enquiries"], [row])
            updated = await client.customer_record_command(row["id"], command)
            self.assertEqual(updated["revision"], "2")
        self.assertEqual(posts, [command, command])

    async def test_record_scope_and_bounds_are_checked_before_effects(self):
        scope = SimpleNamespace(origin="http://127.0.0.1:4101", cookie_name="agents_session",
                                organization_id=uuid4(), agent_id=uuid4())
        row = fixture_record(uuid4())
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json={"enquiry": row})

        async with PlatformClient(scope, "private-fixture-session", timeout=1,
                                  transport=httpx.MockTransport(respond)) as client:
            with self.assertRaises(ValueError):
                await client.customer_record_command(row["id"], {"commandId": str(uuid4()), "expectedRevision": "1", "action": "claim"})
            with self.assertRaises(ValueError):
                await client.customer_records(limit=101)
        self.assertEqual([request.method for request in requests], ["GET"])

    async def test_contact_and_activity_are_read_through_the_scoped_record(self):
        scope = SimpleNamespace(origin="http://127.0.0.1:4101", cookie_name="agents_session",
                                organization_id=uuid4(), agent_id=uuid4())
        contact_id = str(uuid4())
        row = {**fixture_record(scope.agent_id), "contactId": contact_id}
        activity = {"id": str(uuid4()), "kind": "note", "actorAccountId": str(uuid4()),
                    "body": "Private fixture", "createdAt": row["createdAt"]}
        contact = {"id": contact_id, "name": "Fixture", "email": None, "phone": None}
        paths = []

        def respond(request):
            paths.append(request.url.path)
            if request.url.path.endswith("/activity"):
                return httpx.Response(200, json={"activity": [activity], "nextCursor": None})
            if request.url.path.endswith(f"/contacts/{contact_id}"):
                return httpx.Response(200, json={"contact": contact, "enquiries": [{"private": "excluded"}]})
            return httpx.Response(200, json={"enquiry": row})

        async with PlatformClient(scope, "private-fixture-session", timeout=1,
                                  transport=httpx.MockTransport(respond)) as client:
            self.assertEqual(await client.customer_contact_for_record(row["id"]), contact)
            self.assertEqual((await client.customer_record_activity(row["id"]))["activity"], [activity])
        self.assertEqual(len(paths), 4)
        self.assertTrue(paths[0].endswith(row["id"]))
        self.assertTrue(paths[2].endswith(row["id"]))

    def test_invalid_native_outcomes_and_unspecified_commands_are_rejected(self):
        row = fixture_record(uuid4())
        for change in ({"revision": 1}, {"status": "invented"}, {"fields": {"password": "no"}}, {"updatedAt": "yesterday"}):
            with self.assertRaises(ValueError):
                validate_record({**row, **change})
        with self.assertRaises(ValueError):
            validate_record_command({"commandId": str(uuid4()), "expectedRevision": "1", "action": "send-message"})
