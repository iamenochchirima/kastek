"""ATIF conversion of authorized native receipts, with no invented reasoning."""

import json
from typing import Any

from harbor.models.trajectories.trajectory import Trajectory

from . import __version__
from .native import ExecutionExport, NativeTask


class UnsupportedMapping(ValueError):
    pass


def to_atif(export: ExecutionExport) -> Trajectory:
    tasks = {task.id: task for task in export.tasks}
    branch_links = []

    def convert(task: NativeTask) -> dict[str, Any]:
        steps: list[dict[str, Any]] = []
        if task.input is not None:
            steps.append(
                {
                    "source": "user",
                    "message": task.input,
                    "extra": {"provenance": "native-task-input", "taskId": task.id},
                }
            )
        attempts = []
        for call in sorted(task.modelCalls, key=lambda item: item.step):
            if call.outputMessage is None:
                attempts.append(call.model_dump(mode="json", exclude_unset=True))
                continue
            tools = call.outputMessage.tool_calls or []
            tool_calls = []
            for tool in tools:
                try:
                    arguments = json.loads(tool.function.arguments)
                except ValueError as cause:
                    raise UnsupportedMapping(
                        "Native tool arguments are not valid JSON"
                    ) from cause
                if not isinstance(arguments, dict):
                    raise UnsupportedMapping(
                        "ATIF requires object tool arguments; native arguments were retained"
                    )
                tool_calls.append(
                    {
                        "tool_call_id": f"{call.operationId}:{tool.id}",
                        "function_name": tool.function.name,
                        "arguments": arguments,
                        "extra": {"nativeToolCallId": tool.id},
                    }
                )
            results = []
            for result in call.toolResults:
                linked = [
                    child
                    for child in tasks.values()
                    if child.parentTaskId == task.id
                    and child.parentOperationId == result.operationId
                ]
                item: dict[str, Any] = {
                    "source_call_id": f"{call.operationId}:{result.toolCallId}",
                    "content": result.content,
                    "extra": {
                        "operationId": result.operationId,
                        "state": result.state,
                        "provenance": "native-operation-receipt",
                    },
                }
                if linked:
                    item["subagent_trajectory_ref"] = [
                        {"trajectory_id": child.id} for child in linked
                    ]
                    branch_links.extend(
                        {
                            "parentTaskId": task.id,
                            "parentOperationId": result.operationId,
                            "childTaskId": child.id,
                        }
                        for child in linked
                    )
                results.append(item)
            step: dict[str, Any] = {
                "source": "agent",
                "message": call.outputMessage.content or "",
                "model_name": call.model,
                "llm_call_count": 1,
                "extra": {
                    "operationId": call.operationId,
                    "nativeStep": call.step,
                    "state": call.state,
                    "inputMessages": [
                        item.model_dump(mode="json", exclude_unset=True)
                        for item in call.inputMessages
                    ],
                    "outputMessage": call.outputMessage.model_dump(
                        mode="json", exclude_unset=True
                    ),
                    "toolDefinitions": call.toolDefinitions,
                },
            }
            if tool_calls:
                step["tool_calls"] = tool_calls
            if results:
                step["observation"] = {"results": results}
            if call.usage:
                metrics = {}
                if call.usage.inputTokens is not None:
                    metrics["prompt_tokens"] = call.usage.inputTokens
                if call.usage.outputTokens is not None:
                    metrics["completion_tokens"] = call.usage.outputTokens
                if metrics:
                    step["metrics"] = metrics
                step["extra"]["nativeUsage"] = call.usage.model_dump()
            steps.append(step)
        if not steps:
            raise UnsupportedMapping(
                "No authored input or recorded response can form an ATIF step"
            )
        for index, step in enumerate(steps, 1):
            step["step_id"] = index
        return {
            "schema_version": "ATIF-v1.8",
            "session_id": export.rootTaskId,
            "trajectory_id": task.id,
            "agent": {"name": "kasitek", "version": __version__},
            "steps": steps,
            "extra": {
                "nativeTaskId": task.id,
                "nativeOutcome": task.state,
                "parentTaskId": task.parentTaskId,
                "parentOperationId": task.parentOperationId,
                "unansweredModelAttempts": attempts,
            },
        }

    root = convert(tasks[export.rootTaskId])
    children = [convert(task) for task in export.tasks if task.id != export.rootTaskId]
    if children:
        root["subagent_trajectories"] = children
    root["extra"].update(
        {
            "schemaVersion": export.schemaVersion,
            "versionId": export.versionId,
            "effectiveComposition": export.effectiveComposition.model_dump(mode="json"),
            "coverage": export.coverage.model_dump(mode="json"),
            "branches": branch_links,
            "nativeEvidenceFile": "native-export.json",
            "conversionPolicy": "Exact model inputs are retained as snapshots, not reconstructed authored turns. No hidden reasoning is inferred.",
        }
    )
    return Trajectory.model_validate(root)
