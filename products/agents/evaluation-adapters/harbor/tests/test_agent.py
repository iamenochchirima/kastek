"""Actual Harbor BaseAgent + local HTTP contract fixtures; not native acceptance."""

import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from harbor.agents.factory import AgentFactory
from harbor.models.agent.context import AgentContext
from harbor.models.trial.config import AgentConfig

from kasitek_harbor.agent import KasitekAgent
from kasitek_harbor.persistence import persist
from fixtures import native_export


class ContractFixture:
    def __init__(
        self,
        *,
        lost_task_ack=False,
        lost_prepare_ack=False,
        running=False,
        outcome="completed",
    ):
        self.export = native_export()
        self.export["conversationId"] = str(uuid4())
        self.export["tasks"][0]["state"] = outcome
        self.outcome = outcome
        self.root = self.export["rootTaskId"]
        self.trial_id = str(uuid4())
        self.trial = None
        self.task = None
        self.prepares = self.submits = self.revokes = self.statuses = 0
        self.lost_task_ack, self.lost_prepare_ack, self.running = (
            lost_task_ack,
            lost_prepare_ack,
            running,
        )
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                self.respond("GET")

            def do_POST(self):
                self.respond("POST")

            def respond(self, method):
                body = json.loads(
                    self.rfile.read(int(self.headers.get("content-length", 0)))
                    or b"null"
                )
                path = self.path.split("?")[0]
                if not self.headers.get("cookie", "").endswith(
                    "private-session-token-never-log"
                ):
                    self.send_response(403)
                    self.end_headers()
                    return
                if path.endswith("/agents/" + fixture.export["agentId"]):
                    response = {
                        "versions": [
                            {
                                "id": fixture.export["versionId"],
                                "effectiveComposition": fixture.export[
                                    "effectiveComposition"
                                ],
                            }
                        ]
                    }
                elif path.endswith("/evaluation-trials") and method == "POST":
                    fixture.prepares += 1
                    fixture.trial = {
                        "id": fixture.trial_id,
                        "trialId": body["trialId"],
                        "organizationId": fixture.export["organizationId"],
                        "agentId": fixture.export["agentId"],
                        "versionId": fixture.export["versionId"],
                        "compositionDigest": "a" * 64,
                        "modelRoutesDigest": body["expectedModelRoutesDigest"],
                        "rootTokenLimit": body["rootTokenLimit"],
                        "maxTokens": body["maxTokens"],
                        "expiresAt": body["expiresAt"],
                        "state": "active",
                    }
                    prefix = "/api/organizations/" + fixture.export["organizationId"]
                    response = {
                        "trial": fixture.trial,
                        "submitPath": prefix + "/tasks",
                        "taskBinding": {"evaluationTrialId": fixture.trial_id},
                        "revokePath": prefix
                        + "/evaluation-trials/"
                        + fixture.trial_id
                        + "/revoke",
                    }
                    if fixture.lost_prepare_ack:
                        fixture.lost_prepare_ack = False
                        self.close_connection = True
                        return
                elif "/evaluation-trials" in path and method == "GET":
                    response = {
                        "trial": fixture.trial,
                        "rootTaskIds": [fixture.root] if fixture.task else [],
                    }
                elif path.endswith("/revoke"):
                    fixture.revokes += 1
                    fixture.trial["state"] = "revoked"
                    if fixture.task and fixture.running:
                        fixture.task["state"] = "cancel_requested"
                    response = {"trial": fixture.trial, "cancellationRequested": True}
                elif path.endswith("/tasks") and method == "POST":
                    fixture.submits += 1
                    if fixture.task is None:
                        fixture.task = {
                            "id": fixture.root,
                            "state": "running" if fixture.running else fixture.outcome,
                            "conversationId": fixture.export["conversationId"],
                            "requestKey": body["requestKey"],
                            "versionId": fixture.export["versionId"],
                        }
                    elif fixture.task["requestKey"] != body["requestKey"]:
                        raise AssertionError("Retry changed its request identity")
                    response = {"task": fixture.task}
                    if fixture.lost_task_ack:
                        fixture.lost_task_ack = False
                        self.close_connection = True
                        return
                elif path.endswith("/history-export"):
                    response = fixture.export
                elif path.endswith("/tasks/" + fixture.root):
                    fixture.statuses += 1
                    if (
                        fixture.task["state"] == "cancel_requested"
                        and fixture.statuses > 2
                    ):
                        fixture.task["state"] = "cancelled"
                    response = {"task": fixture.task}
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                payload = json.dumps(response).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def scope(self, path):
        persist(
            path,
            {
                "schema_version": "kasitek-prepared-scope.v2",
                "scope_id": str(uuid4()),
                "origin": "http://127.0.0.1:" + str(self.server.server_port),
                "organization_id": self.export["organizationId"],
                "agent_id": self.export["agentId"],
                "version_id": self.export["versionId"],
                "composition_digest": "a" * 64,
                "expires_at": (
                    datetime.now(timezone.utc) + timedelta(minutes=10)
                ).isoformat(),
                "model_routes_digest": self.export["modelRoutesDigest"],
                "root_token_limit": 16384,
                "max_tokens": 32768,
                "isolation": "operator-provisioned-per-trial",
            },
        )


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_factory_host_agent_recovery_preserves_request_and_keeps_credentials_out_of_evidence(
        self,
    ):
        fixture = ContractFixture(lost_task_ack=True, lost_prepare_ack=True)
        try:
            with (
                tempfile.TemporaryDirectory() as directory,
                patch.dict(
                    os.environ,
                    {"KASITEK_EVALUATION_SESSION": "private-session-token-never-log"},
                ),
            ):
                root = Path(directory)
                scope = root / "scope.json"
                fixture.scope(scope)
                config = AgentConfig(
                    import_path="kasitek_harbor.agent:KasitekAgent",
                    kwargs={"scope_path": str(scope)},
                )
                agent = AgentFactory.create_agent_from_config(
                    config, logs_dir=root / "logs"
                )
                self.assertIsInstance(agent, KasitekAgent)
                agent.context_id = uuid4()
                context = AgentContext()
                await agent.setup(None)
                await agent.run("Research the approved source.", None, context)
                self.assertEqual(fixture.prepares, 2)
                self.assertEqual(fixture.submits, 2)
                self.assertEqual(
                    context.metadata["kasitek"]["nativeOutcome"], "completed"
                )
                self.assertTrue(
                    context.metadata["kasitek"]["cleanup"]["revocationConfirmed"]
                )
                self.assertFalse(
                    context.metadata["kasitek"]["cleanup"]["roots"][0][
                        "cancellationConfirmed"
                    ]
                )
                recovered = AgentFactory.create_agent_from_config(
                    config, logs_dir=root / "logs"
                )
                recovered.context_id = agent.context_id
                await recovered.run(
                    "Research the approved source.", None, AgentContext()
                )
                self.assertEqual(
                    fixture.submits,
                    2,
                    "Evaluator restart must inspect the original task without new admission",
                )
                for path in (root / "logs").rglob("*.json"):
                    self.assertNotIn(
                        "private-session-token-never-log", path.read_text()
                    )
                with self.assertRaises(ValueError):
                    await recovered.run("Different instruction", None, AgentContext())
        finally:
            fixture.close()

    async def test_deadline_revokes_trial_and_distinguishes_cancel_request_from_observed_cancellation(
        self,
    ):
        fixture = ContractFixture(running=True)
        try:
            with (
                tempfile.TemporaryDirectory() as directory,
                patch.dict(
                    os.environ,
                    {"KASITEK_EVALUATION_SESSION": "private-session-token-never-log"},
                ),
            ):
                root = Path(directory)
                scope = root / "scope.json"
                fixture.scope(scope)
                agent = KasitekAgent(
                    logs_dir=root / "logs",
                    scope_path=str(scope),
                    trial_timeout_sec=0.2,
                    poll_interval_sec=0.01,
                )
                agent.context_id = uuid4()
                context = AgentContext()
                with self.assertRaises(TimeoutError):
                    await agent.run("Research the approved source.", None, context)
                self.assertTrue(
                    context.metadata["kasitek"]["cleanup"]["revocationConfirmed"]
                )
                self.assertTrue(
                    context.metadata["kasitek"]["cleanup"]["roots"][0][
                        "cancellationConfirmed"
                    ]
                )
                self.assertEqual(fixture.submits, 1)
        finally:
            fixture.close()

    async def test_script_stops_after_failed_native_turn_and_revokes_without_admitting_followup(
        self,
    ):
        fixture = ContractFixture(outcome="failed")
        try:
            with (
                tempfile.TemporaryDirectory() as directory,
                patch.dict(
                    os.environ,
                    {"KASITEK_EVALUATION_SESSION": "private-session-token-never-log"},
                ),
            ):
                root = Path(directory)
                scope = root / "scope.json"
                fixture.scope(scope)
                agent = KasitekAgent(
                    logs_dir=root / "logs",
                    scope_path=str(scope),
                    root_token_limit=16384,
                    follow_ups=[
                        {"id": "followup", "instruction": "Second public question"}
                    ],
                )
                agent.context_id = uuid4()
                context = AgentContext()
                await agent.setup(None)
                await agent.run("Research the approved source.", None, context)
                self.assertEqual(fixture.submits, 1)
                self.assertEqual(context.metadata["kasitek"]["nativeOutcome"], "failed")
                self.assertFalse(context.metadata["kasitek"]["scriptCompleted"])
                self.assertTrue(
                    context.metadata["kasitek"]["cleanup"]["revocationConfirmed"]
                )
        finally:
            fixture.close()
