"""Controlled fixture contract checks; these tests do not run an agent evaluation."""

import unittest
from kasitek_harbor.config import MessagingChannelOptions
from kasitek_harbor.messaging import native_payload


class MessagingFixtureContract(unittest.TestCase):
    def test_native_shapes_reuse_exact_provider_identity(self):
        for kind in ("telegram", "whatsapp", "facebook", "instagram"):
            first = native_payload(
                kind, "900000000000001", "request-key", "Question", 1792584000
            )
            self.assertEqual(
                first,
                native_payload(
                    kind, "900000000000001", "request-key", "Question", 1792584000
                ),
            )
            self.assertNotEqual(
                first,
                native_payload(
                    kind, "900000000000001", "second-key", "Question", 1792584000
                ),
            )
            self.assertNotIn("access_token", str(first))
            self.assertNotIn("botToken", str(first))

    def test_channel_mode_and_outcome_scope_are_explicit(self):
        for kind, mode in (
            ("telegram", "bot"),
            ("whatsapp", "cloud_api"),
            ("facebook", "meta"),
            ("instagram", "meta"),
            ("instagram", "instagram_login"),
        ):
            parsed = MessagingChannelOptions(
                kind=kind, mode=mode, outcomes=["accepted", "lost_ack"]
            )
            self.assertEqual(parsed.mode, mode)
        with self.assertRaises(ValueError):
            MessagingChannelOptions(kind="telegram", mode="meta", outcomes=["accepted"])
        with self.assertRaises(ValueError):
            MessagingChannelOptions(kind="telegram", mode="bot", outcomes=[])
        with self.assertRaises(ValueError):
            MessagingChannelOptions(
                kind="telegram", mode="bot", outcomes=["retry_automatically"]
            )
