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
