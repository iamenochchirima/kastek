---
title: Implemented Features
---

# Implemented Features

This page separates areas that are live in the tenant backend from areas that are currently exposed in the tenant portal but still depend on placeholder responses.

## Backend-backed today

The following are backed by live tenant backend routes and database access:

- workspace resolution by host/domain
- public tenant context
- tenant staff login/logout/session
- tenant client login/logout/session
- client invite preview and invite acceptance
- dashboard summary
- dashboard activity
- dashboard service status
- tenant client list and creation
- tenant client user list
- tenant client invite creation
- tenant lead list
- tenant lead creation
- tenant lead stats
- client-scoped lead list
- client-scoped lead stats
- client overview
- client conversation list
- client conversation detail
- client conversation messages
- hosted and custom portal domains
- workspace email sending configuration
- Resend-backed custom sender domains
- test email sending

## Portal-visible but still using placeholder data

The following surfaces currently rely on the temporary `client/packages/api-client-react` placeholder layer:

- content pipeline generation and history
- reporting dashboards and metrics
- nurturing sequences and nurturing stats
- AEO content and citation metrics
- review campaigns and review stats
- ad campaigns and ad creatives
- voice agents and call logs

## Why this matters

This distinction helps users and operators set correct expectations:

- some areas are already operational
- some areas are already productized in the portal but still waiting for deeper backend integration

That split is real in the current codebase and should be documented openly rather than hidden.
