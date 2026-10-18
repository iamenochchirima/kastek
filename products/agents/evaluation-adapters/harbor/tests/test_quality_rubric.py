"""Negative calibration loads the exact container-side purpose grader."""

import importlib.util
from pathlib import Path
import unittest

rubric_path = Path(__file__).parents[1] / "suites/faq-paraphrase/tests/rubric.py"
spec = importlib.util.spec_from_file_location("opening_time_rubric", rubric_path)
rubric = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rubric)


class OpeningTimeCalibrationTests(unittest.TestCase):
    def test_rejects_wrong_opening_time_even_when_nine_appears_elsewhere(self):
        for answer in (
            "Harbor opens at eight and closes at nine.",
            "Harbor opens at 8:00. It closes at 9:00.",
            "Harbor does not open at nine.",
            "Harbor opens at 9:30.",
            "Harbor opens at nine. It opens at eight.",
            "Nine is mentioned, but no opening time is provided.",
        ):
            with self.subTest(answer=answer):
                self.assertFalse(rubric.states_approved_opening_time(answer))

    def test_accepts_bounded_valid_opening_time_forms(self):
        for answer in (
            "Harbor fixture opens at nine. [E123]",
            "Harbor opens at **9:00 AM**. [E123]",
            "The opening time is 09:00.",
            "Harbor is open from 9 AM.",
        ):
            with self.subTest(answer=answer):
                self.assertTrue(rubric.states_approved_opening_time(answer))
