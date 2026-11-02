"""Harbor's separate verifier receives only its seeded native evidence files."""

import os
from pathlib import Path
import stat
from tempfile import TemporaryDirectory

from harbor.verifier.verifier import Verifier

from .persistence import persist_bytes


class RecordedNativeVerifier(Verifier):
    async def verify(self):
        result = await self.environment.exec("mkdir -p /logs/agent")
        if result.return_code:
            raise ValueError("Cannot prepare the separate native-evidence directory")
        with TemporaryDirectory(prefix="kasitek-harbor-verifier-") as directory:
            for name in (
                "native-export.json",
                "evaluation-result.json",
                "trajectory.json",
            ):
                source = self.trial_paths.agent_dir / name
                descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(descriptor, "rb") as stream:
                    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                        raise ValueError(
                            "Recorded native evidence must be a regular file"
                        )
                    content = stream.read(16777217)
                if len(content) > 16777216:
                    raise ValueError("Recorded native evidence exceeds its bound")
                staged = Path(directory) / name
                persist_bytes(staged, content)
                await self.environment.upload_file(staged, f"/logs/agent/{name}")
        return await super().verify()
