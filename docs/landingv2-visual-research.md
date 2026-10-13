# Landing v2 visual research

Researched 10 October 2026. The brief is to keep the current Helvetica Neue/Arial typography, Georgia italic accents, and "Good ideas. Real working tools." Give Labs an identity that covers Agents, Growth, Agency and custom software work. The user wants stronger visuals, simple navigation and plain copy.

## First-party references

These observations come from the sites' published content and first-party design explanations. They are not a claim that every animation or responsive layout has been inspected in a live browser.

| Reference | Observed approach | Adaptation for Labs |
| --- | --- | --- |
| [Pentagram, Isomorphic Labs](https://www.pentagram.com/work/isomorphic-labs/story) | The case study explains a grid-based identity, reconfiguring cubes, a restrained core palette, and short human language. Geometry expresses the company's work rather than acting as decoration. | Build one original graphic family for Labs. Let the shapes represent conversation, growth and client workspaces. Reuse those shapes at different scales across the hero, product introductions and footer. |
| [Linear homepage](https://linear.app/) and [brand guidelines](https://linear.app/brand) | The homepage uses detailed workflow fragments, including issues, conversations, planning and reviews. Its guidelines explicitly ask for generous space around assets and prefer monochrome wordmarks. | Give each product one large, legible workflow fragment. Crop enough to focus attention, while leaving space around the composition. Keep product names readable without relying on icons. |
| [teenage engineering, OP-1 field](https://teenage.engineering/products/op-1) | Product images alternate with specific details about physical controls, screen design and recording formats. The broader field system links to its individual products. | Treat software previews like carefully photographed objects. Give them a clear silhouette, consistent light and precise edges. Introduce the family, then let each product have its own visual character. |
| [Instrument](https://www.instrument.com/) | The homepage introduces recent work early, offers category filters, and later explains brand, marketing and product services. Its content gives work and services separate places. | Let visitors see what Labs builds before reading a lengthy company description. Place custom software services after the product exhibition, with a different layout and a direct enquiry link. |
| [Work & Co](https://work.co/) | A short introduction leads into latest work and updates, followed by an index of practice areas, outcomes and process. | Use a concise company introduction and a clear hierarchy. Give the products names and visual evidence; keep capability lists secondary. |
| [Basement Studio](https://basement.studio/) | Featured projects have individual narratives. Capabilities include engineering, branding, motion and 3D. The site separates its Lab and Ventures links from services. | A single authored visual interaction can establish craft. Use a controlled shape transformation or product switcher rather than animating every element. Labs' copy should remain calmer than this reference. |

## Recommended direction

Make the page feel like a small product exhibition. Keep the typography the user likes and use scale, composition and a recognisable graphic system to make it different.

- Replace the mountain hero with an original composition. A pale page, a very large left-aligned tagline, and a graphic object positioned beside or partly behind the text can give the opening a distinct silhouette.
- Use a consistent set of modular shapes. Agents can use paired forms that suggest an exchange; Growth can use expanding or rising forms; Agency can use nested panels. These are proposed meanings, not findings from the references.
- Use contrast deliberately. Pale cream and deep ink can carry most of the page. Reserve a brighter colour for the hero object and small product details. Full pastel panels currently soften every section into the same visual weight.
- Introduce products through a large exhibition area with clear selectors. The active product can occupy most of the space, while all product names remain visible. On mobile, let those names become accessible tabs or a short vertical list.
- Make each preview tell one story. Agents can show a customer conversation and handoff. Growth can show a campaign and follow-up. Agency can show a client workspace and branding controls. Use realistic sample content and avoid invented performance claims.
- Vary the layout below the exhibition. One product can use a wide interface crop; another a close-up of its working screen. Keep the same spacing rules so the variation still feels intentional.
- Give custom work a quieter editorial section. A large short sentence, a compact list of actual capabilities and a project enquiry link are enough.
- Finish with a large Labs wordmark or the same original motif. The footer should feel designed instead of becoming a dense link directory.

The first experiment should be the opening composition and product exhibition. They occupy the most attention and can establish the visual language before extra sections are added.

## Implementation constraints

Use CSS and SVG for the proposed geometry. It does not need a stock image, AI illustration or a heavy 3D runtime. Motion should help someone understand the active product and respect reduced-motion settings. Product selectors need visible focus, keyboard operation and readable labels. Keep the same content understandable without animation.

Avoid decorative numbering, fake awards, invented testimonials, floating badges, repeated rounded cards, generic gradient blobs and repeated slogans. Those additions would recreate the look the user wants to move beyond.

## Implemented experiment

The owner subsequently opened the brief to alternative fonts and headlines. The
saved starting point is Labs commit `fe8d24d`; the new direction remains uncommitted.

- `/landingv2` now opens with a pale typographic hero and three original SVG
  sculptures. The existing mountain image and stock services image are absent
  from this experiment. The geometry is generated by
  `apps/labs-site/scripts/landingv2-art.py`: a ring with a vermilion insert,
  rising sage fins, and layered slate panels. These are abstract product motifs,
  not advertised hardware or finished product logos.
- A large ink-coloured gallery switches between Agents, Growth and Agency.
  Each product retains its focused interactive sample. Tabs support left/right,
  Home and End keys; ordinary anchor navigation stays separate from the selector.
- The studio section uses an original CSS composition of application/integration
  panels on a terracotta background. It separates custom development from products.
- The preview-only `Design options` control offers three headlines: `Good ideas.
  Real working tools.`, `Built to be useful.`, and `Tools for the work ahead.`
  Type treatments are the original Helvetica/Arial stack, locally hosted Geist,
  and Georgia-led editorial headings. Geist's licence accompanies the font asset.
- Headline and type selections update `headline` and `type` query parameters. The
  server reads them on reload, so selected combinations have shareable URLs.
- Product forms respond slightly to pointer movement. Reduced-motion settings
  disable the transforms and entrance animation. No continuous animation or
  heavy 3D runtime is used.

Validation: focused ESLint and TypeScript checks passed. Both stylesheets parsed,
all referenced CSS classes were found, and all nine headline/type combinations
rendered through an isolated React static-render harness. The original SVGs were
rasterised locally and visually inspected. This does not establish full-page
browser appearance or client interaction acceptance; browser/server startup is
restricted in this sandbox. Hosted deployment was not performed.
