# Agency: portal portfolio direction

Current preview: http://localhost:3010/agency-storyboard/

A new visual direction uses a midnight ink canvas, oversized editorial typography and layered client portals. Photography is confined to the client interfaces. The three views show a portfolio, a studio identity change and a switch to another client. The previous photographic direction remains in [the earlier study](photographic-study.html).

## Animation to implement

- Portfolio: client portal surfaces fan into position with small rotations and staggered depth. Acorn Home settles at the front. Keep the heading fixed.
- Identity: slide in the identity card, animate the pointer selecting an accent, update the agency wordmark and portal accent links together. Hold so the change is visible.
- Client switch: bring Kaya Dental forward while Acorn Home recedes. Update the selected workspace, then reveal the conversation and website preview.

The HTML review page crossfades still images, with pause and manual selection. Detailed surface motion is a proposed implementation, not simulated by these images. Names, portraits and interface content are illustrative.

## New assets

Built-in image generation was used for all three images. The portfolio image was the edit reference for the other two. Exact prompts are preserved.

- [Portfolio](assets/portfolio-v2.png), [prompt](prompt-v2-1.txt)
- [Identity](assets/identity-v2.png), [prompt](prompt-v2-2.txt)
- [Client switch](assets/client-switch-v2.png), [prompt](prompt-v2-3.txt)

---

# Agency visual sequence

Open http://localhost:3010/agency-storyboard/ for the image preview. It crossfades three still mockups, with pause and manual view controls. Full-size images sit below it.

The photographic agency setting stays fixed. The app first shows separate businesses, then studio branding, then the portal a client sees. Ivory, muted moss, editorial photography and serif accents connect it to the Labs landing page while giving Agency its own identity.

## Proposed animation

- Workspaces: app enters over 900ms, client cards appear 140ms apart, then activity and the glass note. Hold 6.5 seconds in the image preview.
- Branding: retain the shell, replace the content over 650ms, animate the cursor to an accent swatch, update the portal preview, show save feedback. Hold 7.5 seconds.
- Client portal: expand the nested preview into the full application area, remove agency editing controls, reveal conversations, the report and account manager. Hold 8.5 seconds before looping.

The HTML preview demonstrates the order using 950ms image crossfades. Detailed layer animations are proposed for later implementation. The mockups are illustrative marketing concepts, not screenshots or verified feature behavior from the shipping portal.

## Assets and prompts

Created using the built-in image generation tool on 2026-10-14. Branding and client portal views are edits of the workspaces image for continuity.

- [Workspaces](assets/workspaces.png), [exact prompt](prompt-1.txt)
- [Branding](assets/branding.png), [exact prompt](prompt-2.txt)
- [Client portal](assets/client-portal.png), [exact prompt](prompt-3.txt)
