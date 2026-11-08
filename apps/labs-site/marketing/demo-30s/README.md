# KasiTek Labs — 30 second demo

1920×1080, 30 fps, 30.0 s, H.264, no audio track, burned-in captions.

Output: `out/kasitek-labs-demo-16x9.mp4`

## Beats

| Time | Visual | Caption |
| --- | --- | --- |
| 0–3s | Three quick product cuts | Your customer work is scattered. |
| 3–9s | Agents workspace | Agents answer, qualify and hand off. |
| 9–15s | Growth inbox | Growth keeps the work in one place. |
| 15–21s | Agency client portal | Agency puts your name on it. |
| 21–27s | Three product cards | Built and run by KasiTek Labs. |
| 27–30s | End card | Book a 15-minute walkthrough. · kasitek.co.za |

## Regenerate

Requirements: Node 24, the Agents Playwright package, ffmpeg, and a running Labs site.

```sh
# 1. Start the Labs site (any port).
pnpm --filter labs dev

# 2. Capture the product windows at 2x.
LABS_URL=http://127.0.0.1:3007 node apps/labs-site/marketing/demo-30s/capture.mjs

# 3. Render frames and encode the MP4 (about four minutes).
node apps/labs-site/marketing/demo-30s/render.mjs
```

`render.mjs` writes 900 PNG frames to `.build/`, encodes them, and records duration and size in
`out/REPORT.txt`. Bump a caption by editing the `BEATS` table and the stage markup in
`render.mjs`; the timing table is the single source of the 30-second structure.

## What the visuals are

The product windows come from the Labs landing page's own Agents, Growth and Agency demo scenes —
the owner-approved illustrative product UI. They are not screenshots of live customer workspaces.
Replace `frames/*-window.png` with real captures to change that without touching the renderer.

The Geist webfont in this folder is the same licence-covered file the apps use.
