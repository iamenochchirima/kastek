# Labs landing page

Open http://localhost:3010/labs-landing/ after running `python3 designs/serve.py` from the repository root. This is a standalone HTML/CSS/JavaScript design preview; it has no product backend connections.

## Current design

- The image-led hero retains the original headline and Helvetica/Arial with Georgia italics. The chat overlay is removed. The main action opens the three-product directory.
- Agents cycles through support, business and personal scenes. Its photographic app previews include illustrative profiles, operations and logs. Personal is marked in development.
- Growth uses a frosted shop-backed workspace and cycles through conversation, campaign review and scheduling.
- Agency uses a dark canvas and three layered client portal cards. Selecting a client brings its card forward while keeping the other workspaces visible. A small identity strip updates all portal accents. The front deliverable moves from ready-for-review to an approved state, and its review button also works manually.
- The custom-software section leads into the footer. The earlier redundant closing invitation and three-card introduction remain removed.

Each demo has pause and next controls, plus a current-view label. Replay resumes Agents playback. Selecting another Agents example while paused shows its completed state. Motion respects reduced-motion preferences and `?motion=off`. Calm and expressive treatments remain available for the original section motion.

The menu supports Escape and outside clicks. Demo controls have 44px minimum heights, the phone conversation is keyboard-scrollable, and small supporting text has stronger contrast. Mobile uses a shorter hero, stacked working views and intentional internal scrolling.

## Files

- `index.html`, `style.css`, `script.js`: page structure, navigation and Agents selection.
- `motion.js`, `motion.css`: GSAP entrances and Agents operations. GSAP is vendored locally under `../shared/vendor/gsap/`.
- `agent-operations.css`, `agent-carousel.js`: current Agents layout and automatic scene changes.
- `product-presentations.css`, `product-presentations.js`: shared demonstration controls, Growth styling, and Growth/Agency playback.
- `agency-presentation.css`: the current layered-portal Agency layout, brand controls and transitions.
- `previews.css`: shared styles retained from the saved design. `agent-film.css` is an earlier reference, not loaded by the current page.

## Assets

The page uses local WebP delivery copies of eight photographic PNGs. Original dimensions and PNG sources are retained. Their combined payload is 1,299,734 bytes instead of 17,446,917 bytes, a 92.5% reduction. This measures those eight files, not page-speed or conversion performance.

Generation prompts and source information remain in [Agents asset notes](assets/agents/README.md) and [presentation asset notes](assets/presentations/README.md). WebP is a delivery-format conversion, not newly generated artwork. The shared hero/services photograph uses quality 90; the other delivery copies use quality 87.

## Verification

The [16 October audit](../references/landing-audit-2026-10-16.md) records first-party product comparisons, implementation decisions and current validation. Browser checks cover six widths from 320 to 1440 pixels, all nine demo views, asset decoding, menu behavior and playback. Automated accessibility checks cover the opening page and each alternate demo view; they supplement manual screenshot and keyboard checks.

Company, contact and access links intentionally still point to the separate Labs app at `localhost:3007`. That server was unavailable during this audit. These flows are not verified end to end, and those origins must be replaced before publishing.

## Agency composition

Three portal cards remain visible to communicate separate client workspaces. The foreground card has a readable deliverable and approval action. The other two retain identifiable headers and imagery. Selection promotes one card and moves the others into the two supporting positions, with gentle angles and matched easing. The compact branding strip updates their shared identity. On mobile the supporting headers remain above the main card; the deliverable image stacks above the review details.

Verification covers all clients at 1440, 1024, 900, 768, 640, 390 and 320 pixels, including content fit, card promotion, manual approval, accent changes, automatic transitions, pause, reduced motion and automated accessibility checks. This is a local design-preview change; API, schema, analytics, platform-release and deployment changes are not applicable.
