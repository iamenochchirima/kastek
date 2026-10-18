"""Citation-v3 calibration uses the same approved fact and required citation."""

import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).parents[1] / "suites/faq-paraphrase-v3/tests/transcript.py"
spec = importlib.util.spec_from_file_location("faq_transcript_v3", path)
grader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grader)


class CitationCalibrationTests(unittest.TestCase):
    def test_accepts_nonfirst_authorized_model_visible_reference_and_rejects_bad_scope(
        self,
    ):
        first, second = "E" + "a" * 32, "E" + "b" * 32
        references = [
            {"citation_label": label, "source_id": "source", "revision_id": "approved"}
            for label in [first, second]
        ]
        calls = [
            {
                "inputMessages": [
                    {"role": "user", "content": "Provided [" + first + "]"},
                    {"role": "tool", "content": "Provided [" + second + "]"},
                ]
            }
        ]
        answer = "Harbor opens at nine. [" + second + "]"
        allowed = {("source", "approved")}
        self.assertTrue(
            grader.has_authorized_citations(answer, references, calls, allowed)
        )
        for reason, output, refs, messages, pairs in [
            ("missing", "Harbor opens at nine.", references, calls, allowed),
            ("unknown", answer + " [E" + "c" * 32 + "]", references, calls, allowed),
            ("wrong-revision", answer, references, calls, {("source", "other")}),
            (
                "other-scope",
                answer,
                references,
                calls,
                {("another-source", "approved")},
            ),
            ("withdrawn-unavailable", answer, [], calls, allowed),
            (
                "unprovided",
                answer,
                references,
                [{"inputMessages": [{"role": "assistant", "content": answer}]}],
                allowed,
            ),
            ("invalid-label", answer + " [guessed]", references, calls, allowed),
        ]:
            with self.subTest(reason=reason):
                self.assertFalse(
                    grader.has_authorized_citations(output, refs, messages, pairs)
                )
