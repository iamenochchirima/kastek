"""Validation for owner-read native record evidence. No model or evaluation runs."""

import re
from datetime import datetime
from uuid import UUID

STATUSES = {"new", "in_progress", "waiting_on_customer", "closed"}
FIELD_LIMITS = {"name": 200, "email": 320, "phone": 80, "service": 500, "message": 4000}


def validate_record(value, *, record_id=None, agent_id=None):
    if not isinstance(value, dict):
        raise ValueError("Missing native customer record")
    UUID(value["id"])
    if record_id and value["id"] != str(record_id):
        raise ValueError("Customer record identity changed")
    for key in ("agentId", "sourceEnquiryId", "sourceTaskId", "conversationId", "customerConversationId", "contactId", "assigneeAccountId"):
        if value.get(key) is not None:
            UUID(value[key])
    if agent_id and value.get("agentId") != str(agent_id):
        raise ValueError("Customer record escaped the prepared agent")
    if not isinstance(value.get("revision"), str) or not re.fullmatch(r"[1-9]\d{0,18}", value["revision"]):
        raise ValueError("Missing customer record revision")
    if value.get("status") not in STATUSES:
        raise ValueError("Unexpected follow-up status")
    fields = value.get("fields")
    if not isinstance(fields, dict) or any(
        key not in FIELD_LIMITS or not isinstance(item, str) or len(item) > FIELD_LIMITS[key]
        for key, item in fields.items()
    ):
        raise ValueError("Unexpected customer record fields")
    for key in ("createdAt", "updatedAt", "dueAt"):
        item = value.get(key)
        if item is None and key == "dueAt":
            continue
        if not isinstance(item, str) or len(item) > 40 or datetime.fromisoformat(item.replace("Z", "+00:00")).tzinfo is None:
            raise ValueError("Missing customer record timestamp")
    return value


def validate_record_command(command):
    if not isinstance(command, dict):
        raise ValueError("Expected an explicit record command")
    UUID(command["commandId"])
    if not isinstance(command.get("expectedRevision"), str) or not re.fullmatch(r"[1-9]\d{0,18}", command["expectedRevision"]):
        raise ValueError("Expected the exact record revision")
    actions = {"claim", "assign", "unassign", "set-status", "reopen", "set-due", "note", "correct", "link-contact"}
    if command.get("action") not in actions:
        raise ValueError("Unsupported record command")
    if len(str(command)) > 16384:
        raise ValueError("Record command exceeds the adapter bound")
    return command
