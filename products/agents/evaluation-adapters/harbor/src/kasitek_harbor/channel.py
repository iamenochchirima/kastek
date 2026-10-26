"""Website visitor transport; operator cookies never cross into visitor requests."""

import json
import re
from uuid import UUID
import httpx
from .client import PlatformRequestError
from .enquiries import validate_enquiries
from .persistence import persist


class VisitorClient:
    def __init__(self, scope, channel, token, *, timeout, transport=None):
        self.path = f"/api/website/{channel.deployment_id}/customer-conversations"
        self.http = httpx.AsyncClient(
            base_url=scope.origin,
            timeout=timeout,
            follow_redirects=False,
            trust_env=False,
            headers={"origin": channel.origin, "authorization": "Bearer " + token},
            transport=transport,
        )

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.http.aclose()

    async def _request(self, method, path, body=None):
        conversation = re.escape(self.path) + r"/[0-9a-fA-F-]{36}"
        permitted = (
            method == "POST"
            and (
                path == self.path
                or re.fullmatch(conversation + r"/messages", path)
                or re.fullmatch(
                    conversation
                    + r"/(?:bookings|tool-reviews|enquiries)/[0-9a-fA-F-]{36}/decision",
                    path,
                )
            )
        ) or (
            method == "GET"
            and re.fullmatch(conversation + r"/(?:bookings|tool-reviews|enquiries)", path)
        )
        if not permitted:
            raise ValueError("Visitor request escaped its prepared website publication")
        for attempt in range(2):
            try:
                kwargs = {"json": body} if method == "POST" else {}
                async with self.http.stream(method, path, **kwargs) as response:
                    if not response.is_success:
                        raise PlatformRequestError(response.status_code)
                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        content.extend(chunk)
                        if len(content) > 131072:
                            raise ValueError(
                                "Visitor response exceeds the transport bound"
                            )
                    return json.loads(content)
            except httpx.TransportError:
                if attempt:
                    raise

    async def post(self, path, body):
        return await self._request("POST", path, body)

    async def _confirmations(self, conversation_id, kind, key):
        UUID(conversation_id)
        result = await self._request("GET", f"{self.path}/{conversation_id}/{kind}")
        items = result.get(key) if isinstance(result, dict) else None
        if not isinstance(items, list) or len(items) > 240:
            raise ValueError("Missing bounded customer confirmations")
        for item in items:
            if not isinstance(item, dict):
                raise ValueError("Invalid customer confirmation")
            UUID(item["id"])
            if not re.fullmatch(r"[a-f0-9]{64}", item.get("requestDigest", "")):
                raise ValueError("Missing exact customer confirmation digest")
        return items

    async def bookings(self, conversation_id):
        return await self._confirmations(conversation_id, "bookings", "bookings")

    async def tool_reviews(self, conversation_id):
        return await self._confirmations(conversation_id, "tool-reviews", "reviews")

    async def enquiries(self, conversation_id):
        UUID(conversation_id)
        result = await self._request("GET", f"{self.path}/{conversation_id}/enquiries")
        rows = validate_enquiries(result)
        if any(row.get("customerConversationId") != conversation_id for row in rows):
            raise ValueError("Enquiry escaped the prepared visitor conversation")
        return rows

    async def decide_enquiry(self, conversation_id, enquiry_id, decision, request_digest):
        result = await self._decide(
            conversation_id, "enquiries", enquiry_id, decision, request_digest
        )
        rows = validate_enquiries({"enquiries": [result.get("enquiry")]})
        if (
            rows[0]["id"] != enquiry_id
            or rows[0].get("customerConversationId") != conversation_id
            or rows[0]["requestDigest"] != request_digest
            or rows[0]["state"] not in ({"approved", "submitted"} if decision == "approve" else {"rejected"})
        ):
            raise ValueError("Enquiry decision changed its exact customer request")
        return rows[0]

    async def _decide(self, conversation_id, kind, identity, decision, request_digest):
        UUID(conversation_id)
        UUID(identity)
        if decision not in {"approve", "reject"} or not re.fullmatch(
            r"[a-f0-9]{64}", request_digest
        ):
            raise ValueError("Expected an explicit decision and exact request digest")
        return await self.post(
            f"{self.path}/{conversation_id}/{kind}/{identity}/decision",
            {"decision": decision, "requestDigest": request_digest},
        )

    async def decide_booking(
        self, conversation_id, booking_id, decision, request_digest
    ):
        return await self._decide(
            conversation_id, "bookings", booking_id, decision, request_digest
        )

    async def decide_tool_review(
        self, conversation_id, review_id, decision, request_digest
    ):
        return await self._decide(
            conversation_id, "tool-reviews", review_id, decision, request_digest
        )

    async def open(self):
        result = await self.post(self.path, {})
        UUID(result["conversation"]["id"])
        return result["conversation"]["id"]

    async def ingress(self, conversation_id, request):
        UUID(conversation_id)
        result = await self.post(f"{self.path}/{conversation_id}/messages", request)
        if result["conversation"]["id"] != conversation_id:
            raise ValueError("Visitor response changed its prepared conversation")
        UUID(result["message"]["id"])
        return result["message"]


async def channel_history(client, native_trial_id):
    result = await client.request(
        "GET",
        f"{client.organization_path}/evaluation-trials/{native_trial_id}/channel-history",
    )
    if not isinstance(result, dict) or any(
        not isinstance(result.get(key), list)
        for key in ("messages", "commands", "deliveries", "rootTaskIds")
    ):
        raise ValueError("Missing authoritative native channel history")
    if result["conversation"] is not None:
        UUID(result["conversation"]["id"])
    return result


async def prepare_channel(client, channel, native_trial_id):
    for attempt in range(2):
        try:
            result = await client.request(
                "POST",
                f"{client.organization_path}/evaluation-trials/{native_trial_id}/channel-session",
                {"deploymentId": str(channel.deployment_id), "origin": channel.origin},
            )
            break
        except httpx.TransportError:
            if attempt:
                raise
    if (
        result.get("trialId") != native_trial_id
        or result.get("deploymentId") != str(channel.deployment_id)
        or result.get("origin") != channel.origin
    ):
        raise ValueError("Native channel differs from the prepared operator scope")
    token = result.get("token")
    if (
        not isinstance(token, str)
        or not 16 <= len(token) <= 4096
        or any(
            character
            not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
            for character in token
        )
    ):
        raise ValueError("Missing bounded native visitor credential")
    return token


async def submit_channel_turn(client, visitor, mapping, turn, path):
    history = await channel_history(client, mapping["nativeTrialId"])
    conversation = history["conversation"]
    if (
        mapping.get("channelConversationId")
        and conversation
        and mapping["channelConversationId"] != conversation["id"]
    ):
        raise ValueError("Recovered channel changed its conversation")
    if not mapping.get("channelConversationId"):
        mapping["channelConversationId"] = (
            conversation["id"] if conversation else await visitor.open()
        )
        persist(path, mapping)
    conversation_id = mapping["channelConversationId"]
    request = {
        "requestKey": turn["request"]["requestKey"],
        "body": turn["request"]["input"].strip(),
    }
    if turn.get("channelRequest") not in (None, request):
        raise ValueError("Recovered visitor request changed")
    turn["channelRequest"] = request
    persist(path, mapping)
    matches = [
        message
        for message in history["messages"]
        if message.get("request_key") == "visitor:" + request["requestKey"]
        and message.get("author_kind") == "visitor"
    ]
    if len(matches) > 1:
        raise ValueError("Native visitor request identity is not unique")
    if matches:
        message_id = matches[0]["id"]
    else:
        message = await visitor.ingress(conversation_id, request)
        message_id = message["id"]
    if turn.get("messageId") and turn["messageId"] != message_id:
        raise ValueError("Visitor request mapped to another native message")
    turn["messageId"] = message_id
    persist(path, mapping)
    # Public visitor DTOs intentionally omit task IDs. Only the normal operator's
    # exact trial history establishes which native root owns this message.
    history = await channel_history(client, mapping["nativeTrialId"])
    source = next(
        (message for message in history["messages"] if message["id"] == message_id),
        None,
    )
    if not source or not source.get("task_id"):
        raise ValueError("Visitor message has no supported native execution root")
    task = await client.status(source["task_id"])
    if task["id"] not in history["rootTaskIds"]:
        raise ValueError("Native task is outside the prepared trial roots")
    if task.get("requestKey") != f"channel:{message_id}":
        raise ValueError(
            "Native task request identity differs from its visitor message"
        )
    if task.get("input") != request["body"]:
        raise ValueError("Native task input differs from its visitor message")
    binding = task.get("channelBinding")
    if (
        not isinstance(binding, dict)
        or binding.get("customerConversationId") != conversation_id
        or binding.get("inputMessageId") != message_id
    ):
        raise ValueError("Native task channel binding differs from its message")
    if turn.get("taskId") and turn["taskId"] != task["id"]:
        raise ValueError("Visitor message changed its native task")
    return task
