"""Finite operator configuration. Task instructions cannot modify this scope."""

import ipaddress
import os
import re
import stat
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from harbor.agents.options import AgentOptions
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

import json


class ConversationTurn(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    instruction: str = Field(min_length=1, max_length=8000)

    @field_validator("instruction")
    @classmethod
    def bounded_instruction(cls, value: str) -> str:
        if not value.strip() or len(value.encode("utf-8")) > 8000:
            raise ValueError("Expected a bounded public conversation instruction")
        return value


class ChannelOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    deployment_id: UUID
    origin: str

    @field_validator("origin")
    @classmethod
    def channel_origin(cls, value: str) -> str:
        return PreparedScope.origin_only(value)


class AdapterOptions(AgentOptions):
    recovery_id: UUID | None = None
    channel: ChannelOptions | None = None
    follow_ups: list[ConversationTurn] = Field(default_factory=list, max_length=7)

    @model_validator(mode="after")
    def stable_turn_ids(self):
        ids = [turn.id for turn in self.follow_ups]
        if len(set(ids)) != len(ids) or "initial" in ids:
            raise ValueError("Conversation turn IDs must be unique and exclude initial")
        return self

    scope_path: Path
    trial_timeout_sec: float = Field(default=300, gt=0, le=3600)
    http_timeout_sec: float = Field(default=10, gt=0, le=60)
    poll_interval_sec: float = Field(default=0.5, gt=0, le=10)
    root_token_limit: int = Field(default=8192, ge=2048, le=32000)
    cancellation_timeout_sec: float = Field(default=10, gt=0, le=60)


class PreparedScope(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    schema_version: Literal["kasitek-prepared-scope.v1"]
    scope_id: UUID
    origin: str
    organization_id: UUID
    agent_id: UUID
    version_id: UUID
    session_cookie_env: str = "KASITEK_EVALUATION_SESSION"
    cookie_name: Literal["agents_session", "__Host-agents_session"] = "agents_session"
    composition_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    expires_at: AwareDatetime
    max_tokens: int = Field(ge=2048, le=32000)
    isolation: Literal["operator-provisioned-per-trial"]

    @field_validator("origin")
    @classmethod
    def origin_only(cls, value: str) -> str:
        url = urlsplit(value)
        if (
            url.scheme not in {"http", "https"}
            or not url.hostname
            or url.username
            or url.password
            or url.path not in {"", "/"}
            or url.query
            or url.fragment
        ):
            raise ValueError(
                "Expected an HTTP origin without a path, credentials, query or fragment"
            )
        if url.scheme == "http":
            try:
                local = ipaddress.ip_address(url.hostname).is_loopback
            except ValueError:
                local = url.hostname == "localhost"
            if not local:
                raise ValueError("Plain HTTP is supported only on loopback")
        return value.rstrip("/")

    @field_validator("session_cookie_env")
    @classmethod
    def env_name(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,100}", value):
            raise ValueError("Expected an environment variable name")
        return value


def load_scope(path: Path) -> PreparedScope:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        mode = os.fstat(descriptor)
        if (
            not stat.S_ISREG(mode.st_mode)
            or mode.st_mode & 0o077
            or mode.st_uid != os.getuid()
        ):
            raise ValueError(
                "Prepared scope must be an operator-owned private regular file"
            )
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            payload = stream.read(32769)
        if len(payload) > 32768:
            raise ValueError("Prepared scope exceeds its bound")
        scope = PreparedScope.model_validate(json.loads(payload))
    finally:
        os.close(descriptor)
    if scope.cookie_name.startswith("__Host-") and not scope.origin.startswith(
        "https://"
    ):
        raise ValueError("A secure session cookie requires HTTPS")
    return scope
