# Designs

A browser-based workspace for design experiments across Labs, Agents, Growth and Agency. Each design is plain HTML, CSS and optional JavaScript.

From the workspace root, run:

```sh
python3 designs/serve.py
```

Open http://localhost:3010. Stop the server with Ctrl+C. Use `--port 3011` if the default port is occupied.

## Layout

- `index.html`: links to the available designs. Add a link here when creating a new design.
- `labs-landing/`: the saved Labs landing page from commit `fe8d24d`, restored as HTML, CSS and JavaScript.
- `_starter/`: copy this folder to start another design.
- `shared/`: optional shared styles and reusable assets.
- `assets/`: images, vectors and fonts used across designs.

Keep each design's HTML, CSS, JavaScript and specific assets together. Use relative paths so designs also work when served independently. Shared CSS contains only a reset and starter defaults; each design can choose its own fonts, colours and layout. No framework or build step is required.

To start another design:

```sh
cp -R designs/_starter designs/your-design-name
```

Change its title, then add a link in `designs/index.html`. Keep alternate directions in separate folders so we can compare them in the browser.

The earlier OpenPencil files remain in `../design/openpencil/` as reference. New design work belongs here.

## Agents presentation

The Labs landing Agents section cycles through Support, Business and Personal while visible. Each scene has its own photograph and operation. Support answers an order question and hands over to a teammate. Business creates a calendar event after approval. Personal builds a meeting brief inside a phone, scrolling the conversation as the brief arrives.

The examples remain on screen for 13, 14 and 15 seconds respectively, with a crossfade between them. Pause holds the current operation and sequence. A compact next-example control and replay remain available. Automatic changes stop while keyboard focus is inside a demo, while the section is out of view, or while the browser tab is hidden. Reduced motion and `?motion=off` show static examples with manual selection.

Scene assets and exact image-generation prompts are recorded in [the imagery notes](labs-landing/assets/agents/README.md).
