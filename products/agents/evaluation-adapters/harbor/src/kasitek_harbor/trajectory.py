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
            unobserved_receipts = []
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
                if result.content is None:
                    unobserved_receipts.append(
                        result.model_dump(mode="json", exclude_unset=True)
                    )
                else:
                    results.append(item)
            step: dict[str, Any] = {
                "source": "agent",
                "message": call.outputMessage.content or "",
                "model_name": call.model,
                "llm_call_count": 1,
                "extra": {
                    "operationId": call.operationId,
                    "nativeStep": call.step,
                    "modelBinding": call.modelBinding,
                    "effectivePolicy": call.effectivePolicy,
                    "state": call.state,
                    "inputMessages": [
                        item.model_dump(mode="json", exclude_unset=True)
                        for item in call.inputMessages
                    ],
                    "outputMessage": call.outputMessage.model_dump(
                        mode="json", exclude_unset=True
                    ),
                    "toolDefinitions": call.toolDefinitions,
                    **(
                        {"unobservedToolReceipts": unobserved_receipts}
                        if unobserved_receipts
                        else {}
                    ),
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
                "nativeAgentId": task.agentId,
                "nativeVersionId": task.versionId,
                "nativeComposition": task.effectiveComposition,
                "modelRoutes": task.modelRoutes,
                "modelRoutesDigest": task.modelRoutesDigest,
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


def to_atif_turns(exports: list[ExecutionExport]) -> Trajectory:
    """Ordered native root turns remain attributable to their own authorized exports."""
    if not exports:
        raise UnsupportedMapping("No native conversation turns were exported")
    first = exports[0]
    if len(exports) > 1 and (
        not first.conversationId
        or any(item.conversationId != first.conversationId for item in exports)
    ):
        raise UnsupportedMapping("Native conversation identity is missing or changed")
    if len({item.rootTaskId for item in exports}) != len(exports):
        raise UnsupportedMapping("A native conversation root was repeated")
    for item in exports:
        if (
            item.organizationId,
            item.agentId,
            item.versionId,
            item.effectiveComposition.digest,
            item.modelRoutesDigest,
        ) != (
            first.organizationId,
            first.agentId,
            first.versionId,
            first.effectiveComposition.digest,
            first.modelRoutesDigest,
        ):
            raise UnsupportedMapping(
                "Conversation turns changed their pinned native scope"
            )
    trajectories = [
        to_atif(item).model_dump(mode="json", exclude_none=True) for item in exports
    ]
    if len(trajectories) == 1:
        return Trajectory.model_validate(trajectories[0])
    merged = {**trajectories[0], "extra": dict(trajectories[0].get("extra", {}))}
    merged["steps"] = []
    children = []
    turn_metadata = []
    for export, trajectory in zip(exports, trajectories, strict=True):
        for step in trajectory["steps"]:
            step["step_id"] = len(merged["steps"]) + 1
            step.setdefault("extra", {})["nativeRootTaskId"] = export.rootTaskId
            merged["steps"].append(step)
        children.extend(trajectory.get("subagent_trajectories", []))
        turn_metadata.append(
            {
                "rootTaskId": export.rootTaskId,
                "coverage": export.coverage.model_dump(mode="json"),
            }
        )
    if children:
        merged["subagent_trajectories"] = children
    merged.setdefault("extra", {})["nativeConversationTurns"] = turn_metadata
    merged["session_id"] = first.conversationId
    for child in children:
        child["extra"]["nativeRootTaskId"] = child["session_id"]
        child["session_id"] = first.conversationId
    aggregate = {}
    for key in first.coverage.model_dump():
        values = [getattr(item.coverage, key) for item in exports]
        statuses = {value.status for value in values}
        aggregate[key] = {
            "status": next(iter(statuses)) if len(statuses) == 1 else "partial",
            "omissions": list(
                dict.fromkeys(reason for value in values for reason in value.omissions)
            ),
        }
    merged["extra"]["coverage"] = aggregate
    merged["extra"]["nativeConversationId"] = first.conversationId
    merged["extra"]["nativeOutcome"] = next(
        task.state for task in exports[-1].tasks if task.id == exports[-1].rootTaskId
    )
    merged["extra"]["branches"] = [
        branch
        for trajectory in trajectories
        for branch in trajectory.get("extra", {}).get("branches", [])
    ]
    merged["extra"]["nativeEvidenceFile"] = "conversation-turns.json"
    return Trajectory.model_validate(merged)
