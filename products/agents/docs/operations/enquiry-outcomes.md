# Enquiry outcomes

The first saved business outcome uses a website visitor, not a staff task. This is deliberate: customer-record projection applies to visitor and channel-customer principals, not human staff principals.

## Flow

1. An owner configures an agent with `capabilities.enquiries` enabled and the `enquiry.submit`, `enquiry.read` and `enquiry.amend` tools.
2. The owner publishes an immutable version and a website deployment with an allowed origin.
3. A website session creates a visitor token through `POST /api/website/:deploymentId/session`.
4. The visitor submits a message through `POST /api/website/:deploymentId/tasks`.
5. The agent proposes an enquiry with `enquiry_submit`.
6. The task enters `waiting_review`; the visitor reads the pending enquiry through `GET /api/website/:deploymentId/customer-conversations/:conversationId/enquiries`.
7. The visitor approves the exact request digest through `POST /api/website/:deploymentId/customer-conversations/:conversationId/enquiries/:enquiryId/decision`.
8. The task resumes, the tool returns a submitted receipt and the agent completes.
9. `projectSubmittedEnquiry` creates the customer contact and customer-record enquiry.
10. Staff read the result through `GET /api/organizations/:organizationId/enquiries` and `GET /api/organizations/:organizationId/customer-records/enquiries/:sourceEnquiryId`.

## Permissions

- The website visitor token is scoped to the deployment and session and requires the configured origin.
- The visitor can only read and confirm enquiries in its own customer conversation.
- Staff enquiry and customer-record routes require workspace membership.
- The agent version needs the enquiry capability and tools; the deployment must have approved public knowledge.

## Idempotence

The visitor task uses a stable request key. Replaying the same message in the same execution conversation returns the same task and enquiry; the tool operation is keyed by the task and operation id. The enquiry does not duplicate.

## Evidence

The evaluation control plane records the enquiry through `POST /v1/sandboxes/:id/outcomes` with:

- sandbox, workspace and agent reference
- kind `enquiry`, status `submitted`
- product enquiry id and customer-record id
- task id
- product request digest and read-back response digest

The outcome reference is independent of the task transcript and survives app/worker restart.
