# Labs landing page

The current draft reworks the saved Labs page using Parloa as the visual reference. Open http://localhost:3010/labs-landing/ with the designs server running. The saved mountain-hero version is preserved in this repository's commit `7f82eff`.

Edit `index.html`, `style.css` and `script.js` directly. `previews.css` contains the retained product scene styles. Assets live in `assets/`. No React, Next.js or build tools are needed to preview this page.

Agents, Growth and Agency are separate sections stacked vertically. Product links jump directly to each section. The original product previews remain interactive: Website chat / Team inbox, Campaigns / Calendar and the portal brand palette. Inert illustrative UI elements remain inert, as in the saved version.

The HTML templates at the bottom contain the alternate chat and calendar views. Update those when changing the preview content. The footer year updates automatically.

Company and enquiry links point to the Labs app at http://localhost:3007. Product section anchors and the home link stay within this design preview.

Reference observations are in `../references/parloa.md`. The page uses local imagery from the saved design, the original Helvetica/Arial typography with Georgia italic accents, warm neutral colours and an orange accent. Product names, content and previews remain KasiTek's. No Parloa customer logos, testimonials, statistics, imagery or proprietary font files are included.

Browser validation covered 1440, 1024, 760, 390 and 320px widths, loaded styles and image assets, product section anchors, all preview interactions, and the product menu's Escape behaviour.

The original product directory and image-led custom-services section were restored from the saved version at the owner's request.

The separate orange closing invitation was removed to avoid repeating the custom-project call to action. The image-led services section now leads directly into the footer.

The introductory three-card section and tabbed gallery were removed. Each product now has its own heading, description and preview in the page flow.

Motion is defined in `motion.js` and `motion.css`, using locally vendored GSAP and ScrollTrigger. Editorial is the default; `?motion=calm`, `?motion=expressive` and `?motion=off` select alternatives. Compare them at http://localhost:3010/motion-playground/. Each product has a replay control. Reduced-motion preferences disable the sequences, and the page remains readable without JavaScript or the animation libraries.

Motion validation covered entrances, product replays, preview interactions, runtime reduced-motion changes, mobile overflow, playground controls and static fallbacks.

The Agents scene is now an authored glass motion graphic in `agent-film.css`. SVG paths connect the knowledge card, agent and human handoff. The GSAP sequence includes typing dots, message arrivals and a light sweep. Website chat and Team inbox use separate illustrative conversations. The animation runs once on entry and can be replayed; reduced motion shows the complete scene.

The Agents section now has three always-visible category descriptions beside a shared demo stage. Customer support retains the glass conversation, Business shows a meeting request, approval and event receipt, and Personal shows a file-based meeting brief marked as a concept for a planned experience. Category selection is manual and supports keyboard arrows, Home and End. The stage keeps a consistent height across choices.

The current Agents treatment replaces the glass maps with a photographic setting and animated product workspace in `agent-operations.css`. Customer support shows a threaded reply, sample order thumbnail, profile photos, human handoff and timed activity log. Business shows a prepared calendar event, review/approval and creation receipt. Personal shows a typed meeting brief and source files, explicitly marked as a planned concept. These are scripted illustrative demos, not connected backend runs. Image provenance and the generated photo prompt are in `assets/agents/README.md`.

## Growth and Agency HTML presentations

The Growth and Agency sections now reproduce the image studies with HTML/CSS interfaces and photographic assets in `assets/presentations/`. They use their own `product-presentations.css` and `product-presentations.js`; Agents keeps its existing operation controller.

Growth shows a conversation, campaign editor and content calendar. The shell stays fixed while messages, fields, creative and scheduled cards enter. On small screens the campaign preview scrolls into view. Agency uses an ink canvas and layered client portals. Its sequence previews a studio identity change and brings Kaya Dental forward. The workspace buttons also select Acorn Home or Lena Studio, and the identity swatches change portal accents.

Each section has pause, next and replay. Autoplay runs only while visible and stops when the tab is hidden. It retains the focused view, respects reduced motion and `?motion=off`, and leaves a readable opening state without JavaScript. These are illustrative frontend demos; the controls do not call product APIs.

Verified all three views at 1440, 1024, 900, 760, 640, 390 and 320 pixels, including asset loading, client selection, accent changes, autoplay, pause/replay and mobile campaign scrolling. Exact generated-image prompts are in [the asset notes](assets/presentations/README.md).
