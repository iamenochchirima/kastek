---
title: Leads
---

# Leads

The lead pipeline is currently one of the stronger operational areas in the tenant backend.

## What tenant staff can do today

Tenant staff with lead-access roles can:

- list all leads across the workspace
- filter and search in the portal UI
- create a new lead
- assign the lead to a tenant client

## Lead fields currently supported

The current create-lead flow supports:

- tenant client
- contact name
- email
- phone
- company
- source
- notes

Supported sources currently include:

- manual
- web chat
- WhatsApp
- Instagram
- email
- voice

## Automatic scoring

The backend currently calculates a lead score based on:

- source
- whether phone is present
- whether company is present
- whether notes are present

That score is stored and returned to the tenant portal.

## Lead stats

The current stats endpoint returns:

- total leads
- qualified leads
- converted leads
- weekly trend
- counts by status

## Client-scoped lead visibility

Client users also have a separate lead register at `/client/leads`.

That client view is restricted to leads linked to that tenant client account only.
