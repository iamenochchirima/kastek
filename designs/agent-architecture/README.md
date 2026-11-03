# Agent architecture diagrams

Open `index.html` directly in a browser, or serve the design workspace and open `/agent-architecture/`. The generated HTML bundles React, React DOM, React Flow and styles locally. It works offline without a CDN or application backend.

D1–D8 retain stable review identifiers. D7 has separate Research, Content and Campaigns configurations. These are target architecture references, not claims that every capability is shipped.

## Editing the canvas

- Drag individual nodes. Connected arrows follow their handles.
- Drag the runtime group to move its internal components together. Components can also move independently.
- Pan by dragging the background; scroll or pinch to zoom. Fit and 100% provide fixed view controls.
- Drag a connection endpoint to reconnect it, or drag between node handles to add a connection.
- Layouts and viewport positions save automatically in browser storage, separately for each diagram and specialist. Notes keep their previous browser-storage key.
- Reset layout restores the current diagram's defaults. Undo restores the previous drag, connection edit or reset within the current view. Reloading clears Undo history, not the saved layout.
- Export layouts downloads JSON with saved diagrams and review notes. Local browser edits do not rewrite the source HTML. Export the file to share the changes for a source revision. Storage is separate for different origins, including localhost versus 127.0.0.1.

Colour key: purple = shared runtime; amber = agent-specific configuration; green = scoped context/memory; blue = adapters and integrations.

## Source and build

- `diagrams.js`: eight agent definitions.
- `app.jsx`: shared runtime nodes, exact component connections and editing behavior.
- `flow.css`: React Flow and node styling.
- `template.html`: document shell and shared page theme.
- `build.mjs`: bundles installed workspace dependencies into the offline HTML.

From the repository root with workspace dependencies installed:

```sh
node designs/agent-architecture/build.mjs
```

React Flow uses the version installed by Growth web. No new production dependency or product runtime behavior is introduced. This is a design artifact; API, schema, migrations, analytics, production rollout and operational logging changes are not applicable. To roll back the viewer, restore its previous source and HTML. Business permissions and agent implementations are unchanged.

Browser verification covered node drag, saved position after reload, reset/undo, and specialist selection. All eight definitions build through the same graph renderer.
