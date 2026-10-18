"""Finite operator-prepared scopes for Harbor-owned repeated trials."""

import fcntl
import hashlib
import json
import os
import stat
from pathlib import Path
from uuid import UUID

from .config import PreparedScope, load_scope
from .persistence import persist, read_json


def prepared_scopes(path: Path) -> list[PreparedScope]:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        mode = os.fstat(descriptor)
        if (
            not stat.S_ISREG(mode.st_mode)
            or mode.st_mode & 0o077
            or mode.st_uid != os.getuid()
        ):
            raise ValueError(
                "Prepared scope pool must be an operator-owned private regular file"
            )
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            payload = stream.read(32769)
        if len(payload) > 32768:
            raise ValueError("Prepared scope pool exceeds its bound")
        value = json.loads(payload)
    finally:
        os.close(descriptor)
    if value.get("schema_version") != "kasitek-prepared-scope-pool.v1":
        return [load_scope(path)]
    if (
        set(value) != {"schema_version", "scope_paths"}
        or not isinstance(value["scope_paths"], list)
        or not 1 <= len(value["scope_paths"]) <= 8
    ):
        raise ValueError("Expected a finite pool of one to eight prepared scope files")
    paths = value["scope_paths"]
    if any(not isinstance(item, str) or not Path(item).is_absolute() for item in paths):
        raise ValueError("Prepared scope paths must be absolute")
    scopes = [load_scope(Path(item)) for item in paths]
    if len({item.scope_id for item in scopes}) != len(scopes) or len(
        {(item.origin, item.organization_id, item.agent_id) for item in scopes}
    ) != len(scopes):
        raise ValueError(
            "Each repeated trial requires its own scope and dedicated agent"
        )
    return scopes


def select_scope(path: Path, context_id: str) -> PreparedScope:
    UUID(context_id)
    scopes = prepared_scopes(path)
    if len(scopes) == 1:
        return scopes[0]
    digest = hashlib.sha256(
        json.dumps(
            [item.model_dump(mode="json") for item in scopes], sort_keys=True
        ).encode()
    ).hexdigest()
    lock_path = path.with_name(path.name + ".lock")
    assignments_path = path.with_name(path.name + ".assignments.json")
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        mode = os.fstat(descriptor)
        if (
            not stat.S_ISREG(mode.st_mode)
            or mode.st_mode & 0o077
            or mode.st_uid != os.getuid()
        ):
            raise ValueError("Scope assignment lock must be private")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        state = (
            read_json(assignments_path, 16384)
            if assignments_path.exists()
            else {"digest": digest, "assignments": {}}
        )
        if state.get("digest") != digest or not isinstance(
            state.get("assignments"), dict
        ):
            raise ValueError("Prepared scope pool changed after trial assignment")
        assignments = state["assignments"]
        if context_id not in assignments:
            used = set(assignments.values())
            available = [index for index in range(len(scopes)) if index not in used]
            if not available:
                raise ValueError(
                    "Prepared scope pool is exhausted; no agent may be reused"
                )
            assignments[context_id] = available[0]
            persist(assignments_path, state)
        index = assignments[context_id]
        if not isinstance(index, int) or not 0 <= index < len(scopes):
            raise ValueError("Invalid retained scope assignment")
        return scopes[index]
    finally:
        os.close(descriptor)
