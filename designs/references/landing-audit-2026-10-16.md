# Labs landing audit, 16 October 2026

Scope: the standalone `labs-landing` design, compared with current official product homepages. This is a content and interaction comparison, not a conversion study. Source claims below describe what each vendor presents. They do not independently verify its performance claims. Recommendations are design judgments.

## Implemented in this pass

- Removed the empty hero column left by the chat removal. At a 900px viewport height, the mobile hero is 760px instead of 900px. The desktop/tablet heading can use the available width.
- Updated product descriptions to cover support, business and personal agents, and to name Growth conversations/campaigns and Agency client portals explicitly.
- Changed access/contact actions to `Request Agents access`, `Request Growth access` and `Talk about Agency`, matching their existing URL purposes.
- Added a small current-view label beside playback controls without restoring the removed category selector. The main Explore action now opens the product directory.
- Increased playback targets and the Products summary to a 44px minimum height; added outside-click dismissal to the menu.
- Strengthened supporting-text contrast and aligned visible playback labels with their accessible names. The personal phone conversation can be scrolled with the keyboard.
- Corrected Agents pause behavior: selecting another example while paused displays the completed example, while replay explicitly resumes playback.
- Added same-dimension WebP delivery copies of eight photos, retaining PNG originals. Those files total 1,299,734 bytes compared with 17,446,917 bytes before conversion, a 92.5% reduction. This is an asset-size measurement, not a speed benchmark. Non-hero images decode asynchronously and reserve intrinsic dimensions.
- Preserved the fonts, imagery compositions, Growth glass, dark Agency layout and the removed hero overlay.

## Remaining before publication

1. Connect the real access/contact journey. Links still use `localhost:3007`; that app was not running during the audit. Do not call those flows verified or publish local URLs.
2. Add genuine product evidence when available: actual supported-feature information, a shipped workflow or an attributable customer result. The current scenes are illustrative; they are not customer proof. Avoid adding fabricated logos, metrics or quotes.
3. Confirm availability wording across Agents categories. Personal is marked in development; other access and launch expectations need product-owner confirmation before publication.
4. Keep the design-workspace link and study metadata out of the production footer when this prototype is moved into the real site.

The comparison recommendations below were recorded before implementation. Items above describe what was actually changed.

## Visual review limits

Official homepage HTML was read for all five references. Desktop browser captures at 1440 by 1000 were also inspected for Lindy, Linear and ManyRequests. Lindy has a spacious light hero with paired trial/demo buttons and a work interface starting beneath it. ManyRequests gives the client-portal category and actions prominent placement. Linear's captured first frame was still transitioning, so no conclusions about its final animation or product-demo composition are drawn. Lindy's browser headline differed from the text crawl, which may reflect dynamic rendering or a variant. The recommendations do not depend on that wording.

## What to keep

Keep the current Helvetica/Arial and Georgia pairing, photographic Agents scenes, Growth glass treatment, dark layered Agency portals, and the vertical product structure. Keep the removed hero conversation overlay removed. The page already has enough visual variety. The next improvement should make each product and its next step easier to understand.

## Comparisons

| Reference | Observed pattern | Application to Labs |
| --- | --- | --- |
| [Parloa](https://www.parloa.com/) | A clear customer-service proposition, a platform link, and concrete conversations that end in a resolved state. Its later sections link customers, product information and a trust center. | Give each scene a visible result. Keep supporting evidence separate from the illustrative demo. Labs has three products, so its opening should help visitors choose between them rather than copy Parloa's single-product pitch. |
| [Lindy](https://www.lindy.ai/) | The hero names the product as an AI teammate, gives trial and demo routes, and uses concrete work requests with tool actions and resulting documents. | Show the task, work and result in that order. Avoid making readers inspect activity logs to work out the benefit. Make CTA destinations predictable. |
| [Fin](https://fin.ai/) | The homepage provides demo and trial routes, then explains specific purchase questions such as performance, channels, integrations and how teams improve the agent. | Add a small amount of factual product information around demonstrations. Only include claims verified in KasiTek's product. Do not reproduce Fin's long numbered layout or performance claims. |
| [Linear](https://linear.app/) | A concise category statement introduces an interface example. Subsequent sections group real work by intake, planning and building, with specific learn-more links. | Let product interfaces carry the detail. Keep the headline concise, while a plain sentence names what each product does and who it serves. |
| [ManyRequests](https://www.manyrequests.com/) | The opening identifies an agency client portal, explains requests, delivery and billing, and gives direct trial/pricing routes. White labeling is tied to client actions such as requests and approvals. | Agency should explicitly say branded client workspaces or portals. Show the client's practical task as well as changes to the studio identity. Do not imply billing or other features unless supported. |

## Highest priority

1. Correct product descriptions across the page. The Products dropdown describes Agents as customer conversations, while its section covers support, business and personal work. Use a description such as `Support, business & personal agents`. The directory's `AI that knows your business` also excludes the personal example. Growth's `The business day` is vague; `Conversations & campaigns` matches the visible demo more closely.
2. Align CTA wording with its destination. `Discover Agents` and `Discover Growth` currently go to `/early-access?product=...`, while `Discover Agency` goes to a partnership contact URL. Use an honest request-access or contact label, or implement real product overview destinations. All those links currently target `localhost:3007`, so they depend on another local server. Verify them before presenting this as a complete user journey.
3. Give every demonstration one readable outcome outside tiny application text. Suggested examples to check against actual implementation are `An answer, with a person ready to help`, `A campaign reviewed and scheduled`, and `A workspace in your client's brand`. Keep them short. The current Agents footer describes platform breadth rather than the demonstrated result. Do not add another row of three cards; the user removed that layout.
4. Keep autoplay but provide visible orientation. A small active-view label such as `Customer support` or `Campaign` near the pause/next controls will help visitors entering halfway through. Preserve pause, next and replay. A discreet progress treatment could convey when a scene will change, without rebuilding the removed category selector.

## Next pass

- Confirm readable final states at desktop and phone sizes. A beautiful app frame is ineffective if the core task can only be understood from miniature labels. Enlarge the conversation, selected campaign or client action before adding more decorative detail.
- Show a concrete client action in Agency, such as opening a deliverable or reviewing a request, if that matches the product. Branding and workspace separation are already visible.
- Distinguish available product capabilities from concepts. Personal is marked in development inside its demo; make access expectations equally clear at the product action. Do not invent availability or launch dates.
- Add real evidence when available, such as a working product link, real case study or actual documentation. Current sample people and businesses are illustrative. They must not become customer endorsements.
- Keep the custom-work section as a secondary route. The user already removed a repetitive closing CTA. Do not add another broad contact banner beneath it.

## Checks for the implementation pass

- Product descriptions agree between navigation, directory and section headings.
- Every main CTA reaches its intended destination and identifies what happens next.
- Each animated sequence has a readable result, a pause control, and a useful static reduced-motion state.
- Mobile composition prioritizes the task over sidebars and decorative app chrome.
- Neutral naming remains throughout; no regional identity text is reintroduced.
- No fabricated customer logos, results, certifications or integration claims.

## Validation of this pass

- Chromium browser checks at 1440, 1024, 768, 640, 390 and 320px: no horizontal overflow; Products menu stays within viewport; Escape and outside-click dismissal work; current-view labels follow scene selection; photographic assets decode; campaign images retain their intended proportions.
- Automated axe checks: no violations reported for the opening page or each of the nine demo views at desktop width after contrast, accessible-name and keyboard-scroll fixes. This is not a claim of full accessibility conformance; text over photographs and glass still requires visual judgment.
- Playback checks: paused Agents next selection stays readable; replay resumes playback; automatic Agents/Growth/Agency view changes update labels; runtime reduced-motion preferences disable playback controls.
- JavaScript syntax checks and `git diff --check` passed.
- `pnpm verify:boundaries` passed for 1,734 source/script files. The installed Node is 23.11.1, so pnpm emitted the existing Node 24 engine warning. No product runtime or dependencies were changed.
- Source inspection confirms the linked about/contact/early-access/get-quote/privacy-policy routes exist in the Labs application. Runtime requests to port 3007 failed because that application was not running; contact and access submissions remain unverified.

## Release impact

- Change: low-risk standalone design-preview refinements; no deployment performed.
- Owner: current owner-directed design session.
- Affected surface: `designs/labs-landing` and its local assets/reference documentation.
- API/schema/migrations, analytics, logging/metrics/alerts, platform version, feature flags and operational rollout: not applicable to this static preview change.
- Documentation: current landing README, asset encoding notes and this audit updated. Product feature maps are unchanged because shipping product behavior is unchanged.
- Rollback: restore the edited preview files and PNG references; all PNG originals remain available. No product data is modified.
- Post-release review: not applicable; there was no production release. Validate real enquiry flows before integrating or publishing.
