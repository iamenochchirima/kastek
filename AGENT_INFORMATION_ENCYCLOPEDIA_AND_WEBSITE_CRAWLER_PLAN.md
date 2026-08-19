# Agent information encyclopedia and website ingestion

## Purpose

Give hosted agents a reviewed, workspace-scoped body of information that they can use to answer
questions. The first release is an information encyclopedia entered by a workspace member. Website
ingestion is a later source type that must use the same source and chunk index.

This is retrieval-grounded context, not model fine-tuning. The agent should only present information
as reviewed workspace knowledge when a matching indexed chunk was retrieved.

## Current slice: encyclopedia

- [x] Store a named manual source against an agent and installation.
- [x] Accept plain text or Markdown up to the bounded ingestion limit.
- [x] Accept TXT, Markdown, CSV, PDF, DOCX, and XLS/XLSX uploads through the same encyclopedia
  index (20 MB file and 200,000 extracted-character limits).
- [x] Extract uploaded content with format-specific parsers, preserve filename/format metadata, and
  reject unsupported, malformed, binary, empty, or oversized files.
- [x] Split the article into searchable chunks using the existing knowledge index.
- [x] Enforce the hosted-agent resource scope and `agents:write` permission.
- [x] Expose the operation through the agent service, the Rust boundary, and the client proxy.
- [x] Expose multipart upload through the Agent Platform API, core boundary, and client library.
- [x] Add an agent-details form with one paste field for article/FAQ/policy text; source naming is
  internal so users do not have to manage indexing metadata.
- [x] Add an optional Knowledge step to the general-purpose creation wizard with pasted
  information and file upload.
- [x] Keep the future website option visible but disabled until the crawler exists.
- [x] Create the selected sources after the hosted installation is created, while preserving the
  agent if an optional ingestion fails and showing a retry path from details.
- [x] Make general-purpose installations request knowledge retrieval for every message.
- [x] Keep manual entries and single-page URL ingestion separate in the backend source contract;
  URL/crawling remains unavailable in the current UI until the crawler is ready.
- [x] Cover the endpoint, retrieval gate, Rust boundary, TypeScript, lint, build, and targeted Rust
  boundary tests, including file extraction and multipart upload tests.

## Crawler contract: next stage

The crawler should be an ingestion job, not a second runtime or a direct model tool.

- [ ] Add a crawl source configuration: start URL, allowed host(s), path include/exclude rules,
  maximum pages, maximum bytes per page, request timeout, crawl frequency, and contact/policy
  metadata.
- [ ] Validate and record robots policy before fetching. Make an explicit deny/pause state when the
  policy cannot be read or the requested path is disallowed.
- [ ] Restrict requests to the configured host and approved schemes; block private-network and
  loopback targets, redirects outside the allow-list, and non-document content by default.
- [ ] Fetch with bounded concurrency, per-page timeout, response-size limit, total crawl budget, and
  cancellation support.
- [ ] Extract readable page text, title, canonical URL, content type, and last-modified/etag data;
  keep the original URL as provenance and do not index navigation boilerplate when it can be
  removed safely.
- [ ] Normalize URLs, deduplicate pages, and avoid revisiting equivalent fragments or query
  variants unless explicitly allowed.
- [ ] Write each crawl revision atomically. A completed revision replaces the prior searchable
  revision; a failed crawl leaves the last successful revision active.
- [x] Filter retrieval to the source's current revision so stale chunks cannot outrank current
  content.
- [ ] Record per-page status, error reason, byte counts, chunk counts, timestamps, and source
  provenance for audit and troubleshooting.
- [ ] Add preview/review before activation, with a clear “last successful crawl” state and a way to
  pause or remove the source.
- [ ] Add scheduled refresh only after one-shot crawl, preview, cancellation, and failure recovery
  are proven.

## Boundaries and safety

- Manual encyclopedia entries are workspace data and inherit the agent/installation scope.
- A crawler cannot grant capabilities or publish content; it only adds retrievable reference data.
- Website text is untrusted data. It must never override agent policy, capability authorization, or
  user instructions.
- Provider credentials, billing data, inbox data, and private network addresses are out of scope for
  the crawler.

## Verification gates

- Unit tests for URL normalization, robots decisions, extraction, chunk replacement, and budget
  enforcement.
- Integration tests for source scope, cancellation, failed-revision retention, and retrieval of the
  current revision only.
- A local fixture site with links, redirects, duplicate URLs, a large page, a disallowed path, and a
  robots rule.
- Operational logging and an audit record for start, page outcomes, completion, cancellation, and
  failure.
