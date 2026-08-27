---
title: Content Pipeline
---

# Content Pipeline

The Content Pipeline module is already visible in the tenant portal and role-gated for content-related roles.

## Current portal experience

The current UI supports:

- entering a topic or prompt
- selecting a content type
- selecting a tone
- viewing generated output
- copying generated output
- viewing recent generation history

Supported content types currently include:

- blog post
- social caption
- ad copy
- email sequence
- product description

## Current implementation status

This module is currently **portal-visible but not yet backed by a dedicated tenant backend implementation**.

At the moment, the temporary `api-client-react` package still returns placeholder responses for:

- content generation
- content history

So users can understand and navigate the workflow, but this module should still be treated as a staged surface rather than a fully operational production feature.
