"""Visitor recovery checks are HTTP contract fixtures, not native acceptance."""

import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

from kasitek_harbor.channel import submit_channel_turn


class ChannelMappingTests(unittest.IsolatedAsyncioTestCase):
    async def test_trimmed_public_body_is_checkpointed_and_exact_native_binding_required(
        self,
    ):
        trial, conversation, message, task = [str(uuid4()) for _ in range(4)]
        history = {
            "conversation": {"id": conversation},
            "messages": [],
            "commands": [],
            "deliveries": [],
            "rootTaskIds": [task],
        }
        native = {
            "id": task,
            "requestKey": f"channel:{message}",
            "input": "Question?",
            "channelBinding": {
                "customerConversationId": conversation,
                "inputMessageId": message,
            },
        }
        requests = []

        class Operator:
            organization_path = "/api/organizations/" + str(uuid4())

            async def request(self, method, path):
                return history

            async def status(self, identity):
                self.identity = identity
                return native

        class Visitor:
            async def ingress(self, identity, request):
                requests.append((identity, request))
                history["messages"] = [
                    {
                        "id": message,
                        "task_id": task,
                        "author_kind": "visitor",
                        "request_key": "visitor:stable-key",
                    }
                ]
                return {"id": message}

        mapping = {"nativeTrialId": trial}
        turn = {
            "request": {"requestKey": "stable-key", "input": "Question?\n"},
            "taskId": None,
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mapping.json"
            actual = await submit_channel_turn(
                Operator(), Visitor(), mapping, turn, path
            )
            self.assertEqual(actual["id"], task)
            self.assertEqual(
                requests,
                [(conversation, {"requestKey": "stable-key", "body": "Question?"})],
            )
            self.assertEqual(turn["channelRequest"]["body"], "Question?")
            # Recovery reads the same message; it never creates another request.
            await submit_channel_turn(Operator(), Visitor(), mapping, turn, path)
            self.assertEqual(len(requests), 1)
            native["channelBinding"]["inputMessageId"] = str(uuid4())
            with self.assertRaisesRegex(ValueError, "channel binding"):
                await submit_channel_turn(Operator(), Visitor(), mapping, turn, path)


class VisitorConfirmationTests(unittest.IsolatedAsyncioTestCase):
    async def test_owner_driven_confirmation_is_exact_scoped_and_cookie_free(self):
        import json
        from types import SimpleNamespace
        import httpx
        from kasitek_harbor.channel import VisitorClient

        deployment, conversation, identity = [str(uuid4()) for _ in range(3)]
        digest = "a" * 64
        requests = []

        def respond(request):
            requests.append(request)
            self.assertEqual(request.headers["authorization"], "Bearer visitor-token")
            self.assertNotIn("cookie", request.headers)
            if request.method == "GET":
                key = "reviews" if request.url.path.endswith("tool-reviews") else "bookings"
                return httpx.Response(200, json={key: [{"id": identity, "requestDigest": digest}]})
            self.assertEqual(json.loads(request.content), {"decision": "reject", "requestDigest": digest})
            return httpx.Response(200, json={"state": "rejected"})

        async with VisitorClient(
            SimpleNamespace(origin="http://127.0.0.1:4101"),
            SimpleNamespace(deployment_id=deployment, origin="https://widget.example.test"),
            "visitor-token", timeout=1, transport=httpx.MockTransport(respond),
        ) as visitor:
            for listing, decision in [(visitor.bookings, visitor.decide_booking), (visitor.tool_reviews, visitor.decide_tool_review)]:
                items = await listing(conversation)
                self.assertEqual(len(requests), 1 if listing == visitor.bookings else 3)
                await decision(conversation, items[0]["id"], "reject", items[0]["requestDigest"])
            self.assertEqual(len(requests), 4)
            with self.assertRaises(ValueError):
                await visitor.decide_tool_review(conversation, identity, "approve", "not-current")
            with self.assertRaises(ValueError):
                await visitor.post(f"/api/website/{uuid4()}/customer-conversations/{conversation}/tool-reviews/{identity}/decision", {})
            with self.assertRaises(ValueError):
                await visitor._request("GET", "/api/organizations/private/connections")
            self.assertEqual(len(requests), 4)

    async def test_transport_retry_keeps_the_same_exact_decision(self):
        from types import SimpleNamespace
        import httpx
        from kasitek_harbor.channel import VisitorClient

        deployment, conversation, identity = [str(uuid4()) for _ in range(3)]
        requests = []

        def respond(request):
            requests.append(request)
            if len(requests) == 1:
                raise httpx.ReadError("Lost acknowledgement", request=request)
            return httpx.Response(200, json={"review": {"state": "approved"}})

        async with VisitorClient(
            SimpleNamespace(origin="http://127.0.0.1:4101"),
            SimpleNamespace(deployment_id=deployment, origin="https://widget.example.test"),
            "visitor-token", timeout=1, transport=httpx.MockTransport(respond),
        ) as visitor:
            await visitor.decide_tool_review(conversation, identity, "approve", "a" * 64)
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].url, requests[1].url)
        self.assertEqual(requests[0].content, requests[1].content)
