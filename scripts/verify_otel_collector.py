#!/usr/bin/env python3
"""Send one synthetic OTLP log, metric, and trace to a running Collector."""

import argparse
import json
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def string_attribute(key: str, value: str) -> dict[str, object]:
    return {"key": key, "value": {"stringValue": value}}


def send_signal(endpoint: str, signal: str, payload: dict[str, object]) -> None:
    request = Request(
        f"{endpoint.rstrip('/')}/v1/{signal}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=10) as response:
            response_body = response.read()
            if response.status != 200:
                raise RuntimeError(f"OTLP {signal} returned HTTP {response.status}")
    except (HTTPError, URLError) as error:
        raise RuntimeError(f"OTLP {signal} export failed: {error}") from error

    result = json.loads(response_body) if response_body else {}
    partial = result.get("partialSuccess", {})
    rejected_fields = {
        "logs": "rejectedLogRecords",
        "metrics": "rejectedDataPoints",
        "traces": "rejectedSpans",
    }
    if partial.get("errorMessage") or partial.get(rejected_fields[signal], 0):
        raise RuntimeError(f"OTLP {signal} partially rejected data: {partial}")
    print(f"OTLP {signal}: accepted")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--endpoint",
        default="http://127.0.0.1:4318",
        help="Collector OTLP HTTP base URL (default: %(default)s)",
    )
    endpoint = parser.parse_args().endpoint
    now = str(time.time_ns())
    resource = {
        "attributes": [
            string_attribute("service.name", "kasitek-otel-smoke"),
            string_attribute("deployment.environment.name", "local"),
        ]
    }

    def marker(signal: str) -> list[dict[str, object]]:
        return [
            string_attribute("signal.kind", signal),
            string_attribute("prompt", f"kasitek-otel-redaction-sentinel-{signal}"),
        ]

    send_signal(
        endpoint,
        "logs",
        {
            "resourceLogs": [
                {
                    "resource": resource,
                    "scopeLogs": [
                        {
                            "scope": {"name": "kasitek.otel.smoke"},
                            "logRecords": [
                                {
                                    "timeUnixNano": now,
                                    "observedTimeUnixNano": now,
                                    "severityNumber": 9,
                                    "severityText": "INFO",
                                    "body": {"stringValue": "kasitek-otel-smoke-log"},
                                    "attributes": marker("logs"),
                                }
                            ],
                        }
                    ],
                }
            ]
        },
    )
    send_signal(
        endpoint,
        "metrics",
        {
            "resourceMetrics": [
                {
                    "resource": resource,
                    "scopeMetrics": [
                        {
                            "scope": {"name": "kasitek.otel.smoke"},
                            "metrics": [
                                {
                                    "name": "kasitek.otel.smoke.count",
                                    "unit": "1",
                                    "gauge": {
                                        "dataPoints": [
                                            {
                                                "timeUnixNano": now,
                                                "startTimeUnixNano": now,
                                                "asInt": "1",
                                                "attributes": marker("metrics"),
                                            }
                                        ]
                                    },
                                }
                            ],
                        }
                    ],
                }
            ]
        },
    )
    send_signal(
        endpoint,
        "traces",
        {
            "resourceSpans": [
                {
                    "resource": resource,
                    "scopeSpans": [
                        {
                            "scope": {"name": "kasitek.otel.smoke"},
                            "spans": [
                                {
                                    "traceId": uuid.uuid4().hex,
                                    "spanId": uuid.uuid4().hex[:16],
                                    "name": "kasitek-otel-smoke-span",
                                    "kind": 1,
                                    "startTimeUnixNano": now,
                                    "endTimeUnixNano": str(int(now) + 1_000_000),
                                    "attributes": marker("traces"),
                                }
                            ],
                        }
                    ],
                }
            ]
        },
    )


if __name__ == "__main__":
    main()
