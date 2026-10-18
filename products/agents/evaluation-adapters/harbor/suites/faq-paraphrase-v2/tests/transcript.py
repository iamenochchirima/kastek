"""Strict native/ATIF accounting; legitimate model tool rounds remain visible."""

import re


def has_required_citation(answer, label):
    return bool(re.fullmatch(r"E[0-9a-f]{32}", label)) and f"[{label}]" in answer


def assert_native_transcript(root, trajectory):
    calls = root["modelCalls"]
    assert calls and len({call["operationId"] for call in calls}) == len(calls)
    assert [call["step"] for call in calls] == sorted({call["step"] for call in calls})
    assert calls[-1]["outputMessage"]["content"] == root["output"]
    assert not calls[-1]["outputMessage"].get("tool_calls")
    steps = [step for step in trajectory["steps"] if step["source"] == "agent"]
    assert len(steps) == len(calls), "ATIF cannot drop model calls"
    assert not trajectory.get("subagent_trajectories")
    for call, step in zip(calls, steps, strict=True):
        assert (
            call["state"] == "completed"
            and call["outputMessage"]["role"] == "assistant"
        )
        assert call["operationId"] == f"model:{root['id']}:{call['step']}"
        assert step["extra"]["operationId"] == call["operationId"]
        assert step["extra"]["inputMessages"] == call["inputMessages"]
        assert step["extra"]["outputMessage"] == call["outputMessage"]
        tools = call["outputMessage"].get("tool_calls") or []
        assert len(call["toolResults"]) == len(tools)
        observations = (step.get("observation") or {}).get("results", [])
        assert len(observations) == len(tools)
        atif_tools = step.get("tool_calls", [])
        assert len(atif_tools) == len(tools)
        for index, (tool, result) in enumerate(
            zip(tools, call["toolResults"], strict=True)
        ):
            assert tool["function"]["name"] in {"knowledge_search", "knowledge_read"}
            assert result["toolCallId"] == tool["id"]
            assert result["operationId"] == f"tool:{root['id']}:{call['step']}:{index}"
            assert (
                result["name"] == tool["function"]["name"]
                and result["state"] == "completed"
            )
            assert result["content"] is not None and result["nativeOutput"] is not None
            observed = next(
                item
                for item in calls
                if item["operationId"] == result["observedByOperationId"]
            )
            assert observed["step"] > call["step"]
            assert any(
                message.get("role") == "tool"
                and message.get("tool_call_id") == tool["id"]
                and message.get("content") == result["content"]
                for message in observed["inputMessages"]
            )
            assert any(
                message.get("role") == "assistant"
                and message.get("tool_calls") == tools
                for message in observed["inputMessages"]
            )
            source = f"{call['operationId']}:{tool['id']}"
            assert atif_tools[index]["tool_call_id"] == source
            observation = next(
                item for item in observations if item["source_call_id"] == source
            )
            assert observation["content"] == result["content"]
