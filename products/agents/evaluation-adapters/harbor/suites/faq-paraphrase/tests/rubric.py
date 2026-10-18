"""Closed-case opening-time predicate; this is not a general semantic judge."""

import re

_RELATION = re.compile(
    r"\b(?:opens?|is\s+open|opening\s+(?:time|hours)(?:\s+(?:is|are))?)"
    r"\s*(?::|at|from)?\s+(\d{1,2}(?::\d{2})?|[a-z]+)\b"
)
_NEGATION = re.compile(r"\b(?:not|never|cannot|can't|doesn't|isn't|aren't)\b")


def states_approved_opening_time(answer: str) -> bool:
    normalized = re.sub(r"[*_`]+", "", answer.lower())
    claims = []
    for sentence in re.split(r"(?<=[.!?])\s+|\n", normalized):
        for match in _RELATION.finditer(sentence):
            claims.append(
                match.group(1) in {"nine", "9", "9:00", "09:00"}
                and not _NEGATION.search(sentence)
            )
    return bool(claims) and all(claims)
