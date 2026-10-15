---
title: Immediate Product Checklist
slug: /execution/immediate-product-checklist
---

# Immediate Product Checklist

Temporary working document for deciding what to build next. The goal is to get a new workspace to a working customer-conversation system as quickly as possible.

## Core activation path

1. Set up the workspace
2. Connect WhatsApp and phone numbers
3. Bring in or capture contacts
4. Work from the shared inbox
5. Launch a WhatsApp agent
6. Invite and organise the team
7. Measure outcomes

## Implementation checklist

### 1. Workspace onboarding

- [x] Build a short, skippable welcome stepper after first sign-in
- [x] Ask only for information that selects a useful first task or personalises its setup
- [x] Persist answers against the workspace, not the individual user
- [x] Route each user to a relevant first action
- [ ] Ask remaining information in the feature that needs it

#### Welcome stepper: first release

Keep this to five short screens, one question per screen. It should not be a gate: users can skip it and revisit it from workspace settings. The company-name step is the exception: it is needed to name the workspace clearly.

1. **Tell us about your business**
   - Company name — required
   - Website — optional
   - Explain the benefit plainly: “We use your website to help prefill business details when you create content or an agent.”
   - If a website is supplied, fetch or extract public business context only after the user confirms it; never make this step block progress.
   - **Used for:** naming the workspace and reducing repeated business-context questions later.

2. **What would you like to set up first?**
   - Manage customer messages
   - Set up an AI agent
   - Create social content
   - Set up bookings
   - Run a campaign
   - Explore first
   - **Used for:** selecting the first action and the initial checklist.

3. **What is your role on the team?**
   - Owner or founder
   - Marketing or social media
   - Sales or customer support
   - Operations or admin
   - Agency or consultant
   - Other
   - **Used for:** tailoring language, prompts, and suggested actions. It is not an access-control role.

4. **What industry are you in?**
   - Services and professional businesses
   - Retail or e-commerce
   - Hospitality, beauty, or wellness
   - Healthcare
   - Property or real estate
   - Education
   - Other
   - **Used for:** relevant agent templates, social prompts, booking defaults, and reporting examples.

5. **How did you hear about KasiTek?**
   - Search engine
   - Social media
   - A friend or referral
   - KasiTek team or event
   - Advertisement
   - Other
   - **Used for:** acquisition measurement only. Make this screen optional and allow “Skip”.

#### Do not ask in the welcome stepper

- Phone number: collect it only for a calling, WhatsApp, or recovery flow that requires it.
- WhatsApp number or Meta credentials: collect them only after the user chooses to connect WhatsApp.
- Brand voice, common questions, service catalogue, availability, contacts, and team members: collect these in the related agent, content, booking, import, or invitation flow. The website may be supplied in the welcome stepper, but it remains optional.
- Company size and current tools: defer until there is a specific personalisation or sales-routing use for the answer.

#### Routing after completion or skip

- **Manage customer messages** → Connections, with WhatsApp as the recommended first channel.
- **Set up an AI agent** → Agent template chooser; ask for knowledge and handoff rules there.
- **Create social content** → Content setup; ask for website/business description and tone there.
- **Set up bookings** → Booking services and availability setup.
- **Run a campaign** → Contact import and WhatsApp template setup.
- **Explore first** or **Skip** → Workspace overview with an adaptive “Next steps” checklist.

#### Data and implementation requirements

- [x] Add workspace-level onboarding profile and completion state
- [x] Add an authenticated API to read and update the profile
- [x] Redirect a first-time workspace admin to the stepper after authentication; do not repeat it once skipped or completed
- [ ] Keep answers editable in workspace settings
- [ ] Record selected goal and stepper completion for activation reporting

### 2. WhatsApp and number management

- [ ] Connect WhatsApp through the embedded signup flow
- [ ] Show number, connection, verification, and health status
- [ ] Let workspace admins manage connected numbers and channel settings
- [ ] Explain any required permissions or incomplete setup steps

### 3. Inbox and contacts

- [ ] Present a unified inbox for customer conversations
- [ ] Support replying, assignment, tags, notes, and conversation history
- [ ] Import contacts and create contacts manually
- [ ] Provide basic contact segments for follow-up and campaigns

### 4. WhatsApp agents

- [ ] Offer template-first agents: FAQ, lead capture, bookings, quote requests, and support
- [ ] Collect the minimal knowledge and routing rules needed for each template
- [ ] Provide a test conversation before publishing
- [ ] Allow publishing to the selected connected WhatsApp channel
- [ ] Show handoff to a human, agent status, and basic outcome activity

### 5. Team operations

- [ ] Invite staff members
- [ ] Define practical roles and permissions
- [ ] Support conversation assignment and ownership
- [ ] Configure relevant alerts and notifications

### 6. Social content and calendar

- [ ] Generate social post drafts from business context
- [ ] Review, edit, approve, schedule, and publish content
- [ ] Show a simple calendar of planned and published posts

### 7. Bookings

- [ ] Define services, availability, and booking rules
- [ ] Let agents collect booking details and create bookings
- [ ] Send confirmations and reminders

### 8. Campaigns

- [ ] Create approved WhatsApp templates
- [ ] Select opted-in audiences from contact segments
- [ ] Send campaigns and show delivery, response, and conversion outcomes

### 9. Reporting

- [ ] Show conversations, response time, leads, bookings, and agent outcomes
- [ ] Show campaign performance where campaigns are enabled
- [ ] Prioritise a concise weekly outcome view over broad dashboards

### 10. Follow-on products

- [ ] Add a website chat agent as the next automation channel
- [ ] Treat website creation as a separate guided product flow, not a prerequisite for platform activation

## Current focus

Work on the activation path before expanding surface area. The priority is a reliable workflow from a connected WhatsApp number to an active agent, human inbox, team handoff, and visible result.
