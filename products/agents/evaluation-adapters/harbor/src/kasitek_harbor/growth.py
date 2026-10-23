"""Optional Harbor adapter for normal Growth product conversations and records."""

import asyncio
import hashlib
import json
import os
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid5

from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.options import AgentOptions
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from . import __version__
from .config import ConversationTurn, PreparedScope
from .growth_client import GrowthClient, TERMINAL_STATES, product_id
from .persistence import persist
from .recovery import exclusive_recovery, recovery_path


class GrowthContext(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["workspace", "content_post", "whatsapp_campaign", "analytics_report"]
    resourceId: str | None = None
    range: dict[str, str] | None = None

    @model_validator(mode="after")
    def complete(self):
        if self.kind in {"content_post", "whatsapp_campaign"} and not self.resourceId:
            raise ValueError("A record context requires its product identifier")
        if self.resourceId:
            product_id(self.resourceId)
        if self.kind == "analytics_report" and (
            not self.range or set(self.range) != {"from", "to", "timezone"}
        ):
            raise ValueError("Analytics context requires its actual report range")
        return self


class GrowthPreparedScope(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    schema_version: Literal["kasitek-growth-prepared-scope.v1"]
    scope_id: UUID
    origin: str
    business_id: str
    user_id: str
    feature_id: Literal["assistant", "research", "content", "campaigns"]
    context: GrowthContext | None = None
    session_cookie_env: str = "KASITEK_GROWTH_EVALUATION_SESSION"
    expires_at: AwareDatetime
    max_turns: int = Field(default=1, ge=1, le=8)
    isolation: Literal["operator-provisioned-per-trial-business"]

    @field_validator("origin")
    @classmethod
    def origin_only(cls, value):
        return PreparedScope.origin_only(value)

    @field_validator("session_cookie_env")
    @classmethod
    def env_name(cls, value):
        return PreparedScope.env_name(value)

    @field_validator("business_id", "user_id")
    @classmethod
    def identifier(cls, value):
        product_id(value)
        return value


def private_json(path, bound=32768):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        mode = os.fstat(descriptor)
        if (
            not stat.S_ISREG(mode.st_mode)
            or mode.st_mode & 0o077
            or mode.st_uid != os.getuid()
        ):
            raise ValueError(
                "Growth scope/checkpoint must be a private operator-owned file"
            )
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            payload = stream.read(bound + 1)
        if len(payload) > bound:
            raise ValueError("Growth scope/checkpoint exceeds its bound")
        return json.loads(payload)
    finally:
        os.close(descriptor)


class GrowthAdapterOptions(AgentOptions):
    scope_path: Path
    follow_ups: list[ConversationTurn] = Field(default_factory=list, max_length=7)
    review_decision: Literal["approve", "reject"] | None = None
    trial_timeout_sec: float = Field(default=300, gt=0, le=3600)
    http_timeout_sec: float = Field(default=10, gt=0, le=60)
    poll_interval_sec: float = Field(default=0.5, gt=0, le=10)
    cancellation_timeout_sec: float = Field(default=10, gt=0, le=60)

    @model_validator(mode="after")
    def stable_ids(self):
        ids = [item.id for item in self.follow_ups]
        if len(set(ids)) != len(ids) or "initial" in ids:
            raise ValueError("Scripted turn identifiers must be distinct")
        return self


class GrowthHarborAgent(BaseAgent):
    options_model = GrowthAdapterOptions
    # Growth's product API does not expose native model/tool snapshots. Never synthesize ATIF.
    capabilities = AgentCapabilities(atif=False)

    @staticmethod
    def name():
        return "kasitek-growth"

    def version(self):
        return __version__

    def _scope(self):
        if (
            self.mcp_servers
            or self.skills_dir
            or self.load_trajectory
            or self.model_name
        ):
            raise ValueError(
                "Growth evaluates its configured product feature without task model/tool overrides"
            )
        scope = GrowthPreparedScope.model_validate(
            private_json(self.options.scope_path)
        )
        if scope.expires_at <= datetime.now(timezone.utc):
            raise ValueError("Prepared Growth scope expired")
        if 1 + len(self.options.follow_ups) > scope.max_turns:
            raise ValueError("Script exceeds the prepared turn allocation")
        if self.options.review_decision and scope.feature_id != "content":
            raise ValueError(
                "Only Content has an installed reviewed mutation in this adapter"
            )
        return scope

    async def setup(self, environment):
        self._scope()

    def _mapping(self, scope, instruction):
        if self.context_id is None:
            raise ValueError("Harbor must supply its stable trial context")
        context_id = str(UUID(str(self.context_id)))
        ConversationTurn(id="initial", instruction=instruction)
        fingerprint = hashlib.sha256(
            json.dumps(
                {
                    "scope": scope.model_dump(mode="json"),
                    "instruction": instruction,
                    "followUps": [
                        turn.model_dump() for turn in self.options.follow_ups
                    ],
                    "reviewDecision": self.options.review_decision,
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()
        path = recovery_path(self.options.scope_path, scope.scope_id)
        if path.exists():
            mapping = private_json(path, 262144)
            if (
                mapping.get("contextId") != context_id
                or mapping.get("fingerprint") != fingerprint
            ):
                raise ValueError(
                    "A prepared Growth business may serve only its original Harbor trial"
                )
        else:
            context = (
                scope.context.model_dump(exclude_none=True) if scope.context else None
            )
            mapping = {
                "schemaVersion": "kasitek-growth-trial-mapping.v1",
                "contextId": context_id,
                "fingerprint": fingerprint,
                "conversationId": None,
                "conversationRequest": {
                    "requestId": str(
                        uuid5(scope.scope_id, context_id + ":conversation")
                    ),
                    "featureId": scope.feature_id,
                    "context": context,
                },
                "deadlineAt": min(
                    scope.expires_at,
                    datetime.now(timezone.utc)
                    + timedelta(seconds=self.options.trial_timeout_sec),
                ).isoformat(),
                "turns": [
                    {
                        "id": turn.id,
                        "taskId": None,
                        "request": {
                            "requestId": str(
                                uuid5(scope.scope_id, context_id + ":turn:" + turn.id)
                            ),
                            "text": turn.instruction,
                            "context": context,
                        },
                    }
                    for turn in [
                        ConversationTurn(id="initial", instruction=instruction),
                        *self.options.follow_ups,
                    ]
                ],
                "events": {},
                "eventCursors": {},
                "finished": False,
            }
            persist(
                path, mapping
            )  # Claims a single trial even when the first POST acknowledgement is lost.
        self._save(path, mapping)
        return mapping, path

    def _save(self, path, mapping):
        persist(path, mapping)
        persist(self.logs_dir / "trial-mapping.json", mapping)

    async def run(self, instruction, environment, context):
        scope = self._scope()
        with exclusive_recovery(self.options.scope_path, scope.scope_id):
            mapping, path = self._mapping(scope, instruction)
            session = self._get_env(scope.session_cookie_env)
            if not session:
                raise ValueError("Prepared Growth session is unavailable")
            result = {
                "schemaVersion": "kasitek-growth-evaluation-result.v1",
                "scopeId": str(scope.scope_id),
                "businessId": scope.business_id,
                "featureId": scope.feature_id,
                "turns": [],
                "coverage": {
                    "productHttp": True,
                    "authoritativeRecords": "not_requested",
                    "nativeModelToolSnapshots": "unavailable",
                    "atif": "unavailable",
                    "serverTrialReservation": "unavailable",
                    "modelPolicyPins": "unavailable",
                },
                "cleanup": {"admissionFenced": False, "terminalConfirmed": False},
            }
            context.metadata = {"kasitekGrowth": result}
            async with GrowthClient(
                scope, session, timeout=self.options.http_timeout_sec
            ) as client:
                try:
                    remaining = (
                        datetime.fromisoformat(mapping["deadlineAt"])
                        - datetime.now(timezone.utc)
                    ).total_seconds()
                    if remaining <= 0:
                        raise TimeoutError("Original Growth trial deadline passed")
                    async with asyncio.timeout(remaining):
                        await client.bootstrap()
                        if mapping["conversationId"] is None:
                            # A retry with the same request resolves a lost create acknowledgement.
                            # Freshness is checked only before this trial's first create attempt.
                            if not mapping.get("createAttempted"):
                                await client.unused()
                                mapping["createAttempted"] = True
                                self._save(path, mapping)
                            conversation = await client.conversation(
                                mapping["conversationRequest"]
                            )
                            mapping["conversationId"] = conversation["id"]
                            self._save(path, mapping)
                        for turn in mapping["turns"]:
                            await client.bootstrap()
                            task = (
                                await client.status(
                                    mapping["conversationId"], turn["taskId"]
                                )
                                if turn["taskId"]
                                else await client.submit(
                                    mapping["conversationId"], turn["request"]
                                )
                            )
                            turn["taskId"] = task["id"]
                            self._save(path, mapping)
                            while task["state"] not in TERMINAL_STATES:
                                await self._events(client, mapping, path, task["id"])
                                if (
                                    task["state"] == "waiting_review"
                                    and self.options.review_decision
                                ):
                                    for review in await client.reviews(
                                        mapping["conversationId"], task["id"]
                                    ):
                                        if review.get("state") == "proposed":
                                            await client.decide(
                                                mapping["conversationId"],
                                                task["id"],
                                                review,
                                                self.options.review_decision,
                                                str(
                                                    uuid5(
                                                        scope.scope_id,
                                                        mapping["contextId"]
                                                        + ":decision:"
                                                        + review["id"],
                                                    )
                                                ),
                                            )
                                await asyncio.sleep(self.options.poll_interval_sec)
                                task = await client.status(
                                    mapping["conversationId"], task["id"]
                                )
                            await self._events(client, mapping, path, task["id"])
                            reviews = (
                                await client.reviews(
                                    mapping["conversationId"], task["id"]
                                )
                                if scope.feature_id == "content"
                                else []
                            )
                            outcomes = [
                                await client.saved_outcome(
                                    mapping["conversationId"], task["id"], review
                                )
                                for review in reviews
                                if review.get("result")
                            ]
                            if outcomes:
                                result["coverage"]["authoritativeRecords"] = "verified"
                            evidence = {
                                "task": task,
                                "events": mapping["events"].get(task["id"], []),
                                "reviews": reviews,
                                "artifacts": await client.artifacts(task["id"]),
                                "authoritativeOutcomes": outcomes,
                            }
                            persist(
                                self.logs_dir
                                / "turns"
                                / turn["id"]
                                / "growth-product-history.json",
                                evidence,
                            )
                            result["turns"].append(
                                {
                                    "id": turn["id"],
                                    "taskId": task["id"],
                                    "state": task["state"],
                                    "evidenceFile": f"turns/{turn['id']}/growth-product-history.json",
                                }
                            )
                            if task["state"] != "completed":
                                break
                        result["scriptCompleted"] = len(result["turns"]) == len(
                            mapping["turns"]
                        ) and all(
                            turn["state"] == "completed" for turn in result["turns"]
                        )
                except BaseException as error:
                    result["adapterFailure"] = type(error).__name__
                    raise
                finally:
                    interrupted = None
                    try:
                        async with asyncio.timeout(
                            self.options.cancellation_timeout_sec
                        ):
                            await self._cleanup(
                                client, scope, mapping, result["cleanup"]
                            )
                    except asyncio.CancelledError as error:
                        result["cleanup"]["failure"] = type(error).__name__
                        interrupted = error
                    except Exception as error:
                        result["cleanup"]["failure"] = type(error).__name__
                    mapping["finished"] = result["cleanup"]["terminalConfirmed"]
                    self._save(path, mapping)
                    persist(self.logs_dir / "evaluation-result.json", result)
                    if interrupted:
                        raise interrupted

    async def _events(self, client, mapping, path, task_id):
        events = mapping["events"].setdefault(task_id, [])
        if len(events) >= 1000:
            raise ValueError("Growth product event evidence exceeded its bound")
        for _ in range(10):
            previous = mapping["eventCursors"].get(task_id)
            value = await client.events(task_id, previous)
            page = value.get("events")
            if not isinstance(page, list) or len(page) > 100:
                raise ValueError("Invalid product event page")
            seen = {event["id"] for event in events}
            for event in page:
                if (
                    event.get("taskId") != task_id
                    or not str(event.get("id", "")).isdigit()
                ):
                    raise ValueError("Product event escaped its accepted task")
                if event["id"] not in seen:
                    events.append(event)
                    seen.add(event["id"])
            if len(events) > 1000:
                raise ValueError("Growth product event evidence exceeded its bound")
            mapping["eventCursors"][task_id] = value.get("nextCursor")
            self._save(path, mapping)
            if (
                len(page) < 100
                or not value.get("nextCursor")
                or value["nextCursor"] == previous
            ):
                return
        raise ValueError("Growth product event pagination exceeded its bound")

    async def _cleanup(self, client, scope, mapping, result):
        conversation_id = mapping["conversationId"]
        if conversation_id is None:
            result["terminalConfirmed"] = not mapping.get("createAttempted", False)
            return
        tasks = await client.tasks(conversation_id)
        result["roots"] = []
        for task in tasks:
            if task["state"] not in TERMINAL_STATES:
                await client.cancel(
                    conversation_id,
                    task["id"],
                    str(
                        uuid5(
                            scope.scope_id,
                            mapping["contextId"] + ":cancel:" + task["id"],
                        )
                    ),
                )
                while task["state"] not in TERMINAL_STATES:
                    await asyncio.sleep(self.options.poll_interval_sec)
                    task = await client.status(conversation_id, task["id"])
            result["roots"].append(
                {
                    "taskId": task["id"],
                    "state": task["state"],
                    "terminalConfirmed": task["state"] != "uncertain",
                }
            )
        result["terminalConfirmed"] = all(
            task["terminalConfirmed"] for task in result["roots"]
        )
