"""Prepared scope allocation never schedules execution or creates authority."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4
import unittest

from kasitek_harbor.persistence import persist
from kasitek_harbor.scope_pool import select_scope, prepared_scopes
from test_boundaries import scope_value


class ScopePoolTests(unittest.TestCase):
    def test_parallel_assignments_recover_without_reusing_agents_and_fail_when_exhausted(
        self,
    ):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            paths = [root / f"scope-{i}.json" for i in range(2)]
            for path in paths:
                persist(path, scope_value())
            pool = root / "pool.json"
            persist(
                pool,
                {
                    "schema_version": "kasitek-prepared-scope-pool.v1",
                    "scope_paths": list(map(str, paths)),
                },
            )
            identities = [str(uuid4()), str(uuid4())]
            with ThreadPoolExecutor(max_workers=2) as executor:
                selected = list(
                    executor.map(
                        lambda identity: select_scope(pool, identity), identities
                    )
                )
            self.assertNotEqual(selected[0].agent_id, selected[1].agent_id)
            self.assertEqual(select_scope(pool, identities[0]), selected[0])
            with self.assertRaisesRegex(ValueError, "exhausted"):
                select_scope(pool, str(uuid4()))
            persist(paths[0], scope_value())
            with self.assertRaisesRegex(ValueError, "changed"):
                select_scope(pool, identities[0])

    def test_duplicate_agents_and_oversized_pools_are_rejected_before_admission(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            scope = root / "scope.json"
            persist(scope, scope_value())
            pool = root / "pool.json"
            for paths in [[str(scope)] * 2, [str(scope)] * 9]:
                persist(
                    pool,
                    {
                        "schema_version": "kasitek-prepared-scope-pool.v1",
                        "scope_paths": paths,
                    },
                )
                with self.assertRaises(ValueError):
                    prepared_scopes(pool)
