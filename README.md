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
