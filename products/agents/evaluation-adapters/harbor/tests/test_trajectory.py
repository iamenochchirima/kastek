import copy
import json
import unittest

from pydantic import ValidationError
from harbor.models.trajectories.trajectory import Trajectory

from kasitek_harbor.native import ExecutionExport
from kasitek_harbor.trajectory import UnsupportedMapping, to_atif
from fixtures import native_export


class ConversionTests(unittest.TestCase):
    def test_validates_with_actual_installed_harbor_without_inventing_authorship_or_usage(
        self,
    ):
        raw = native_export()
        result = to_atif(ExecutionExport.model_validate(raw))
        Trajectory.model_validate_json(result.model_dump_json())
        self.assertEqual([s.source for s in result.steps], ["user", "agent", "agent"])
        self.assertEqual(
            result.steps[1].observation.results[0].content, "UNTRUSTED_SOURCE_TEXT"
        )
        self.assertEqual(
            result.steps[1].observation.results[0].source_call_id,
            "model:root:0:provider-call",
        )
        self.assertNotIn(
            "UNTRUSTED_COMPACTED_CONTEXT", [s.message for s in result.steps]
        )
        self.assertEqual(
            result.steps[2].extra["inputMessages"],
            raw["tasks"][0]["modelCalls"][1]["inputMessages"],
        )
        self.assertIsNone(result.steps[2].metrics)
        self.assertTrue(all(step.reasoning_content is None for step in result.steps))

    def test_preserves_native_subagent_branches_and_exact_operation_join(self):
        raw = native_export(True)
        result = to_atif(ExecutionExport.model_validate(raw))
        self.assertEqual(len(result.subagent_trajectories), 1)
        child = result.subagent_trajectories[0]
        self.assertEqual(child.trajectory_id, raw["tasks"][1]["id"])
        self.assertEqual(child.steps[0].message, "Child brief")
        self.assertNotIn("Child answer", [s.message for s in result.steps])
        self.assertEqual(
            result.steps[1]
            .observation.results[0]
            .subagent_trajectory_ref[0]
            .trajectory_id,
            child.trajectory_id,
        )
        self.assertEqual(
            Trajectory.model_validate_json(result.model_dump_json()).model_dump(),
            result.model_dump(),
        )

    def test_rejects_unknown_schema_missing_results_false_coverage_and_forged_child_link(
        self,
    ):
        original = native_export(True)
        broken = []
        value = copy.deepcopy(original)
        value["schemaVersion"] = "execution-export.v2"
        broken.append(value)
        value = copy.deepcopy(original)
        value["tasks"][0]["modelCalls"][0]["toolResults"] = []
        broken.append(value)
        value = copy.deepcopy(original)
        value["tasks"][1]["parentOperationId"] = "guessed"
        broken.append(value)
        value = copy.deepcopy(original)
        value["tasks"][0]["modelCalls"][0]["outputMessage"] = None
        broken.append(value)
        for value in broken:
            with (
                self.subTest(value=value["schemaVersion"]),
                self.assertRaises(ValidationError),
            ):
                ExecutionExport.model_validate(value)

    def test_refuses_non_object_arguments_instead_of_silently_omitting_a_tool(self):
        raw = native_export()
        raw["tasks"][0]["modelCalls"][0]["outputMessage"]["tool_calls"][0]["function"][
            "arguments"
        ] = "[]"
        with self.assertRaises(UnsupportedMapping):
            to_atif(ExecutionExport.model_validate(raw))

    def test_partial_response_retained_without_fabricating_an_agent_step(self):
        raw = native_export()
        raw["coverage"]["modelOutputs"] = {
            "status": "partial",
            "omissions": ["MODEL_OUTCOME_UNCERTAIN"],
        }
        raw["coverage"]["toolResults"] = {
            "status": "unavailable",
            "omissions": ["NO_RECORDED_OUTPUT"],
        }
        raw["tasks"][0]["modelCalls"] = [raw["tasks"][0]["modelCalls"][0]]
        raw["tasks"][0]["modelCalls"][0].update(
            outputMessage=None, toolResults=[], state="uncertain"
        )
        raw["tasks"][0]["state"] = "uncertain"
        result = to_atif(ExecutionExport.model_validate(raw))
        self.assertEqual(len(result.steps), 1)
        self.assertEqual(result.extra["nativeOutcome"], "uncertain")
        self.assertEqual(len(result.extra["unansweredModelAttempts"]), 1)
        self.assertIn("partial", json.dumps(result.extra["coverage"]))
