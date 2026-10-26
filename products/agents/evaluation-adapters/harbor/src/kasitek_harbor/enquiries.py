"""Native enquiry evidence validation. This module never submits an enquiry."""

import re
from datetime import datetime
from uuid import UUID

FIELD_LIMITS = {"name": 200, "email": 320, "phone": 80, "service": 200, "message": 4000}
STATES = {"pending", "approved", "rejected", "submitted", "expired"}


def validate_enquiries(result, *, agent_id=None, task_id=None, submitted_only=False):
    rows = result.get("enquiries") if isinstance(result, dict) else None
    if not isinstance(rows, list) or len(rows) > 240:
        raise ValueError("Missing bounded native enquiries")
    identities = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Invalid native enquiry")
        for key in ("id", "agentId", "taskId", "conversationId"):
            UUID(row[key])
        if row.get("amendsEnquiryId") is not None:
            UUID(row["amendsEnquiryId"])
        if row.get("customerConversationId") is not None:
            UUID(row["customerConversationId"])
        if row["id"] in identities:
            raise ValueError("Duplicate native enquiry identity")
        identities.add(row["id"])
        if agent_id and row["agentId"] != str(agent_id):
            raise ValueError("Enquiry escaped the prepared agent")
        if task_id and row["taskId"] != str(task_id):
            raise ValueError("Enquiry escaped the prepared task")
        if row.get("state") not in STATES or (
            submitted_only and row["state"] != "submitted"
        ):
            raise ValueError("Unexpected native enquiry state")
        if not re.fullmatch(r"[a-f0-9]{64}", row.get("requestDigest", "")):
            raise ValueError("Missing exact enquiry digest")
        fields = row.get("fields")
        if not isinstance(fields, dict) or not fields or any(
            key not in FIELD_LIMITS
            or not isinstance(value, str)
            or not value.strip()
            or len(value) > FIELD_LIMITS[key]
            for key, value in fields.items()
        ):
            raise ValueError("Unexpected native enquiry fields")
        for key in ("createdAt", "expiresAt"):
            value = row.get(key)
            if not isinstance(value, str) or len(value) > 40 or datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
                raise ValueError("Missing native enquiry timestamp")
        if row.get("submittedAt") is not None:
            value = row["submittedAt"]
            if not isinstance(value, str) or len(value) > 40 or datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
                raise ValueError("Invalid native submission timestamp")
        if row["state"] == "submitted" and not row.get("submittedAt"):
            raise ValueError("Submitted enquiry lacks a native timestamp")
    return rows
