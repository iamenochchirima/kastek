# 0005: Knowledge is usable when attached

Date: 2026-11-21. Status: accepted.

## Context

Knowledge sources carried a `private`/`public` flag enforced in two places: retrieval filtered
public-only for website visitors, and website publication refused any private attached source.
The knowledge UI did not expose the flag, and the source-policy HTTP route did not accept a
visibility action, so an approved, attached source could not be deployed to a website at all. The
flag duplicated the attachment decision and failed closed in a way the owner could not resolve.

## Decision

A source is usable by an agent when the agent version attaches an approved revision. There is no
separate source-level audience flag. The agent/version attachment and the website deployment
approval are the publication boundary. Removing a source from the agent, or withdrawing it,
removes its use.

## Consequences

- Website deployment still requires active, approved attached sources, but not a visibility flag.
- Retrieval filters by attachment, approval and withdrawal, not by visitor class.
- A source shared across agents is readable by every agent that attaches it. To keep knowledge
  away from an agent, do not attach it.
- Evidence manifests no longer pin visibility. Approval and withdrawal still invalidate evidence.
- Schema 166 drops `sources.visibility`, drops the MCP visibility review action, and cancels any
  pending visibility review.

## Alternatives

- Expose the flag in the UI. Rejected: it duplicates attachment with a second hidden decision.
- Publish automatically on website connect. Rejected: it keeps the flag and its migration burden.
