"""Bounded public-HTTP transport. Authentication never enters trial evidence."""

import hashlib
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import UUID

import httpx

from .config import PreparedScope
from .native import ExecutionExport
from .persistence import persist

TERMINAL_STATES = frozenset(
    {"completed", "failed", "cancelled", "uncertain", "incomplete", "refused"}
)
KNOWN_STATES = TERMINAL_STATES | {
    "accepted",
    "running",
    "waiting_authority",
    "waiting_children",
    "waiting_review",
    "cancel_requested",
    "reconciling",
}


class PlatformRequestError(RuntimeError):
    def __init__(self, status: int):
        self.status = status
        super().__init__(
            f"Platform request rejected (HTTP {status}); inspect authorized native state"
        )


class PlatformClient:
    def __init__(
        self, scope: PreparedScope, session: str, *, timeout: float, transport=None
    ):
        if not re.fullmatch(r"[A-Za-z0-9_.=\-]{16,4096}", session):
            raise ValueError("Expected a bounded session cookie value")
        self.scope = scope
        self.organization_path = f"/api/organizations/{scope.organization_id}"
        self.http = httpx.AsyncClient(
            base_url=scope.origin,
            timeout=httpx.Timeout(timeout),
            cookies={scope.cookie_name: session},
            headers={"origin": scope.origin},
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        )

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.http.aclose()

    async def request(
        self, method: str, path: str, body=None, *, max_bytes=8_388_608, params=None
    ) -> Any:
        if (
            not path.startswith(self.organization_path + "/")
            or "?" in path
            or "#" in path
            or "\\" in path
        ):
            raise ValueError("Request must stay inside the prepared organization")
        async with self.http.stream(
            method, path, json=body if body is not None else None, params=params
        ) as response:
            if not response.is_success:
                # Error text can reflect private instructions or credentials. Retain only status.
                raise PlatformRequestError(response.status_code)
            content = bytearray()
            async for chunk in response.aiter_bytes():
                content.extend(chunk)
                if len(content) > max_bytes:
                    raise ValueError("Platform response exceeds the export bound")
        return json.loads(content)

    async def version(self) -> dict:
        result = await self.request(
            "GET", f"{self.organization_path}/agents/{self.scope.agent_id}"
        )
        versions = result.get("versions")
        if not isinstance(versions, list):
            raise ValueError("Missing published version list")
        matches = [
            version
            for version in versions
            if version.get("id") == str(self.scope.version_id)
        ]
        if len(matches) != 1:
            raise ValueError("Prepared immutable agent version is unavailable")
        version = matches[0]
        if (
            version.get("effectiveComposition", {}).get("digest")
            != self.scope.composition_digest
        ):
            raise ValueError(
                "Prepared composition differs from the published effective composition"
            )
        return version

    async def prepare(self, request: dict) -> dict:
        if (
            request.get("expectedModelRoutesDigest") != self.scope.model_routes_digest
            or request.get("rootTokenLimit") != self.scope.root_token_limit
            or request.get("maxTokens") != self.scope.max_tokens
        ):
            raise ValueError("Trial request differs from the prepared model policy")
        for attempt in range(2):
            try:
                result = await self.request(
                    "POST", f"{self.organization_path}/evaluation-trials", request
                )
                trial = result.get("trial", {})
                UUID(trial["id"])
                if (
                    trial.get("trialId") != request["trialId"]
                    or trial.get("organizationId") != str(self.scope.organization_id)
                    or trial.get("agentId") != str(self.scope.agent_id)
                    or trial.get("versionId") != str(self.scope.version_id)
                    or trial.get("compositionDigest") != self.scope.composition_digest
                    or trial.get("modelRoutesDigest") != self.scope.model_routes_digest
                    or trial.get("rootTokenLimit") != self.scope.root_token_limit
                    or trial.get("maxTokens") != self.scope.max_tokens
                    or trial.get("state") != "active"
                    or result.get("submitPath") != f"{self.organization_path}/tasks"
                    or result.get("taskBinding") != {"evaluationTrialId": trial["id"]}
                    or result.get("revokePath")
                    != f"{self.organization_path}/evaluation-trials/{trial['id']}/revoke"
                ):
                    raise ValueError(
                        "Prepared native trial differs from the operator scope"
                    )
                return result
            except httpx.TransportError:
                if attempt:
                    raise
        raise AssertionError("Unreachable prepare retry state")

    async def trial(
        self, *, native_id: str | None = None, trial_key: str | None = None
    ) -> dict:
        if native_id:
            UUID(native_id)
            result = await self.request(
                "GET", f"{self.organization_path}/evaluation-trials/{native_id}"
            )
        elif trial_key:
            result = await self.request(
                "GET",
                f"{self.organization_path}/evaluation-trials",
                params={"trialId": trial_key},
            )
        else:
            raise ValueError("Expected a persisted native trial or stable trial key")
        trial, roots = result.get("trial"), result.get("rootTaskIds")
        if not isinstance(roots, list) or len(roots) > 100:
            raise ValueError("Missing bounded native trial root identities")
        for task_id in roots:
            UUID(task_id)
        if trial is not None:
            UUID(trial["id"])
            if (
                native_id
                and trial["id"] != native_id
                or trial_key
                and trial.get("trialId") != trial_key
                or trial.get("organizationId") != str(self.scope.organization_id)
                or trial.get("agentId") != str(self.scope.agent_id)
                or trial.get("versionId") != str(self.scope.version_id)
                or trial.get("compositionDigest") != self.scope.composition_digest
                or trial.get("modelRoutesDigest") != self.scope.model_routes_digest
                or trial.get("rootTokenLimit") != self.scope.root_token_limit
                or trial.get("maxTokens") != self.scope.max_tokens
                or trial.get("state") not in {"active", "revoked"}
            ):
                raise ValueError("Native trial lookup differs from the prepared scope")
        elif native_id or roots:
            raise ValueError("Native trial identity is missing")
        return result

    async def revoke(self, trial_id: str) -> dict:
        UUID(trial_id)
        result = await self.request(
            "POST", f"{self.organization_path}/evaluation-trials/{trial_id}/revoke", {}
        )
        if (
            result.get("trial", {}).get("id") != trial_id
            or result["trial"].get("state") != "revoked"
        ):
            raise ValueError("Trial revocation was not confirmed")
        return result

    def task(self, value: Any, expected_id: str | None = None) -> dict:
        task = value.get("task") if isinstance(value, dict) else None
        if not isinstance(task, dict) or not isinstance(task.get("id"), str):
            raise ValueError("Missing native task identity")
        UUID(task["id"])
        if expected_id and task["id"] != expected_id:
            raise ValueError("Native task identity changed")
        if task.get("state") not in KNOWN_STATES:
            raise ValueError("Unsupported native task state")
        if task.get("versionId") != str(self.scope.version_id):
            raise ValueError("Task did not retain the prepared immutable version")
        return task

    async def submit(self, request: dict) -> dict:
        # The caller checkpoints this exact request before admission. Retrying its
        # stable requestKey after a lost transport acknowledgement cannot mint a new task.
        if request.get("versionId") != str(self.scope.version_id):
            raise ValueError("Task request differs from the prepared version")
        for attempt in range(2):
            try:
                return self.task(
                    await self.request(
                        "POST", f"{self.organization_path}/tasks", request
                    )
                )
            except httpx.TransportError:
                if attempt:
                    raise
        raise AssertionError("Unreachable retry state")

    async def status(self, task_id: str) -> dict:
        UUID(task_id)
        return self.task(
            await self.request(
                "GET", f"{self.organization_path}/tasks/{quote(task_id, safe='')}"
            ),
            task_id,
        )

    async def cancel(self, task_id: str) -> dict:
        UUID(task_id)
        return self.task(
            await self.request(
                "POST", f"{self.organization_path}/tasks/{task_id}/cancel", {}
            ),
            task_id,
        )

    async def history(self, task_id: str) -> tuple[dict, ExecutionExport]:
        UUID(task_id)
        raw = await self.request(
            "GET", f"{self.organization_path}/tasks/{task_id}/history-export"
        )
        export = ExecutionExport.model_validate(raw)
        if (
            export.rootTaskId != task_id
            or export.organizationId != str(self.scope.organization_id)
            or export.agentId != str(self.scope.agent_id)
            or export.versionId != str(self.scope.version_id)
            or export.effectiveComposition.digest != self.scope.composition_digest
            or export.modelRoutesDigest != self.scope.model_routes_digest
            or export.modelRoutes["primary"]["policy"]["maxRootTokens"]
            != self.scope.root_token_limit
        ):
            raise ValueError("Authorized export differs from the persisted trial scope")
        return raw, export

    async def artifacts(self, export: ExecutionExport, directory: Path) -> list[dict]:
        retained = []
        total = 0
        if len(export.artifacts) > 20:
            raise ValueError("Artifact export exceeds the adapter bound")
        for artifact in export.artifacts:
            if artifact.downloadPath is None or artifact.contentDigest is None:
                retained.append(
                    {
                        "artifactId": artifact.id,
                        "retained": False,
                        "reason": "withheld_or_unavailable",
                    }
                )
                continue
            UUID(artifact.id)
            paths = {
                f"{self.organization_path}/tasks/{task_id}/artifacts/{artifact.id}"
                for task_id in (artifact.taskId, export.rootTaskId)
            }
            path = artifact.downloadPath
            if path not in paths or not re.fullmatch(
                r"[a-f0-9]{64}", artifact.contentDigest
            ):
                raise ValueError("Artifact has an unsupported scope, route or digest")
            total += artifact.bytes
            if artifact.bytes > 8_388_608 or total > 33_554_432:
                raise ValueError("Trial artifact bytes exceed the adapter bound")
            async with self.http.stream("GET", path) as response:
                if not response.is_success:
                    raise PlatformRequestError(response.status_code)
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > artifact.bytes:
                        raise ValueError(
                            "Artifact size differs from its authoritative record"
                        )
            if (
                len(content) != artifact.bytes
                or hashlib.sha256(content).hexdigest() != artifact.contentDigest
            ):
                raise ValueError(
                    "Artifact digest or size differs from its authoritative record"
                )
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            # Opaque server IDs, not user-supplied filenames, choose the host path.
            target = directory / (artifact.id + ".bin")
            if target.exists() or target.is_symlink():
                import os

                descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(descriptor, "rb") as previous:
                    if previous.read(artifact.bytes + 1) != content:
                        raise ValueError(
                            "Retained artifact differs from the authorized immutable bytes"
                        )
            else:
                from .persistence import persist_bytes

                persist_bytes(target, bytes(content))
            retained.append(
                {
                    "artifactId": artifact.id,
                    "taskId": artifact.taskId,
                    "file": f"artifacts/{target.name}",
                    "contentDigest": artifact.contentDigest,
                    "bytes": artifact.bytes,
                    "retained": True,
                }
            )
        persist(directory.parent / "artifact-manifest.json", retained)
        return retained
