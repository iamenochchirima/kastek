"""Use actual Harbor verifier interface without loading agent auth or runtime."""

from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import unittest

from harbor.verifier.verifier import Verifier
from kasitek_harbor.verifier import RecordedNativeVerifier


class RecordedVerifierTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_three_exact_recorded_files_reach_separate_environment(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            names = ("native-export.json", "evaluation-result.json", "trajectory.json")
            for index, name in enumerate(names):
                (root / name).write_bytes(("recorded-" + str(index)).encode())
            (root / "not-an-input.txt").write_text("must not upload")
            uploads = []

            async def upload(source, target):
                uploads.append((target, Path(source).read_bytes()))

            environment = SimpleNamespace(
                exec=AsyncMock(return_value=SimpleNamespace(return_code=0)),
                upload_file=upload,
            )
            verifier = RecordedNativeVerifier(
                task=SimpleNamespace(),
                trial_paths=SimpleNamespace(agent_dir=root),
                environment=environment,
            )
            with patch.object(Verifier, "verify", new=AsyncMock(return_value="graded")):
                self.assertEqual(await verifier.verify(), "graded")
            self.assertEqual(
                uploads,
                [
                    ("/logs/agent/" + name, ("recorded-" + str(index)).encode())
                    for index, name in enumerate(names)
                ],
            )
