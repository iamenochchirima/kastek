"""Host-side Harbor BaseAgent. Native Kasitek services execute every agent turn."""

import asyncio
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
from .config import AdapterOptions, load_scope
from .persistence import persist, read_json
from .trajectory import to_atif, UnsupportedMapping


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
        scope = load_scope(self.options.scope_path)
        if self.options.root_token_limit > scope.max_tokens:
            raise ValueError("Root allocation exceeds the prepared trial total")
        if scope.expires_at <= datetime.now(timezone.utc):
            raise ValueError("Prepared operator scope has expired")
        # No task-controlled files, tools, skills, verifier state or credentials
        # are uploaded to the native agent. Scoped resources are provisioned by
        # normal platform APIs before this adapter is selected.

    def _mapping(self, instruction: str):
        self._supported()
        scope = load_scope(self.options.scope_path)
        if self.context_id is None:
            raise ValueError("Harbor must supply its durable trial context identity")
        context_id = str(self.context_id)
        if not instruction.strip() or len(instruction.encode("utf-8")) > 8000:
            raise ValueError("Expected a bounded native task instruction")
        path = self.logs_dir / "trial-mapping.json"
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
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()
        if path.exists():
            mapping = read_json(path, 65536)
            if (
                mapping.get("schemaVersion") != "kasitek-trial-mapping.v1"
                or mapping.get("fingerprint") != fingerprint
            ):
                raise ValueError(
                    "Recovered trial differs from the original prepared scope or instruction"
                )
        else:
            deadline = min(
                scope.expires_at,
                datetime.now(timezone.utc)
                + timedelta(seconds=self.options.trial_timeout_sec),
            )
            mapping = {
                "schemaVersion": "kasitek-trial-mapping.v1",
                "contextId": context_id,
                "scopeId": str(scope.scope_id),
                "fingerprint": fingerprint,
                "request": request,
                "prepareRequest": {
                    "trialId": f"harbor:{scope.scope_id}:{context_id}",
                    "agentId": str(scope.agent_id),
                    "versionId": str(scope.version_id),
                    "expectedCompositionDigest": scope.composition_digest,
                    "maxTokens": scope.max_tokens,
                    "expiresAt": deadline.isoformat(),
                },
                "nativeTrialId": None,
                "taskId": None,
                "deadlineAt": deadline.isoformat(),
            }
            persist(path, mapping)
        return scope, mapping, path

    async def run(
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
            "cleanup": {"revocationConfirmed": False, "terminalConfirmed": False},
        }
        context.metadata = {"kasitek": metadata}
        async with PlatformClient(
            scope, credential, timeout=self.options.http_timeout_sec
        ) as client:
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
                        prepared = await client.prepare(mapping["prepareRequest"])
                        mapping["nativeTrialId"] = prepared["trial"]["id"]
                        persist(path, mapping)
                        known = await client.trial(native_id=mapping["nativeTrialId"])
                    elif mapping["nativeTrialId"] is None:
                        mapping["nativeTrialId"] = known["trial"]["id"]
                        persist(path, mapping)
                    if len(known["rootTaskIds"]) > 1:
                        raise UnsupportedMapping(
                            "Single-turn adapter cannot merge multiple native root histories"
                        )
                    if mapping["taskId"] is None and known["rootTaskIds"]:
                        mapping["taskId"] = known["rootTaskIds"][0]
                        persist(path, mapping)
                    if mapping["taskId"]:
                        if mapping["taskId"] not in known["rootTaskIds"]:
                            raise ValueError(
                                "Persisted task is not a root of the native trial"
                            )
                        task = await client.status(mapping["taskId"])
                    else:
                        if known["trial"]["state"] != "active":
                            raise ValueError(
                                "Original native trial was revoked before admission"
                            )
                        task = await client.submit(
                            {
                                **mapping["request"],
                                "evaluationTrialId": mapping["nativeTrialId"],
                            }
                        )
                        mapping["taskId"] = task["id"]
                        persist(path, mapping)
                    if task.get("requestKey") != mapping["request"]["requestKey"]:
                        raise ValueError(
                            "Native task does not match the persisted trial request"
                        )
                    metadata["taskId"] = task["id"]
                    while task["state"] not in TERMINAL_STATES:
                        await asyncio.sleep(self.options.poll_interval_sec)
                        task = await client.status(task["id"])
                    metadata["nativeOutcome"] = task["state"]
                    raw, export = await client.history(task["id"])
                    persist(self.logs_dir / "native-export.json", raw)
                    metadata["coverage"] = export.coverage.model_dump()
                    trajectory = to_atif(export)
                    persist(
                        self.logs_dir / "trajectory.json",
                        trajectory.model_dump(mode="json", exclude_none=True),
                    )
                    metadata["mappingStatus"] = "supported"
                    await client.artifacts(export, self.logs_dir / "artifacts")
                    calls = [call for task in export.tasks for call in task.modelCalls]
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
            persist(path, mapping)
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
