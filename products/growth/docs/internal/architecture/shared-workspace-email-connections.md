# Shared workspace email connections

Google and Microsoft mailboxes use one workspace-owned EmailConnection. Growth stores encrypted
OAuth material and exposes a safe ExternalConnection projection. EmailInboxBinding owns Inbox
readiness and synchronization watermarks.

The supported email endpoints remain under /api/email. Browser OAuth starts and callbacks belong
to Growth. The email Inbox worker claims active bindings, normalizes provider messages into
Conversation/Message records and deduplicates provider message IDs. Send/reply uses the same
provider adapter, and failed messages remain retryable in the local timeline.

Embedded Growth agents do not receive mailbox access merely because a connection exists.
The removed installation binding, Studio mailbox selection and Playground-to-Live API are not
supported connection paths. The current Growth agent action contract has no email tool.

Custom Email remains unavailable until its provider and synchronization contract exist.
Provider tokens remain in the encrypted Growth credential record, outside agent context.
