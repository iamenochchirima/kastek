"""Host-side Harbor BaseAgent. Native Kasitek services execute every agent turn."""

import asyncio
from contextlib import AsyncExitStack
import hashlib
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from uuid import uuid5

from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from . import __version__
from .client import PlatformClient, TERMINAL_STATES
from .channel import (
    VisitorClient,
    prepare_channel,
    channel_history,
    submit_channel_turn,
)
from .messaging import (
    prepare_messaging,
    submit_messaging_turn,
    settled_messaging_history,
)
from .config import AdapterOptions
from .scope_pool import prepared_scopes, select_scope
from .recovery import recovery_path, exclusive_recovery
from .persistence import persist, read_json
from .trajectory import to_atif_turns, UnsupportedMapping


class KasitekAgent(BaseAgent):
    options_model = AdapterOptions
    capabilities = AgentCapabilities(atif=True)

    @staticmethod
    def name():
        return "kasitek"

    def version(self):
        return __version__

    def _supported(self):
        if (
            self.mcp_servers
            or self.skills_dir
            or self.load_trajectory
            or self.model_name
        ):
            raise ValueError(
                "Select native programs/tools/models only through the prepared published version"
            )
        if not isinstance(self.options, AdapterOptions):
            raise ValueError("Expected validated operator adapter options")

    async def setup(self, environment: BaseEnvironment) -> None:
        self._supported()
        scopes = prepared_scopes(self.options.scope_path)
        if self.options.recovery_id and len(scopes) != 1:
            raise ValueError(
                "Explicit process recovery requires one prepared trial scope"
            )
        for scope in scopes:
            self._validate_allocation(scope)
            if (
                self.options.root_token_limit * (1 + len(self.options.follow_ups))
                > scope.max_tokens
            ):
                raise ValueError("Root allocation exceeds the prepared trial total")
            if scope.expires_at <= datetime.now(timezone.utc):
                raise ValueError("Prepared operator scope has expired")
        # No task-controlled files, tools, skills, verifier state or credentials
        # are uploaded to the native agent. Scoped resources are provisioned by
        # normal platform APIs before this adapter is selected.

    def _validate_allocation(self, scope):
        if self.options.root_token_limit != scope.root_token_limit:
            raise ValueError("Root allocation differs from the prepared model policy")

    def _mapping(self, instruction: str):
        self._supported()
        if self.context_id is None:
            raise ValueError("Harbor must supply its durable trial context identity")
        context_id = str(self.options.recovery_id or self.context_id)
        scope = select_scope(self.options.scope_path, context_id)
        self._validate_allocation(scope)
        if not instruction.strip() or len(instruction.encode("utf-8")) > 8000:
            raise ValueError("Expected a bounded native task instruction")
        path = (
            recovery_path(self.options.scope_path, self.options.recovery_id)
            if self.options.recovery_id
            else self.logs_dir / "trial-mapping.json"
        )
        request = {
            "versionId": str(scope.version_id),
            "requestKey": str(uuid5(scope.scope_id, context_id)),
            "input": instruction,
            "evaluationRootTokenLimit": self.options.root_token_limit,
        }
        fingerprint = hashlib.sha256(
            json.dumps(
                {
                    "request": request,
                    "scope": scope.model_dump(mode="json"),
                    "contextId": context_id,
                    "channel": self.options.channel.model_dump(mode="json")
                    if self.options.channel
                    else None,
                    **(
                        {
                            "messagingChannel": self.options.messaging_channel.model_dump(
                                mode="json"
                            )
                        }
                        if self.options.messaging_channel
                        else {}
                    ),
                    "followUps": [
                        turn.model_dump() for turn in self.options.follow_ups
                    ],
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()
        if path.exists():
            mapping = read_json(path, 524288)
            if (
                mapping.get("schemaVersion") != "kasitek-trial-mapping.v1"
                or mapping.get("fingerprint") != fingerprint
            ):
                raise ValueError(
                    "Recovered trial differs from the original prepared scope or instruction"
                )
            original_context = mapping.get(
                "originalHarborContextId", str(self.context_id)
            )
            if mapping.get("finished") and mapping.get(
                "completedHarborContextId", original_context
            ) != str(self.context_id):
                raise ValueError(
                    "Completed native recovery cannot count as a new Harbor trial"
                )
            contexts = mapping.setdefault("harborContextIds", [original_context])
            if str(self.context_id) not in contexts:
                if len(contexts) >= 8:
                    raise ValueError("Evaluator process recovery limit exceeded")
                contexts.append(str(self.context_id))
        else:
            deadline = min(
                scope.expires_at,
                datetime.now(timezone.utc)
                + timedelta(seconds=self.options.trial_timeout_sec),
            )
            mapping = {
                "schemaVersion": "kasitek-trial-mapping.v1",
                "contextId": context_id,
                "originalHarborContextId": str(self.context_id),
                "harborContextIds": [str(self.context_id)],
                "finished": False,
                "scopeId": str(scope.scope_id),
                "fingerprint": fingerprint,
                "request": request,
                "prepareRequest": {
                    "trialId": f"harbor:{scope.scope_id}:{context_id}",
                    "agentId": str(scope.agent_id),
                    "versionId": str(scope.version_id),
                    "expectedCompositionDigest": scope.composition_digest,
                    "expectedModelRoutesDigest": scope.model_routes_digest,
                    "rootTokenLimit": scope.root_token_limit,
                    "maxTokens": scope.max_tokens,
                    "expiresAt": deadline.isoformat(),
                },
                "nativeTrialId": None,
                "taskId": None,
                "conversationId": None,
                "turns": [
                    {"id": "initial", "request": request, "taskId": None},
                    *[
                        {
                            "id": turn.id,
                            "taskId": None,
                            "request": {
                                "versionId": str(scope.version_id),
                                "requestKey": str(
                                    uuid5(
                                        scope.scope_id, f"{context_id}:turn:{turn.id}"
                                    )
                                ),
                                "input": turn.instruction,
                                "evaluationRootTokenLimit": self.options.root_token_limit,
                            },
                        }
                        for turn in self.options.follow_ups
                    ],
                ],
                "deadlineAt": deadline.isoformat(),
            }
        self._save_mapping(path, mapping)
        return scope, mapping, path

    def _save_mapping(self, path, mapping):
        persist(path, mapping)
        local = self.logs_dir / "trial-mapping.json"
        if path != local:
            persist(local, mapping)

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        self._supported()
        if self.options.recovery_id:
            with exclusive_recovery(self.options.scope_path, self.options.recovery_id):
                await self._run_native(instruction, environment, context)
        else:
            await self._run_native(instruction, environment, context)

    async def _run_native(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        scope, mapping, path = self._mapping(instruction)
        credential = self._get_env(scope.session_cookie_env)
        if not credential:
            raise ValueError("Prepared operator session is unavailable")
        metadata = {
            "schemaVersion": "kasitek-evaluation-result.v1",
            "trialId": mapping["prepareRequest"]["trialId"],
            "taskId": mapping["taskId"],
            "nativeOutcome": None,
            "mappingStatus": "pending",
            "coverage": None,
            "scriptCompleted": False,
            "cleanup": {"revocationConfirmed": False, "terminalConfirmed": False},
        }
        context.metadata = {"kasitek": metadata}
        async with (
            PlatformClient(
                scope, credential, timeout=self.options.http_timeout_sec
            ) as client,
            AsyncExitStack() as transports,
        ):
            try:
                deadline = datetime.fromisoformat(mapping["deadlineAt"])
                remaining = (deadline - datetime.now(timezone.utc)).total_seconds()
                if remaining <= 0:
                    raise TimeoutError("Persisted native trial deadline has passed")
                async with asyncio.timeout(remaining):
                    await client.version()
                    known = await client.trial(
                        native_id=mapping["nativeTrialId"],
                        trial_key=None
                        if mapping["nativeTrialId"]
                        else mapping["prepareRequest"]["trialId"],
                    )
                    if known["trial"] is None:
                        if mapping["nativeTrialId"] is not None:
                            raise ValueError(
                                "Accepted native trial disappeared; recovery cannot recreate it"
                            )
                        prepared = await client.prepare(mapping["prepareRequest"])
                        mapping["nativeTrialId"] = prepared["trial"]["id"]
                        self._save_mapping(path, mapping)
                        known = await client.trial(native_id=mapping["nativeTrialId"])
                    elif mapping["nativeTrialId"] is None:
                        mapping["nativeTrialId"] = known["trial"]["id"]
                        self._save_mapping(path, mapping)
                    messaging_fixture = (
                        await prepare_messaging(
                            client,
                            self.options.messaging_channel,
                            mapping["nativeTrialId"],
                        )
                        if self.options.messaging_channel
                        else None
                    )
                    visitor = None
                    if self.options.channel:
                        token = await prepare_channel(
                            client, self.options.channel, mapping["nativeTrialId"]
                        )
                        visitor = await transports.enter_async_context(
                            VisitorClient(
                                scope,
                                self.options.channel,
                                token,
                                timeout=self.options.http_timeout_sec,
                            )
                        )
                    if len(known["rootTaskIds"]) > len(mapping["turns"]):
                        raise UnsupportedMapping(
                            "Native trial has roots outside the scripted conversation"
                        )
                    recovered = [
                        await client.status(task_id) for task_id in known["rootTaskIds"]
                    ]
                    expected_keys = {
                        turn["request"]["requestKey"] for turn in mapping["turns"]
                    }
                    if (
                        not visitor
                        and not messaging_fixture
                        and any(
                            task.get("requestKey") not in expected_keys
                            for task in recovered
                        )
                    ):
                        raise ValueError(
                            "Native trial contains an unexpected root request"
                        )
                    exports = []
                    completed_turns = []
                    for turn in mapping["turns"]:
                        request = turn["request"]
                        if turn["id"] != "initial" and mapping["conversationId"]:
                            expected_conversation = mapping["conversationId"]
                            if (
                                request.get("conversationId", expected_conversation)
                                != expected_conversation
                            ):
                                raise ValueError(
                                    "Scripted request changed its conversation"
                                )
                            request["conversationId"] = expected_conversation
                        matches = [
                            task
                            for task in recovered
                            if task.get("requestKey") == request["requestKey"]
                        ]
                        if len(matches) > 1:
                            raise ValueError("Native request identity is not unique")
                        if messaging_fixture:
                            task = await submit_messaging_turn(
                                client,
                                messaging_fixture,
                                mapping,
                                turn,
                                path,
                                timeout=min(self.options.trial_timeout_sec, 120),
                                poll_interval=self.options.poll_interval_sec,
                            )
                        elif visitor:
                            task = await submit_channel_turn(
                                client, visitor, mapping, turn, path
                            )
                        elif turn["taskId"]:
                            task = await client.status(turn["taskId"])
                            if task["id"] not in known["rootTaskIds"]:
                                raise ValueError(
                                    "Persisted task is not a native trial root"
                                )
                        elif matches:
                            task = matches[0]
                        else:
                            if known["trial"]["state"] != "active":
                                raise ValueError(
                                    "Original native trial was revoked before admission"
                                )
                            # The full conversation binding is durable before every first/retry POST.
                            self._save_mapping(path, mapping)
                            task = await client.submit(
                                {
                                    **request,
                                    "evaluationTrialId": mapping["nativeTrialId"],
                                }
                            )
                        if (
                            not visitor
                            and not messaging_fixture
                            and task.get("requestKey") != request["requestKey"]
                        ):
                            raise ValueError(
                                "Native task does not match the persisted scripted request"
                            )
                        turn["taskId"] = task["id"]
                        if turn["id"] == "initial":
                            mapping["taskId"] = task["id"]
                        conversation_id = task.get("conversationId")
                        if len(mapping["turns"]) > 1 and not conversation_id:
                            raise UnsupportedMapping(
                                "Native task did not expose its authoritative conversation binding"
                            )
                        if (
                            mapping["conversationId"]
                            and conversation_id != mapping["conversationId"]
                        ):
                            raise ValueError(
                                "Native turn escaped its pinned conversation"
                            )
                        if conversation_id:
                            mapping["conversationId"] = conversation_id
                        self._save_mapping(path, mapping)
                        metadata["taskId"] = task["id"]
                        while task["state"] not in TERMINAL_STATES:
                            await asyncio.sleep(self.options.poll_interval_sec)
                            task = await client.status(task["id"])
                        metadata["nativeOutcome"] = task["state"]
                        raw, export = await client.history(task["id"])
                        turn_dir = self.logs_dir / "turns" / turn["id"]
                        persist(turn_dir / "native-export.json", raw)
                        persist(self.logs_dir / "native-export.json", raw)
                        exports.append(export)
                        completed_turns.append(
                            {
                                "id": turn["id"],
                                "taskId": task["id"],
                                "conversationId": conversation_id,
                                "state": task["state"],
                                "nativeEvidenceFile": f"turns/{turn['id']}/native-export.json",
                            }
                        )
                        persist(
                            self.logs_dir / "conversation-turns.json", completed_turns
                        )
                        metadata["coverage"] = export.coverage.model_dump()
                        trajectory = to_atif_turns(exports)
                        metadata["coverage"] = trajectory.extra["coverage"]
                        persist(
                            self.logs_dir / "trajectory.json",
                            trajectory.model_dump(mode="json", exclude_none=True),
                        )
                        if visitor or messaging_fixture:
                            native_channel = (
                                await settled_messaging_history(
                                    client,
                                    mapping["nativeTrialId"],
                                    poll_interval=self.options.poll_interval_sec,
                                    require_delivery=task["state"] == "completed",
                                )
                                if messaging_fixture
                                else await channel_history(
                                    client, mapping["nativeTrialId"]
                                )
                            )
                            persist(
                                self.logs_dir / "native-channel-history.json",
                                native_channel,
                            )
                            trajectory.extra["nativeChannelHistoryFile"] = (
                                "native-channel-history.json"
                            )
                            persist(
                                self.logs_dir / "trajectory.json",
                                trajectory.model_dump(mode="json", exclude_none=True),
                            )
                        metadata["mappingStatus"] = "supported"
                        metadata["turns"] = completed_turns
                        await client.artifacts(export, self.logs_dir / "artifacts")
                        if task["state"] != "completed":
                            break
                    metadata["scriptCompleted"] = len(completed_turns) == len(
                        mapping["turns"]
                    ) and all(turn["state"] == "completed" for turn in completed_turns)
                    calls = [
                        call
                        for export in exports
                        for task in export.tasks
                        for call in task.modelCalls
                    ]
                    if calls and all(
                        call.usage and call.usage.inputTokens is not None
                        for call in calls
                    ):
                        context.n_input_tokens = sum(
                            call.usage.inputTokens for call in calls
                        )
                    if calls and all(
                        call.usage and call.usage.outputTokens is not None
                        for call in calls
                    ):
                        context.n_output_tokens = sum(
                            call.usage.outputTokens for call in calls
                        )
            except BaseException as cause:
                metadata["adapterFailure"] = type(cause).__name__
                if isinstance(cause, UnsupportedMapping):
                    metadata["mappingStatus"] = "unsupported"
                raise
            finally:
                interrupted = None
                try:
                    async with asyncio.timeout(self.options.cancellation_timeout_sec):
                        await self._cleanup(client, mapping, path, metadata["cleanup"])
                except asyncio.CancelledError as cause:
                    metadata["cleanup"]["failure"] = type(cause).__name__
                    interrupted = cause
                except Exception as cause:
                    metadata["cleanup"]["failure"] = type(cause).__name__
                mapping["finished"] = bool(
                    metadata["cleanup"].get("revocationConfirmed")
                    and metadata["cleanup"].get("terminalConfirmed")
                )
                if mapping["finished"]:
                    mapping["completedHarborContextId"] = str(self.context_id)
                self._save_mapping(path, mapping)
                persist(self.logs_dir / "evaluation-result.json", metadata)
                if interrupted:
                    raise interrupted

    async def _cleanup(
        self, client: PlatformClient, mapping: dict, path: Path, result: dict
    ):
        known = await client.trial(
            native_id=mapping["nativeTrialId"],
            trial_key=None
            if mapping["nativeTrialId"]
            else mapping["prepareRequest"]["trialId"],
        )
        if known["trial"] is None:
            result.update(
                revocationConfirmed=True,
                terminalConfirmed=True,
                noNativeTrial=True,
                roots=[],
            )
            return
        trial_id = known["trial"]["id"]
        if mapping["nativeTrialId"] is None:
            mapping["nativeTrialId"] = trial_id
            self._save_mapping(path, mapping)
        await client.revoke(trial_id)
        result.update(revocationConfirmed=True, cancellationRequested=True, roots=[])
        known = await client.trial(native_id=trial_id)
        roots = result["roots"]
        for task_id in known["rootTaskIds"]:
            task = await client.status(task_id)
            while task["state"] not in TERMINAL_STATES:
                await asyncio.sleep(self.options.poll_interval_sec)
                task = await client.status(task_id)
            roots.append(
                {
                    "taskId": task_id,
                    "state": task["state"],
                    "terminalConfirmed": task["state"] != "uncertain",
                    "cancellationConfirmed": task["state"] == "cancelled",
                }
            )
        result["terminalConfirmed"] = all(root["terminalConfirmed"] for root in roots)
