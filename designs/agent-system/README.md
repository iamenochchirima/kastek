# Shared agent system review board

This is an actual Excalidraw editor and a native editable drawing, rather than a fixed diagram viewer. The board is a target architecture proposal under review. It does not change the runtime or assert implementation approval.

Open `index.html` through the design server at `/agent-system/?v=3-context`. Revision 3 has five focus views: whole system, runtime components, nested delegation, failure contracts and context management. It opens the new context view. Excalidraw provides selection, moving, bound arrows, text editing, drawing, pan, zoom and Undo. Changes save in the current browser. Save .excalidraw exports the complete board when browser downloads are permitted; Export PNG exports the selected view. Preview export displays the PNG and editable drawing JSON. Browser edits do not automatically rewrite repository source.

- `kasitek-agent-system-v2.excalidraw`: revision 2 native Excalidraw board, including all four views.
- `whole-system-v2.png`, `runtime-v2.png`, `failure-contracts-v2.png`: revision 2 exports.
- `scene.js`: revision 3 components, ownership boundaries and connections, including the context protocol.
- `scene-v2.js`: preserved revision 2 source.
- `kasitek-agent-system.excalidraw`, `whole-system.png`, `scene-v1.js`: preserved revision 1 exports and source.
- `app.jsx`: embedded Excalidraw editor, local draft persistence and export controls.
- `build.mjs`: local bundle build; fonts are served from `assets/fonts/`.

The accompanying architecture definition is a working note in the verified Stash project Kasitek Agents: **Shared agent protocol and product integration — target architecture draft, 2 November**, item `472b889e-b14d-4008-9ba4-6dbf21a8c604`, item revision 4 (design revision 3). It contains the primary-source context research, revised protocol and proposed acceptance cases. It distinguishes confirmed user requirements from proposed contracts and unresolved decisions. It does not replace the maintained architecture reference or publish implementation tasks.

Revision links open `?draft=1` or `?draft=2`, using those drafts' original browser-storage keys. Revision 3 uses a separate key and leaves both earlier canvas drafts intact. The preserved native exports are fallbacks when their browser drafts are absent.

Confirmed direction includes one configurable runtime, product-owned authority, and delegation available to any configured agent in a tree. The board excludes the unconfirmed standalone internal assistant concept without removing existing code. The earlier eight-diagram viewer remains available as a separate draft; its root-only specialist depiction is superseded by this proposal.

Revision 2 distinguishes action authority, information-use/disclosure policy and effect records. It adds current authorization checks alongside immutable configuration, durable acceptance and fair scheduling, correction-safe continuity, memory acceptance ownership, conflicting-action preconditions, uncertain-effect reconciliation and authorized activity projection. Failure contracts describe proposed acceptance cases, not implementation test results. Memory acceptance classes, capacity defaults, retention/provider policies and measured quality thresholds remain open decisions.

Revision 3 adds the shared context protocol based on official OpenAI, Anthropic and LangChain documentation and inspected framework source. The view connects durable original records and artifacts, source-backed current state, authorized recovery, request planning/counting, prefix compaction, validated checkpoint adoption and optional provider-native state. Compaction changes the working projection; it must not discard the only recoverable source. Model-aware headroom, correction races, partial reads, archival failures, opaque-state invalidation and independent child context are explicit contracts. Retention and current access still govern recovery. Summaries are lossy, and semantic quality requires model-specific evaluation.

## Rebuild

The build uses Excalidraw 0.18.1 and React/React DOM 19.2.3. Install isolated design-build dependencies with the exact versions, then run from the root Node 24 workspace:

```sh
npm install --prefix /tmp/kasitek-excalidraw-build --no-audit --no-fund @excalidraw/excalidraw@0.18.1 react@19.2.3 react-dom@19.2.3
node designs/agent-system/build.mjs
```

`EXCALIDRAW_NODE_MODULES` can identify an alternative installed dependency directory. The bundle uses the workspace's esbuild. No production package manifest or lockfile changed. Native scene export remains separate from rebuilding the initial scene.

## Validation and release scope

Earlier browser verification opened revision 2's four views and the preserved revision 1 link, and exported its native drawing and PNGs through Excalidraw. Revision 2 contains 262 elements and 48 arrows. Revision 3 was rebuilt and inspected in the in-app browser, including the context view and preserved revision routes. Its new native/PNG file export was rejected by the browser download-permission check; no revision 3 downloaded export is claimed. The editable source and browser canvas remain available. Text uses the local font before measuring labels. The editor bundle build, source syntax and product import-boundary checks passed. These checks verify the design artifact, not the proposed runtime behavior.

Release decisions: low-risk local review artifact, owned by the current architecture review. Documentation: this README and the existing Stash draft updated; current product architecture and feature-map descriptions are unaffected. Platform release/version, API/schema/migration, analytics, runtime logs/metrics/alerts, production rollout/feature flags and post-release review are not applicable. Design revision 3 identifies the artifact. The preview remains local; restoring the preserved revision 2 source/native drawing rolls back this design. No production deployment or runtime change is included.
