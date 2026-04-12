---
title: Workspace Settings
---

# Workspace Settings

The current `Settings` screen combines two operational areas:

- custom portal domain management
- workspace email sending management

## Portal domain area

This section currently supports:

- viewing the hosted fallback domain
- viewing the expected DNS target
- adding a custom portal domain
- verifying DNS
- setting a domain as primary
- removing a mapped domain

## Email sending area

This section currently supports:

- viewing the current sender preview
- updating sender name
- updating reply-to email
- updating shared sender local part
- switching between shared and custom sending mode
- adding custom sending domains
- verifying those domains
- selecting a verified custom sending domain
- sending a live test email

## Operational expectation

The current design is intended to let a tenant launch quickly with KasiTek-managed infrastructure and then harden their setup over time:

1. use hosted domain + shared email sending first
2. add custom portal domain
3. add custom sending domain
4. switch to branded sending
