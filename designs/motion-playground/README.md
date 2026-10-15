# Motion studies

Open http://localhost:3010/motion-playground/ to compare the same landing page with Calm, Editorial, Expressive or Off treatments. Replay reloads the entrance. Section shortcuts scroll the live preview to each product. Mobile preview changes the frame width to 390px.

The playground renders the actual `labs-landing/` page in an iframe, so styling, content and interactions stay in one place. `?motion=calm`, `?motion=editorial`, `?motion=expressive` and `?motion=off` also work directly on the landing page. Editorial is the default.

`labs-landing/motion.js` contains the timelines and responsive motion setup; `motion.css` contains headline masks and motion controls. GSAP 3.15.0 and ScrollTrigger are stored locally under `shared/vendor/gsap/`. No build step is needed.

The motion follows normal scrolling and runs each entrance once. Hero imagery has restrained desktop parallax. Product scenes can be replayed. Switching chat/inbox or campaigns/calendar animates the new content. Brand swatches keep their existing colour transition and animate the portal content.

Reduced-motion preferences disable the timelines and show content immediately. Switching that preference while the page is open reverts motion. Without JavaScript or if the animation libraries fail to load, the static page remains readable. No animation is required to navigate or use the product previews.

Implementation references: [GSAP matchMedia](https://gsap.com/docs/v3/GSAP/gsap.matchMedia()/) for responsive setup and automatic reversion, [ScrollTrigger](https://gsap.com/docs/v3/Plugins/ScrollTrigger/) for viewport triggers and image-only parallax.
