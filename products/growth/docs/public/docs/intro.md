---
id: intro
title: KasiTek Platform Docs
sidebar_position: 1
slug: /
owner: engineering
last_reviewed: 2026-08-25
---

# KasiTek Platform Docs

These docs cover the user-facing parts of the current KasiTek platform based on the live codebase.

Today the platform has three practical layers:

- KasiTek platform provisioning and operations
- tenant staff workspaces for agencies, consultants, or operators
- tenant client portals for the tenant's own customers

The current public docs focus on the tenant-facing product:

- tenant workspace access and sign-in
- custom portal domains
- branded email sending
- client account management
- lead and conversation visibility
- the current public API and integration references

## What is live today

The strongest live backend-backed areas right now are:

- tenant workspace resolution by host/domain
- tenant staff and tenant client authentication
- client invitation and activation
- client management
- lead pipeline
- client-scoped conversation views
- custom portal domains
- workspace email sending configuration with Resend-backed custom domains
- beta early-access applications and invitation-based workspace activation

The documentation set intentionally excludes product roadmaps, go-to-market material, and planned
surfaces that are not yet backed by a supported implementation.

## Beta early access

KasiTek is currently in beta. Businesses can [apply for early access](https://kasitek.co.za/early-access).
Applications are reviewed before a seven-day, single-use invitation is issued. The applicant
creates an account with a password or Google, then creates or selects a workspace. Redeeming the invitation activates the
30-day `beta-2026-01` package with 1,000 credits and the approved beta capabilities. The beta label
does not grant access by itself.

## Recommended reading order

1. [Getting Started Overview](getting-started/overview)
2. [Accessing Your Workspace](getting-started/accessing-your-workspace)
3. [Roles and Permissions](getting-started/roles-and-permissions)
4. [Domains and Branding](workspace/domains-and-branding)
5. [Email Sending](workspace/email-sending)
