"""Explicit single-trial recovery across Harbor process identities."""

from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import stat
from uuid import UUID


def recovery_path(scope_path: Path, identity: UUID) -> Path:
    return scope_path.with_name(scope_path.name + f".recovery-{identity}.json")


@contextmanager
def exclusive_recovery(scope_path: Path, identity: UUID):
    path = recovery_path(scope_path, identity).with_suffix(".lock")
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        mode = os.fstat(descriptor)
        if (
            not stat.S_ISREG(mode.st_mode)
            or mode.st_mode & 0o077
            or mode.st_uid != os.getuid()
        ):
            raise ValueError(
                "Recovery lock must be an operator-owned private regular file"
            )
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as cause:
            raise ValueError(
                "Another evaluator process owns this active recovery"
            ) from cause
        yield
    finally:
        os.close(descriptor)
