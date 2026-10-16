/**
 * Deterministic boundary messages for human handoff state transitions.
 *
 * These are deliberately not model-generated: the system must not promise a
 * handoff or invent availability while ownership is changing.
 */
export const HANDOFF_ACKNOWLEDGEMENT_TEXT =
  "Absolutely — I’ve sent your request to our team. A team member will reply here as soon as possible.";

export const HANDOFF_ACTIVE_TEXT =
  "Your request for a team member is already open. Someone will reply here as soon as possible.";
