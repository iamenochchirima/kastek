#!/usr/bin/env python3
"""Run the same native evaluation trial without Harbor, then grade locally."""

import argparse
import asyncio
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
import time
from uuid import uuid4

from kasitek_harbor.client import PlatformClient, TERMINAL_STATES
from kasitek_harbor.config import load_scope


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--scope", required=True)
    result.add_argument("--instruction", required=True)
    result.add_argument("--result", required=True)
    result.add_argument("--timeout", type=float, default=120)
    result.add_argument("--poll", type=float, default=0.5)
    return result


async def run(args):
    scope = load_scope(Path(args.scope))
    session = os.environ.get(scope.session_cookie_env)
    if not session:
        raise ValueError(f"Missing evaluation session in {scope.session_cookie_env}")
    trial_id = None
    async with PlatformClient(scope, session, timeout=min(args.timeout, 120)) as client:
        prepared = await client.prepare({
            "trialId": f"core:{scope.scope_id}:{uuid4()}",
            "agentId": str(scope.agent_id),
            "versionId": str(scope.version_id),
            "expectedCompositionDigest": scope.composition_digest,
            "expectedModelRoutesDigest": scope.model_routes_digest,
            "rootTokenLimit": scope.root_token_limit,
            "maxTokens": scope.max_tokens,
            "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
        })
        trial_id = prepared["trial"]["id"]
        task = await client.submit({
            "versionId": str(scope.version_id),
            "requestKey": str(uuid4()),
            "input": args.instruction,
            "evaluationRootTokenLimit": scope.root_token_limit,
            "evaluationTrialId": trial_id,
        })
        deadline = time.monotonic() + args.timeout
        while task["state"] not in TERMINAL_STATES:
            if time.monotonic() >= deadline:
                raise TimeoutError("Native task did not settle before the evaluation deadline")
            await asyncio.sleep(args.poll)
            task = await client.status(task["id"])
        raw, export = await client.history(task["id"])
        root = next((entry for entry in raw["tasks"] if entry["id"] == raw["rootTaskId"]), None)
        output = (root or {}).get("output") or ""
        references = (root or {}).get("evidenceReferences") or []
        checks = {
            "nativeCompleted": bool(root) and root.get("state") == "completed",
            "factPresent": "nine" in output.lower(),
            "citationPresent": any(
                f"[{reference.get('citation_label')}]" in output
                for reference in references
                if isinstance(reference, dict) and reference.get("citation_label")
            ),
            "coverageComplete": all(
                part.get("status") == "complete" for part in raw["coverage"].values()
            ),
            "noEffects": not raw.get("effectReceipts"),
            "versionMatched": export.versionId == str(scope.version_id),
        }
        cleanup = False
        try:
            revoked = await client.revoke(trial_id)
            cleanup = revoked.get("trial", {}).get("state") == "revoked"
        finally:
            trial_id = None
        checks["cleanupRevoked"] = cleanup
        passed = all(checks.values())
        result = {
            "schemaVersion": "kasitek-core-evaluation.v1",
            "evaluator": "local-core",
            "status": "passed" if passed else "failed",
            "scopeId": str(scope.scope_id),
            "agentId": str(scope.agent_id),
            "versionId": str(scope.version_id),
            "nativeTrialId": prepared["trial"]["id"],
            "taskId": task["id"],
            "checks": checks,
            "coverage": raw["coverage"],
            "evidenceReferences": references,
            "output": output,
        }
        Path(args.result).write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2))
        return 0 if passed else 1


def main():
    args = parser().parse_args()
    try:
        return asyncio.run(run(args))
    except Exception as error:
        print(json.dumps({"status": "failed", "evaluator": "local-core", "error": type(error).__name__, "message": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
