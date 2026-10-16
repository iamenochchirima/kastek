---
title: Client Portal Experience
---

# Client Portal Experience

The client portal is already a distinct audience inside the same tenant web app.

## What a client user sees today

After activation and login, the client user is routed into `/client`.

The current client experience includes:

- client home summary
- lead register
- conversation log
- conversation detail

## Client home

The client home currently shows:

- total client users
- total conversations
- open conversations
- total leads
- total messages

It also includes quick links into:

- client leads
- client conversations

## Client lead register

The current lead register allows a client user to:

- search their leads
- view source and status
- see score
- see company and created date

## Client conversations

The conversation area allows a client user to:

- search conversations
- inspect conversation detail
- read the message timeline

## Access isolation

The key implementation rule is that client users only see data tied to their own `tenant_client_id`.

This is enforced in the backend, not only in the UI.
