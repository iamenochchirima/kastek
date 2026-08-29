# Early-Access Self-Service Release Notes

Status: unreleased

## Admin

- Approval now sends a seven-day, single-use signup invitation.
- Approval no longer creates an applicant account or workspace.
- Applications can be approved individually or in batches of up to 100.
- Resend issues a fresh token. Revoke invalidates pending tokens and closes active beta grants.

## Applicant

- New applicants create their own account and workspace from the invitation link.
- Existing applicants sign in with the approved email, then select an owned/administered workspace
  or create a new one.
- A successful activation applies the fixed `beta-2026-01` package: 30 days, 1,000 credits, and
  the approved beta capabilities.

## Deployment

- Apply migration `20260829210000_add_self_service_early_access` before enabling the flow.
- Core enables the flow by default. Set `EARLY_ACCESS_SELF_SERVICE_ENABLED=false` to disable new
  approval and redemption without removing records.
- Record the final platform release ID, commit SHA, artifact versions, and migration result before
  production deployment.
