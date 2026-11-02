"""Calibration for transcript revision2, independent of frozen fact predicate."""

import copy
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).parents[1] / "suites/faq-paraphrase-v2/tests/transcript.py"
spec = importlib.util.spec_from_file_location("faq_transcript_v2", path)
grader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grader)


class TranscriptCalibrationTests(unittest.TestCase):
    def test_required_citation_rejects_missing_forged_and_wrong_labels(self):
        label = "E" + "a" * 32
        self.assertTrue(
            grader.has_required_citation("Opens at nine. [" + label + "]", label)
        )
        for answer, expected in [
            ("Opens at nine.", label),
            ("Opens at nine. [E" + "b" * 32 + "]", label),
            ("Opens at nine. [guessed]", "guessed"),
        ]:
            with self.subTest(answer=answer):
                self.assertFalse(grader.has_required_citation(answer, expected))

    def test_complete_call_receipt_projection_rejects_forged_or_dropped_history(
        self,
    ):
        # Minimal complete two-call projection isolates accounting without model calls.
        tool = {
            "id": "provider-id",
            "type": "function",
            "function": {"name": "knowledge_search", "arguments": "{}"},
        }
        first = {"role": "assistant", "content": None, "tool_calls": [tool]}
        final = {"role": "assistant", "content": "Answer"}
        messages = [
            first,
            {"role": "tool", "tool_call_id": "provider-id", "content": "receipt"},
        ]
        calls = [
            {
                "operationId": "model:root:0",
                "step": 0,
                "state": "completed",
                "inputMessages": [],
                "outputMessage": first,
                "toolResults": [
                    {
                        "toolCallId": "provider-id",
                        "operationId": "tool:root:0:0",
                        "name": "knowledge_search",
                        "state": "completed",
                        "content": "receipt",
                        "nativeOutput": {},
                        "observedByOperationId": "model:root:1",
                    }
                ],
            },
            {
                "operationId": "model:root:1",
                "step": 1,
                "state": "completed",
                "inputMessages": messages,
                "outputMessage": final,
                "toolResults": [],
            },
        ]
        root = {"id": "root", "output": "Answer", "modelCalls": calls}
        trajectory = {
            "steps": [
                {
                    "source": "agent",
                    "extra": {
                        "operationId": call["operationId"],
                        "inputMessages": call["inputMessages"],
                        "outputMessage": call["outputMessage"],
                    },
                    **(
                        {
                            "tool_calls": [
                                {"tool_call_id": "model:root:0:provider-id"}
                            ],
                            "observation": {
                                "results": [
                                    {
                                        "source_call_id": "model:root:0:provider-id",
                                        "content": "receipt",
                                    }
                                ]
                            },
                        }
                        if index == 0
                        else {}
                    ),
                }
                for index, call in enumerate(calls)
            ]
        }
        grader.assert_native_transcript(root, trajectory)
        for change in [
            "dropped-call",
            "missing-result",
            "wrong-content",
            "wrong-receipt",
            "wrong-final",
        ]:
            altered = copy.deepcopy(root)
            atif = copy.deepcopy(trajectory)
            if change == "dropped-call":
                atif["steps"].pop()
            elif change == "missing-result":
                altered["modelCalls"][0]["toolResults"] = []
            elif change == "wrong-content":
                altered["modelCalls"][1]["inputMessages"][1]["content"] = "forged"
            elif change == "wrong-receipt":
                altered["modelCalls"][0]["toolResults"][0]["operationId"] = "guessed"
            else:
                altered["output"] = "other"
            with self.subTest(change=change), self.assertRaises(AssertionError):
                grader.assert_native_transcript(altered, atif)
