#!/usr/bin/env python3
"""Small dependency-free REST client smoke for the installation public API.

Set AGENTS_REST_SMOKE_INSTALLATION_ID plus either
AGENTS_REST_SMOKE_TOKEN or AGENTS_REST_SMOKE_SECRET. The secret path performs
the normal audience-specific exchange, then verifies discovery and idempotent
tool acceptance through a plain Python client.
"""

import json
import os
import sys
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def request_json(url: str, method: str = "GET", payload: dict | None = None, token: str | None = None) -> dict:
    headers = {"accept": "application/json"}
    body = None
    if payload is not None:
        headers["content-type"] = "application/json"
        body = json.dumps(payload).encode("utf-8")
    if token:
        headers["authorization"] = f"Bearer {token}"
    try:
        with urlopen(Request(url, method=method, headers=headers, data=body), timeout=15) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed HTTP {error.code}: {detail[:500]}") from error
    except URLError as error:
        raise RuntimeError(f"{method} {url} could not connect: {error.reason}") from error


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def main() -> None:
    api_url = os.environ.get("AGENTS_REST_SMOKE_API_URL", "http://127.0.0.1:4100").rstrip("/")
    installation_id = required("AGENTS_REST_SMOKE_INSTALLATION_ID")
    token = os.environ.get("AGENTS_REST_SMOKE_TOKEN", "").strip()
    if not token:
        secret = required("AGENTS_REST_SMOKE_SECRET")
        exchange = request_json(
            f"{api_url}/v1/installation-tokens/exchange",
            method="POST",
            payload={"secret": secret, "audience": "kasitek-public-api"},
        )
        token = str(exchange.get("accessToken", ""))
        if not token:
            raise RuntimeError(f"token exchange returned no accessToken: {exchange}")

    tools = request_json(f"{api_url}/v1/installations/{installation_id}/tools", token=token)
    names = {tool.get("name") for tool in tools.get("tools", []) if isinstance(tool, dict)}
    if "platform.current_time" not in names:
        raise RuntimeError("discovery did not include granted platform.current_time")

    idempotency_key = f"python-smoke-{uuid.uuid4()}"
    payload = {"name": "platform.current_time", "arguments": {}, "idempotencyKey": idempotency_key}
    first = request_json(f"{api_url}/v1/installations/{installation_id}/tools/call", method="POST", payload=payload, token=token)
    retry = request_json(f"{api_url}/v1/installations/{installation_id}/tools/call", method="POST", payload=payload, token=token)
    first_run = first.get("runId")
    retry_run = retry.get("runId")
    if not isinstance(first_run, str) or retry_run != first_run:
        raise RuntimeError(f"idempotency did not return the original operation: first={first} retry={retry}")

    operation = request_json(
        f"{api_url}/v1/installations/{installation_id}/operations/{first_run}",
        token=token,
    )
    if operation.get("operationId") != first_run:
        raise RuntimeError(f"operation inspection returned the wrong operation: {operation}")
    print(json.dumps({"status": "passed", "installationId": installation_id, "operationId": first_run}))


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
