"""Explicit synthetic schema fixtures. These are not platform acceptance evidence."""

from copy import deepcopy
from uuid import uuid4

from kasitek_harbor.native import model_routes_digest


def native_export(with_child=False):
    root, child = str(uuid4()), str(uuid4())
    result = {
        "schemaVersion": "execution-export.v1",
        "rootTaskId": root,
        "organizationId": str(uuid4()),
        "agentId": str(uuid4()),
        "versionId": str(uuid4()),
        "effectiveComposition": {
            "digest": "a" * 64,
            "programId": "tool-directed",
            "programVersion": "1",
            "runtime": "business-v1",
            "capabilities": [],
            "workflows": [],
        },
        "coverage": {
            key: {"status": "complete", "omissions": []}
            for key in [
                "modelInputs",
                "modelOutputs",
                "toolCalls",
                "toolResults",
                "children",
                "artifacts",
                "observations",
                "effects",
            ]
        },
        "artifacts": [],
        "observations": [],
        "effectReceipts": [],
        "tasks": [
            {
                "id": root,
                "parentTaskId": None,
                "parentOperationId": None,
                "state": "completed",
                "input": "Research the approved source.",
                "output": "Recorded answer",
                "modelCalls": [
                    {
                        "operationId": "model:root:0",
                        "step": 0,
                        "model": "fixture-only",
                        "state": "completed",
                        "inputMessages": [
                            {"role": "system", "content": "Instructions"},
                            {
                                "role": "user",
                                "content": "Research the approved source.",
                            },
                        ],
                        "outputMessage": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "provider-call",
                                    "type": "function",
                                    "function": {
                                        "name": "agents.delegate"
                                        if with_child
                                        else "knowledge.read",
                                        "arguments": "{}",
                                    },
                                }
                            ],
                        },
                        "toolDefinitions": [
                            {"type": "function", "function": {"name": "knowledge.read"}}
                        ],
                        "usage": {
                            "inputTokens": 11,
                            "outputTokens": 4,
                            "totalTokens": 15,
                        },
                        "toolResults": [
                            {
                                "toolCallId": "provider-call",
                                "operationId": "tool:root:0",
                                "name": "agents.delegate"
                                if with_child
                                else "knowledge.read",
                                "state": "completed",
                                "content": "UNTRUSTED_SOURCE_TEXT",
                                "childTaskIds": [child] if with_child else [],
                            }
                        ],
                    },
                    {
                        "operationId": "model:root:1",
                        "step": 1,
                        "model": "fixture-only",
                        "state": "completed",
                        "inputMessages": [
                            {"role": "system", "content": "Instructions"},
                            {"role": "user", "content": "UNTRUSTED_COMPACTED_CONTEXT"},
                        ],
                        "outputMessage": {
                            "role": "assistant",
                            "content": "Recorded answer",
                        },
                        "toolDefinitions": [],
                        "usage": {
                            "inputTokens": None,
                            "outputTokens": None,
                            "totalTokens": 20,
                        },
                        "toolResults": [],
                    },
                ],
            }
        ],
    }
    if with_child:
        result["tasks"].append(
            {
                "id": child,
                "parentTaskId": root,
                "parentOperationId": "tool:root:0",
                "state": "completed",
                "input": "Child brief",
                "output": "Child answer",
                "modelCalls": [
                    {
                        "operationId": "model:child:0",
                        "step": 0,
                        "model": "fixture-only",
                        "state": "completed",
                        "inputMessages": [{"role": "user", "content": "Child brief"}],
                        "outputMessage": {
                            "role": "assistant",
                            "content": "Child answer",
                        },
                        "toolDefinitions": [],
                        "usage": None,
                        "toolResults": [],
                    }
                ],
            }
        )
    routes = {}
    for role in ("primary", "compaction", "delegated"):
        routes[role] = {
            "binding": {
                "organizationId": result["organizationId"],
                "connectionId": str(uuid4()),
                "modelId": "fixture-only",
                "modelRevision": "fixture-v1",
                "providerId": "fixture",
                "protocol": "openai_chat",
                "role": role,
                "policyDigest": "c" * 64,
            },
            "policy": {"digest": "c" * 64, "maxRootTokens": 16384},
            "definition": {"id": "fixture", "protocol": "openai_chat"},
            "model": {
                "id": "fixture-only",
                "revision": "fixture-v1",
                "providerId": "fixture",
                "protocol": "openai_chat",
            },
            "consumer": {"kind": "agent", "agentId": result["agentId"]},
        }
    result["modelRoutes"] = routes
    result["modelRoutesDigest"] = model_routes_digest(routes)
    for task in result["tasks"]:
        task_routes = deepcopy(routes)
        if task["parentTaskId"] is not None:
            task_routes = {role: deepcopy(routes["delegated"]) for role in routes}
            task_routes["compaction"]["binding"]["role"] = "compaction"
        task["modelRoutes"] = task_routes
        task["modelRoutesDigest"] = model_routes_digest(task_routes)
        for call in task["modelCalls"]:
            call["modelBinding"] = deepcopy(task_routes["primary"]["binding"])
            call["effectivePolicy"] = deepcopy(task_routes["primary"]["policy"])
    return result
