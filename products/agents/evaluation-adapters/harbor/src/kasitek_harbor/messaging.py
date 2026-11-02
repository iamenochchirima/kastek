"""Owner-scoped native messaging fixtures. No provider credentials or provider HTTP."""

import asyncio
import hashlib
from datetime import datetime, timezone
from uuid import UUID
from .persistence import persist
from .channel import channel_history


def native_payload(kind, asset_id, request_key, text, occurred_at):
    identity = str(int(hashlib.sha256(request_key.encode()).hexdigest()[:10], 16))
    sender = "700000000001"
    if kind == "telegram":
        return {
            "update_id": int(identity),
            "message": {
                "message_id": int(identity),
                "date": occurred_at,
                "chat": {"id": int(sender), "type": "private"},
                "from": {"id": int(sender), "is_bot": False},
                "text": text,
            },
        }
    if kind == "whatsapp":
        return {
            "object": "whatsapp_business_account",
            "entry": [
                {
                    "id": asset_id,
                    "changes": [
                        {
                            "field": "messages",
                            "value": {
                                "messaging_product": "whatsapp",
                                "metadata": {"phone_number_id": asset_id},
                                "messages": [
                                    {
                                        "id": "fixture-" + identity,
                                        "from": sender,
                                        "timestamp": str(occurred_at),
                                        "type": "text",
                                        "text": {"body": text},
                                    }
                                ],
                            },
                        }
                    ],
                }
            ],
        }
    return {
        "object": "page" if kind == "facebook" else "instagram",
        "entry": [
            {
                "id": asset_id,
                "messaging": [
                    {
                        "sender": {"id": sender},
                        "recipient": {"id": asset_id},
                        "timestamp": occurred_at * 1000,
                        "message": {"mid": "fixture-" + identity, "text": text},
                    }
                ],
            }
        ],
    }


async def prepare_messaging(client, options, trial_id):
    result = await client.request(
        "POST",
        f"{client.organization_path}/evaluation-trials/{trial_id}/channel-fixture",
        options.model_dump(),
    )
    for field in ("connectionId", "deploymentId"):
        UUID(result[field])
    if (
        result.get("trialId") != trial_id
        or result.get("kind") != options.kind
        or result.get("mode") != options.mode
    ):
        raise ValueError("Native fixture changed the prepared channel scope")
    if not isinstance(result.get("assetId"), str) or not result["assetId"].isdigit():
        raise ValueError("Missing native synthetic asset identity")
    return result


async def submit_messaging_turn(
    client, fixture, mapping, turn, path, *, timeout, poll_interval
):
    trial_id = mapping["nativeTrialId"]
    expected = turn["request"]["input"].strip()
    request_key = turn["request"]["requestKey"]
    if "channelPayload" not in turn:
        turn["channelPayload"] = native_payload(
            fixture["kind"],
            fixture["assetId"],
            request_key,
            expected,
            int(datetime.now(timezone.utc).timestamp()),
        )
        persist(path, mapping)
    # Persisted envelope is reused after a lost response. Native deduplication owns event identity.
    result = await client.request(
        "POST",
        f"{client.organization_path}/evaluation-trials/{trial_id}/channel-fixture/ingress",
        {"payload": turn["channelPayload"]},
    )
    if (
        result.get("trialId") != trial_id
        or result.get("connectionId") != fixture["connectionId"]
    ):
        raise ValueError("Fixture ingress escaped its exact trial")
    events = result.get("eventIds")
    if not isinstance(events, list) or len(events) != 1:
        raise ValueError("Expected exactly one native fixture event")
    if turn.get("channelEventIds") not in (None, events):
        raise ValueError("Recovered fixture changed event identity")
    turn["channelEventIds"] = events
    persist(path, mapping)
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        history = await channel_history(client, trial_id)
        receipt = next(
            (
                item
                for item in history.get("ingress", [])
                if item.get("event_id") == events[0]
            ),
            None,
        )
        if receipt and receipt.get("state") == "quarantined":
            raise ValueError("Native fixture ingress was quarantined")
        conversation = history.get("conversation")
        message = next(
            (
                item
                for item in history["messages"]
                if receipt and item["id"] == receipt.get("message_id")
            ),
            None,
        )
        if conversation and message:
            if message.get("body") != expected:
                raise ValueError(
                    "Canonical channel message differs from the scripted request"
                )
            conversation_id = conversation["id"]
            if mapping.get("channelConversationId") not in (None, conversation_id):
                raise ValueError("Recovered fixture changed conversation")
            task_id = message.get("taskId", message.get("task_id"))
            if task_id:
                if task_id not in history["rootTaskIds"]:
                    raise ValueError("Channel message is outside the exact trial roots")
                task = await client.status(task_id)
                binding = task.get("channelBinding", {})
                if (
                    task.get("requestKey") != "channel:" + message["id"]
                    or task.get("input") != expected
                    or binding.get("customerConversationId") != conversation_id
                    or binding.get("inputMessageId") != message["id"]
                ):
                    raise ValueError(
                        "Native root binding differs from its canonical channel message"
                    )
                if turn.get("taskId") not in (None, task_id):
                    raise ValueError("Recovered fixture changed task identity")
                mapping["channelConversationId"] = conversation_id
                turn["messageId"] = message["id"]
                persist(path, mapping)
                return task
            if conversation.get("state") in ("human_owned", "resolved"):
                raise ValueError(
                    "Scripted customer turn did not admit a model root because staff owns the conversation"
                )
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError(
                "Native channel ingress did not reach an admitted root before its bound"
            )
        await asyncio.sleep(poll_interval)


async def settled_messaging_history(
    client, trial_id, *, poll_interval, require_delivery
):
    # The caller's original asyncio.timeout bounds this wait; it does not reset the trial deadline.
    while True:
        history = await channel_history(client, trial_id)
        deliveries = history["deliveries"]
        if (deliveries or not require_delivery) and all(
            item.get("state") not in {"pending", "sending"} for item in deliveries
        ):
            return history
        await asyncio.sleep(poll_interval)
