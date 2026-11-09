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
from .enquiries import validate_enquiries
from .records import validate_record, validate_record_command
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
    def __init__(self, status: int, code: str | None = None):
        self.status = status
        self.code = code
        detail = f" (code {code})" if code else ""
        super().__init__(
            f"Platform request rejected (HTTP {status}){detail}; inspect authorized native state"
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
                # Error text can reflect private instructions or credentials. Retain
                # only the status and a bounded machine error code.
                code = None
                try:
                    payload = json.loads(await response.aread())
                    error = payload.get("error") if isinstance(payload, dict) else None
                    candidate = error.get("code") if isinstance(error, dict) else None
                    if isinstance(candidate, str) and re.fullmatch(r"[A-Z0-9_]{2,80}", candidate):
                        code = candidate
                except Exception:
                    pass
                raise PlatformRequestError(response.status_code, code)
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

    async def task_enquiries(self, task_id: str) -> list[dict]:
        await self.status(task_id)
        result = await self.request(
            "GET", f"{self.organization_path}/tasks/{task_id}/enquiries"
        )
        return validate_enquiries(result, agent_id=self.scope.agent_id, task_id=task_id)

    async def decide_enquiry(self, task_id, enquiry_id, decision, request_digest):
        UUID(task_id)
        UUID(enquiry_id)
        if decision not in {"approve", "reject"} or not re.fullmatch(
            r"[a-f0-9]{64}", request_digest
        ):
            raise ValueError("Expected an explicit decision and exact enquiry digest")
        # Only the operator's supplied decision is sent. Repeated transport attempts
        # preserve its task, enquiry and exact field digest.
        await self.status(task_id)
        body = {"decision": decision, "requestDigest": request_digest}
        for attempt in range(2):
            try:
                result = await self.request(
                    "POST",
                    f"{self.organization_path}/tasks/{task_id}/enquiries/{enquiry_id}/decision",
                    body,
                )
                rows = validate_enquiries(
                    {"enquiries": [result.get("enquiry")]},
                    agent_id=self.scope.agent_id,
                    task_id=task_id,
                )
                if (
                    rows[0]["id"] != enquiry_id
                    or rows[0]["requestDigest"] != request_digest
                    or rows[0]["state"] not in ({"approved", "submitted"} if decision == "approve" else {"rejected"})
                ):
                    raise ValueError("Enquiry decision changed its exact request")
                return rows[0]
            except httpx.TransportError:
                if attempt:
                    raise
        raise AssertionError("Unreachable retry state")

    async def submitted_enquiries(self, *, limit=50) -> list[dict]:
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            raise ValueError("Expected a bounded enquiry page size")
        result = await self.request(
            "GET", f"{self.organization_path}/enquiries",
            params={"agentId": str(self.scope.agent_id), "limit": limit},
        )
        rows = validate_enquiries(result, agent_id=self.scope.agent_id, submitted_only=True)
        if len(rows) > limit:
            raise ValueError("Native enquiry response exceeded the requested page")
        return rows

    async def customer_records(self, *, limit=30, cursor=None):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Expected a bounded record page")
        if cursor is not None and (not isinstance(cursor, str) or len(cursor) > 2048):
            raise ValueError("Unexpected record cursor")
        params = {"agentId": str(self.scope.agent_id), "limit": limit}
        if cursor:
            params["cursor"] = cursor
        result = await self.request("GET", f"{self.organization_path}/customer-records/enquiries", params=params)
        rows = result.get("enquiries") if isinstance(result, dict) else None
        if not isinstance(rows, list) or len(rows) > limit:
            raise ValueError("Missing bounded customer records")
        for row in rows:
            validate_record(row, agent_id=self.scope.agent_id)
        next_cursor = result.get("nextCursor")
        if next_cursor is not None and (not isinstance(next_cursor, str) or len(next_cursor) > 2048):
            raise ValueError("Unexpected next record cursor")
        return result

    async def customer_record(self, record_id, *, allow_manual=False):
        UUID(record_id)
        result = await self.request("GET", f"{self.organization_path}/customer-records/enquiries/{record_id}")
        return validate_record(result.get("enquiry"), record_id=record_id, agent_id=None if allow_manual else self.scope.agent_id)

    async def customer_record_activity(self, record_id, *, cursor=None, limit=30, allow_manual=False):
        await self.customer_record(record_id, allow_manual=allow_manual)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Expected a bounded activity page")
        if cursor is not None and (not isinstance(cursor, str) or len(cursor) > 2048):
            raise ValueError("Unexpected activity cursor")
        params = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        result = await self.request("GET", f"{self.organization_path}/customer-records/enquiries/{record_id}/activity", params=params)
        rows = result.get("activity") if isinstance(result, dict) else None
        if not isinstance(rows, list) or len(rows) > limit:
            raise ValueError("Missing bounded record activity")
        for row in rows:
            UUID(row["id"])
            if row.get("actorAccountId") is not None:
                UUID(row["actorAccountId"])
            if not isinstance(row.get("kind"), str) or len(row["kind"]) > 80:
                raise ValueError("Unexpected record activity")
            if row.get("body") is not None and (not isinstance(row["body"], str) or len(row["body"]) > 4000):
                raise ValueError("Unexpected private activity body")
        next_cursor = result.get("nextCursor")
        if next_cursor is not None and (not isinstance(next_cursor, str) or len(next_cursor) > 2048):
            raise ValueError("Unexpected next activity cursor")
        return result

    async def customer_contact_for_record(self, record_id, *, allow_manual=False):
        row = await self.customer_record(record_id, allow_manual=allow_manual)
        contact_id = row.get("contactId")
        if contact_id is None:
            return None
        result = await self.request("GET", f"{self.organization_path}/customer-records/contacts/{contact_id}")
        contact = result.get("contact") if isinstance(result, dict) else None
        if not isinstance(contact, dict) or contact.get("id") != contact_id:
            raise ValueError("Linked contact identity changed")
        for key, bound in (("name", 200), ("email", 320), ("phone", 80)):
            if contact.get(key) is not None and (not isinstance(contact[key], str) or len(contact[key]) > bound):
                raise ValueError("Unexpected linked contact details")
        # Do not return other contacts or unrelated enquiries from the contact response.
        return contact

    async def customer_record_command(self, record_id, command, *, allow_manual=False):
        # The caller supplies the exact native record, revision and explicit command.
        await self.customer_record(record_id, allow_manual=allow_manual)
        body = validate_record_command(command)
        for attempt in range(2):
            try:
                result = await self.request("POST", f"{self.organization_path}/customer-records/enquiries/{record_id}/commands", body)
                return validate_record(result.get("enquiry"), record_id=record_id, agent_id=None if allow_manual else self.scope.agent_id)
            except httpx.TransportError:
                if attempt:
                    raise
        raise AssertionError("Unreachable retry state")

    async def setup_readiness(self) -> dict:
        result = await self.request(
            "GET", f"{self.organization_path}/agents/{self.scope.agent_id}/setup-readiness"
        )
        readiness = result.get("readiness") if isinstance(result, dict) else None
        if (
            not isinstance(readiness, dict)
            or readiness.get("agentId") != str(self.scope.agent_id)
            or type(readiness.get("draftRevision")) is not int
            or readiness["draftRevision"] < 1
            or not isinstance(readiness.get("readyToTest"), bool)
            or not isinstance(readiness.get("requirements"), dict)
            or not isinstance(readiness.get("channels"), list)
        ):
            raise ValueError("Missing native setup readiness")
        for requirement in readiness["requirements"].values():
            if not isinstance(requirement, dict) or requirement.get("state") not in {
                "ready", "needs_setup", "deferred"
            }:
                raise ValueError("Unsupported native setup requirement")
        for channel in readiness["channels"]:
            if (
                not isinstance(channel, dict)
                or channel.get("kind") not in {"website", "whatsapp", "telegram", "facebook", "instagram"}
                or channel.get("state") not in {"connected", "needs_attention", "paused", "needs_connection"}
            ):
                raise ValueError("Unsupported native setup channel")
        # Readiness describes current saved metadata, not the prepared immutable
        # version or a successful live provider call.
        return readiness

    async def cancel(self, task_id: str) -> dict:
        UUID(task_id)
        return self.task(
            await self.request(
                "POST", f"{self.organization_path}/tasks/{task_id}/cancel", {}
            ),
            task_id,
        )

    async def history(self, task_id: str, *, sandbox: bool = False) -> tuple[dict, ExecutionExport]:
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
        ):
            raise ValueError("Authorized export differs from the persisted trial scope")
        if not sandbox and (
            export.modelRoutesDigest != self.scope.model_routes_digest
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
