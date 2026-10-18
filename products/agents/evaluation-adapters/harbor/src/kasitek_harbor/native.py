"""Versioned, provider-neutral authorized execution export contract."""

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator


class NativeRecord(BaseModel):
    # Preserve additional native metadata in the retained export and ATIF extras.
    model_config = ConfigDict(extra="allow", strict=True)


class CoveragePart(NativeRecord):
    status: Literal["complete", "partial", "unavailable"]
    omissions: list[str]


class Coverage(NativeRecord):
    modelInputs: CoveragePart
    modelOutputs: CoveragePart
    toolCalls: CoveragePart
    toolResults: CoveragePart
    children: CoveragePart
    artifacts: CoveragePart
    observations: CoveragePart
    effects: CoveragePart


class Composition(NativeRecord):
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    programId: str
    programVersion: str
    runtime: str
    capabilities: list[JsonValue]
    workflows: list[JsonValue]


class NativeFunction(NativeRecord):
    name: str = Field(min_length=1, max_length=256)
    arguments: str


class NativeToolCall(NativeRecord):
    id: str = Field(min_length=1, max_length=256)
    type: Literal["function"]
    function: NativeFunction


class NativeMessage(NativeRecord):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | None
    tool_calls: list[NativeToolCall] | None = None
    tool_call_id: str | None = None


class Usage(NativeRecord):
    inputTokens: int | None = Field(ge=0)
    outputTokens: int | None = Field(ge=0)
    totalTokens: int | None = Field(ge=0)


class ToolResult(NativeRecord):
    toolCallId: str
    operationId: str
    name: str
    state: str
    content: str | None
    childTaskIds: list[str] = Field(default_factory=list)


class ModelCall(NativeRecord):
    operationId: str
    step: int = Field(ge=0)
    model: str
    state: str
    inputMessages: list[NativeMessage]
    outputMessage: NativeMessage | None
    toolDefinitions: list[dict[str, Any]]
    usage: Usage | None
    toolResults: list[ToolResult]


class NativeTask(NativeRecord):
    agentId: str | None = None
    versionId: str | None = None
    effectiveComposition: dict[str, JsonValue] | None = None
    id: str
    parentTaskId: str | None
    parentOperationId: str | None
    state: str
    input: str | None
    output: str | None
    modelCalls: list[ModelCall]


class NativeArtifact(NativeRecord):
    id: str
    taskId: str
    name: str
    bytes: int = Field(ge=0)
    downloadPath: str | None
    contentDigest: str | None


class ExecutionExport(NativeRecord):
    conversationId: str | None = None
    schemaVersion: Literal["execution-export.v1"]
    rootTaskId: str
    organizationId: str
    agentId: str
    versionId: str
    effectiveComposition: Composition
    tasks: list[NativeTask] = Field(min_length=1, max_length=128)
    coverage: Coverage
    artifacts: list[NativeArtifact]
    observations: list[dict[str, JsonValue]]
    effectReceipts: list[dict[str, JsonValue]]

    @model_validator(mode="after")
    def native_integrity(self):
        for value in (
            self.rootTaskId,
            self.organizationId,
            self.agentId,
            self.versionId,
        ):
            UUID(value)
        if self.conversationId is not None:
            UUID(self.conversationId)
        tasks = {task.id: task for task in self.tasks}
        if len(tasks) != len(self.tasks) or self.rootTaskId not in tasks:
            raise ValueError("Native task identities are missing or duplicated")
        if tasks[self.rootTaskId].parentTaskId is not None:
            raise ValueError("Root export must start at a root task")
        for task in self.tasks:
            UUID(task.id)
            if task.agentId is not None:
                UUID(task.agentId)
            if task.versionId is not None:
                UUID(task.versionId)
            if task.id != self.rootTaskId and (
                task.parentTaskId not in tasks or not task.parentOperationId
            ):
                raise ValueError(
                    "Every child requires an exported parent and native delegation operation"
                )
            seen = {task.id}
            parent = task.parentTaskId
            while parent:
                if parent in seen or parent not in tasks:
                    raise ValueError(
                        "Native branches contain a cycle or missing parent"
                    )
                seen.add(parent)
                parent = tasks[parent].parentTaskId
            operation_ids = set()
            steps = set()
            for call in task.modelCalls:
                if call.operationId in operation_ids or call.step in steps:
                    raise ValueError("Native model operations or steps are duplicated")
                operation_ids.add(call.operationId)
                steps.add(call.step)
                if call.outputMessage and call.outputMessage.role != "assistant":
                    raise ValueError("A model response must have assistant authorship")
                tools = (
                    call.outputMessage.tool_calls or [] if call.outputMessage else []
                )
                tool_ids = [tool.id for tool in tools]
                if len(set(tool_ids)) != len(tool_ids):
                    raise ValueError(
                        "Provider tool call identity is ambiguous within one response"
                    )
                results = [result.toolCallId for result in call.toolResults]
                if len(set(results)) != len(results) or any(
                    value not in tool_ids for value in results
                ):
                    raise ValueError(
                        "Tool results require an unambiguous call in the same native model operation"
                    )
                if self.coverage.toolResults.status == "complete" and set(
                    results
                ) != set(tool_ids):
                    raise ValueError(
                        "Complete tool coverage is missing a native result"
                    )
                if (
                    self.coverage.modelOutputs.status == "complete"
                    and call.outputMessage is None
                ):
                    raise ValueError(
                        "Complete model-output coverage is missing a response"
                    )
                if self.coverage.toolResults.status == "complete" and any(
                    result.content is None for result in call.toolResults
                ):
                    raise ValueError(
                        "Complete tool coverage requires an actual model observation"
                    )
                for result in call.toolResults:
                    for child_id in result.childTaskIds:
                        child = tasks.get(child_id)
                        if (
                            not child
                            or child.parentTaskId != task.id
                            or child.parentOperationId != result.operationId
                        ):
                            raise ValueError(
                                "Subagent result linkage contradicts the native delegation operation"
                            )
        if any(artifact.taskId not in tasks for artifact in self.artifacts):
            raise ValueError("Artifact belongs to a task outside this export")
        return self
