"""Growth product HTTP only. No standalone identity or database access."""

import json
import re
from datetime import datetime
from urllib.parse import quote
from uuid import UUID

import httpx


TERMINAL_STATES = frozenset(
    {"completed", "incomplete", "failed", "cancelled", "uncertain", "refused"}
)
KNOWN_STATES = TERMINAL_STATES | {
    "accepted",
    "queued",
    "working",
    "waiting_review",
    "waiting_authority",
    "cancel_requested",
}


def product_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", value):
        raise ValueError("Invalid product record identifier")
    return quote(value, safe="")


def execution_id(value):
    return str(UUID(value))


class GrowthRequestError(RuntimeError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"Growth request rejected (HTTP {status})")


class GrowthClient:
    def __init__(self, scope, session, *, timeout=10, transport=None):
        if not re.fullmatch(r"[A-Za-z0-9_.=\-]{16,4096}", session):
            raise ValueError("Expected a bounded Growth session cookie")
        self.scope = scope
        # Explicit headers keep a response cookie from silently changing the business.
        self.http = httpx.AsyncClient(
            base_url=scope.origin,
            timeout=httpx.Timeout(timeout),
            headers={
                "origin": scope.origin,
                "cookie": f"kasitek_session={session}; kasitek_active_org={product_id(scope.business_id)}",
            },
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        )

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.http.aclose()

    async def request(
        self, method, path, body=None, *, params=None, max_bytes=2_097_152
    ):
        if not path.startswith(("/api/agents/", "/api/social/posts/")) or any(
            part in path for part in ("?", "#", "\\", "..", "//", "%")
        ):
            raise ValueError("Request is outside the Growth evaluation interfaces")
        async with self.http.stream(method, path, json=body, params=params) as response:
            if not response.is_success:
                # Do not echo response bodies or authentication headers into evidence.
                raise GrowthRequestError(response.status_code)
            content = bytearray()
            async for chunk in response.aiter_bytes():
                content.extend(chunk)
                if len(content) > max_bytes:
                    raise ValueError("Growth response exceeds the evidence bound")
        value = json.loads(content)
        if not isinstance(value, dict):
            raise ValueError("Expected a Growth product response")
        return value

    async def bootstrap(self):
        value = await self.request("GET", "/api/agents/bootstrap")
        scope = value.get("scope", {})
        if (
            scope.get("businessId") != self.scope.business_id
            or scope.get("userId") != self.scope.user_id
        ):
            raise ValueError("Growth session does not match the prepared business/user")
        matches = [
            item
            for item in value.get("features", [])
            if item.get("id") == self.scope.feature_id
        ]
        if len(matches) != 1 or matches[0].get("ready") is not True:
            raise ValueError("The prepared Growth feature is unavailable")
        return value

    async def unused(self):
        conversations = await self.request(
            "GET", "/api/agents/conversations", params={"limit": 1}
        )
        tasks = await self.request("GET", "/api/agents/tasks", params={"limit": 1})
        if (
            conversations.get("conversations") != []
            or tasks.get("tasks") != []
            or conversations.get("nextCursor")
            or tasks.get("nextCursor")
        ):
            raise ValueError(
                "A new trial needs a fresh prepared Growth business/user scope"
            )

    def task(self, value, conversation_id, task_id=None):
        if not isinstance(value, dict):
            raise ValueError("Missing Growth task")
        execution_id(value.get("id"))
        if (
            value.get("conversationId") != conversation_id
            or value.get("featureId") != self.scope.feature_id
            or value.get("state") not in KNOWN_STATES
            or task_id
            and value.get("id") != task_id
        ):
            raise ValueError("Growth task escaped the prepared conversation or feature")
        return value

    async def conversation(self, request):
        value = (await self.request("POST", "/api/agents/conversations", request)).get(
            "conversation", {}
        )
        execution_id(value.get("id"))
        if value.get("featureId") != self.scope.feature_id or value.get(
            "context"
        ) != request.get("context"):
            raise ValueError("Growth conversation changed the prepared feature/context")
        return value

    async def submit(self, conversation_id, request):
        path = f"/api/agents/conversations/{execution_id(conversation_id)}/messages"
        value = await self.request("POST", path, request)
        return self.task(value.get("task"), conversation_id)

    async def status(self, conversation_id, task_id):
        value = await self.request("GET", f"/api/agents/tasks/{execution_id(task_id)}")
        return self.task(value.get("task"), conversation_id, task_id)

    async def tasks(self, conversation_id):
        value = await self.request(
            "GET",
            "/api/agents/tasks",
            params={"conversationId": execution_id(conversation_id), "limit": 100},
        )
        tasks = value.get("tasks")
        if not isinstance(tasks, list) or len(tasks) > 8 or value.get("nextCursor"):
            raise ValueError(
                "Trial conversation exceeded the bounded scripted task set"
            )
        return [self.task(item, conversation_id) for item in tasks]

    async def cancel(self, conversation_id, task_id, request_id):
        value = await self.request(
            "POST",
            f"/api/agents/tasks/{execution_id(task_id)}/cancel",
            {"requestId": request_id},
        )
        return self.task(value.get("task"), conversation_id, task_id)

    async def events(self, task_id, cursor=None):
        return await self.request(
            "GET",
            f"/api/agents/tasks/{execution_id(task_id)}/events",
            params={"limit": 100, **({"cursor": cursor} if cursor else {})},
        )

    async def reviews(self, conversation_id, task_id):
        value = await self.request(
            "GET", f"/api/agents/tasks/{execution_id(task_id)}/reviews"
        )
        reviews = value.get("reviews")
        if not isinstance(reviews, list) or len(reviews) > 100:
            raise ValueError("Invalid Growth review list")
        for review in reviews:
            execution_id(review.get("id"))
            if (
                review.get("taskId") != task_id
                or review.get("conversationId") != conversation_id
                or review.get("featureId") != self.scope.feature_id
                or not re.fullmatch(r"[a-f0-9]{64}", review.get("payloadDigest", ""))
            ):
                raise ValueError("Growth review escaped the accepted task")
        return reviews

    async def decide(self, conversation_id, task_id, review, decision, request_id):
        current = [
            item
            for item in await self.reviews(conversation_id, task_id)
            if item["id"] == review.get("id")
            and item["payloadDigest"] == review.get("payloadDigest")
            and item.get("draft") == review.get("draft")
        ]
        if decision not in {"approve", "reject"} or len(current) != 1:
            raise ValueError("Only an exact current Growth review may be decided")
        if decision == "approve":
            destinations = (
                await self.request("GET", "/api/agents/draft-destinations")
            ).get("destinations", [])
            available = {
                (row.get("platform"), row.get("id"))
                for row in destinations
                if row.get("ready") is True
            }
            draft = review.get("draft", {})
            if not draft.get("channels") or any(
                (platform, draft.get("channelSelections", {}).get(platform))
                not in available
                for platform in draft["channels"]
            ):
                raise ValueError(
                    "Review needs prepared connected destinations before approval"
                )
        return await self.request(
            "POST",
            f"/api/agents/tasks/{execution_id(task_id)}/reviews/{execution_id(review['id'])}/decision",
            {
                "requestId": request_id,
                "payloadDigest": review["payloadDigest"],
                "decision": decision,
            },
        )

    async def artifacts(self, task_id):
        value = await self.request(
            "GET", f"/api/agents/tasks/{execution_id(task_id)}/artifacts"
        )
        artifacts = value.get("artifacts")
        if not isinstance(artifacts, list) or len(artifacts) > 100:
            raise ValueError("Invalid product artifact list")
        return artifacts  # References only; never invent a missing native export or signed download.

    async def saved_outcome(self, conversation_id, task_id, review):
        if review not in await self.reviews(conversation_id, task_id):
            raise ValueError("Saved review is no longer current")
        result = review.get("result")
        if not result:
            return None
        if (
            review.get("state") != "saved"
            or result.get("state") != "saved"
            or result.get("reviewId") != review["id"]
            or result.get("payloadDigest") != review["payloadDigest"]
            or result.get("actorId") != self.scope.user_id
        ):
            raise ValueError("Saved result is not an attributable Growth receipt")
        await self.bootstrap()
        post = (
            await self.request(
                "GET", "/api/social/posts/" + product_id(result.get("recordId"))
            )
        ).get("post", {})
        draft = review.get("draft", {})
        metadata = post.get("metadata", {})
        jobs = post.get("publishJobs", [])
        selected = {
            (job.get("platform"), job.get("channel_connection_id")) for job in jobs
        }
        if (
            post.get("id") != result["recordId"]
            or post.get("user_id") != self.scope.user_id
            or post.get("status") != "DRAFT"
            or post.get("title") != draft.get("title", "").strip()
            or post.get("content") != draft.get("content", "").strip()
            or post.get("channels") != draft.get("channels")
            or post.get("published_at")
            or post.get("scheduled_for")
            or metadata.get("growthAgentReviewId") != review["id"]
            or metadata.get("growthAgentPayloadDigest") != review["payloadDigest"]
            or metadata.get("growthAgentTaskId") != task_id
            or any(
                (platform, draft.get("channelSelections", {}).get(platform))
                not in selected
                for platform in draft.get("channels", [])
            )
        ):
            raise ValueError(
                "Normal Growth record contradicts the saved review receipt"
            )
        current_revision = datetime.fromisoformat(
            post.get("updated_at", "").replace("Z", "+00:00")
        )
        receipt_revision = datetime.fromisoformat(
            result.get("revision", "").replace("Z", "+00:00")
        )
        if (
            current_revision.tzinfo is None
            or receipt_revision.tzinfo is None
            or current_revision != receipt_revision
        ):
            raise ValueError(
                "Normal Growth record revision differs from its saved receipt"
            )
        expected_variants = {
            platform: next(
                (
                    item["content"].strip()
                    for item in draft.get("variants", [])
                    if item["platform"] == platform
                ),
                draft["content"].strip(),
            )
            for platform in draft.get("channels", [])
        }
        actual_variants = {
            item.get("platform"): item.get("content")
            for item in post.get("variants", [])
        }
        if expected_variants != actual_variants or any(
            item.get("status") != "DRAFT" for item in post.get("variants", [])
        ):
            raise ValueError("Normal Growth variants contradict the approved draft")
        return {
            "receipt": result,
            "record": {
                key: post[key]
                for key in (
                    "id",
                    "user_id",
                    "title",
                    "content",
                    "channels",
                    "status",
                    "updated_at",
                )
                if key in post
            },
            "authority": "GET /api/social/posts/:id under the prepared Growth business",
        }
