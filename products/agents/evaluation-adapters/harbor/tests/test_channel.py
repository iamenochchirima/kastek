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
