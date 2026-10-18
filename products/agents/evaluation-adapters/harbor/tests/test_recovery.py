"""Private recovery identity is stable; evaluator retries cannot inflate trials."""

import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from uuid import uuid4
import unittest

from kasitek_harbor.agent import KasitekAgent
from kasitek_harbor.persistence import persist
from kasitek_harbor.recovery import exclusive_recovery
from test_boundaries import scope_value


class ProcessRecoveryTests(unittest.TestCase):
    def test_process_shared_lock_excludes_a_second_active_evaluator(self):
        with TemporaryDirectory() as directory:
            scope = Path(directory) / "scope.json"
            identity = uuid4()
            with exclusive_recovery(scope, identity):
                result = subprocess.run(
                    [
                        sys.executable,
                        "-c",
                        "from pathlib import Path;from uuid import UUID;from kasitek_harbor.recovery import exclusive_recovery;\nwith exclusive_recovery(Path(__import__('sys').argv[1]),UUID(__import__('sys').argv[2])):pass",
                        str(scope),
                        str(identity),
                    ],
                    capture_output=True,
                    env=os.environ,
                    timeout=10,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b"Another evaluator process owns", result.stderr)
            with exclusive_recovery(scope, identity):
                pass

    def test_new_harbor_context_recovers_only_unfinished_exact_trial_without_renewal(
        self,
    ):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            scope = root / "scope.json"
            persist(scope, scope_value())
            identity = str(uuid4())
            first = KasitekAgent(
                logs_dir=root / "first", scope_path=str(scope), recovery_id=identity
            )
            first.context_id = uuid4()
            _, mapping, path = first._mapping("Exact original instruction")
            mapping["nativeTrialId"] = str(uuid4())
            mapping["taskId"] = str(uuid4())
            first._save_mapping(path, mapping)
            second = KasitekAgent(
                logs_dir=root / "second", scope_path=str(scope), recovery_id=identity
            )
            second.context_id = uuid4()
            _, resumed, resumed_path = second._mapping("Exact original instruction")
            self.assertEqual(resumed_path, path)
            self.assertEqual(resumed["request"], mapping["request"])
            self.assertEqual(resumed["deadlineAt"], mapping["deadlineAt"])
            self.assertEqual(resumed["prepareRequest"], mapping["prepareRequest"])
            self.assertEqual(resumed["nativeTrialId"], mapping["nativeTrialId"])
            self.assertEqual(resumed["taskId"], mapping["taskId"])
            self.assertEqual(len(resumed["harborContextIds"]), 2)
            with self.assertRaisesRegex(ValueError, "differs"):
                second._mapping("Changed original instruction")
            resumed["finished"] = True
            resumed["completedHarborContextId"] = str(second.context_id)
            second._save_mapping(path, resumed)
            second._mapping("Exact original instruction")
            third = KasitekAgent(
                logs_dir=root / "third", scope_path=str(scope), recovery_id=identity
            )
            third.context_id = uuid4()
            with self.assertRaisesRegex(ValueError, "Completed native recovery"):
                third._mapping("Exact original instruction")
