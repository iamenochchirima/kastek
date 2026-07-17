# Contact Data Lifecycle

This document defines the direct Kasitek application's contact-data rules. It applies within one organisation only. It does not change the separate white-label tenant data model.

## Import

- A WhatsApp CSV import deduplicates by normalized phone number within the active organisation.
- Re-importing a known phone adds or updates its membership in the selected list; it does not create another WhatsApp customer identity.
- Imports default to no marketing consent. A user must explicitly attest that the CSV contains valid consent before any imported row can be marked opted in.
- A CSV `consent` or `optIn` value is treated as a claim by the importer, not independently verified proof. The source is recorded as `csv-import` unless the CSV provides a source.
- Importing a row without consent never revokes an existing opt-in. Revocation is a deliberate contact edit so it cannot happen accidentally through list maintenance.
- Imports may update list-scoped fields such as tags, location, notes, and metadata. They do not overwrite an existing canonical name with a blank value.

## Identity and merge

- A customer identity belongs to one organisation and uses a provider-stable key: normalized phone for WhatsApp, or provider channel/account scope plus participant ID for Meta messaging.
- Matching display names, emails, or handles never cause an automatic merge.
- There is no manual merge control yet. It must be an explicit, auditable operation that chooses the surviving customer, moves compatible identities and records, and preserves a merge history. Until then, staff should correct the source record rather than attempting to combine customers.

## Consent

- Marketing eligibility is channel-specific. WhatsApp opt-in, source, date, and exclusion state remain on the WhatsApp contact and its list membership.
- Exclusion and opt-out are deliberate changes made from the contact editor; they are not cleared by an import.
- A later channel integration must store that channel's consent independently. A WhatsApp opt-in does not authorize Facebook, Instagram, email, or web messaging campaigns.

## Lists and deletion

- Removing a list removes its memberships only. It does not delete the underlying WhatsApp contact, canonical customer, messages, campaigns, or consent history.
- A list attached to an active campaign cannot be removed.
- Contact erasure is not yet exposed in the application. It requires a dedicated, permission-controlled workflow with a preview of linked identities, conversations, campaign records, and legal-retention constraints. It must not be implemented as a list deletion.
- Until erasure is implemented, staff can exclude a contact from marketing or remove a list membership without destroying customer history.
