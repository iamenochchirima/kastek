"""Private, atomic trial checkpoints. Never persist authentication material."""

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def persist(path: Path, value: Any) -> None:
    persist_bytes(
        path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    )


def persist_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path: Path, max_bytes: int = 8_388_608) -> Any:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        value = stream.read(max_bytes + 1)
    if len(value) > max_bytes:
        raise ValueError("Retained evidence exceeds its bound")
    return json.loads(value)
