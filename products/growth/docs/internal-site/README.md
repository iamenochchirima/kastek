# Kasitek Internal Docs Site

Standalone internal documentation site for private Kasitek documentation.

## Local commands

```bash
cd products/growth/docs/internal-site
nvm use
pnpm --ignore-workspace install --frozen-lockfile
pnpm --ignore-workspace dev
```

The site uses Node 22 from `.nvmrc` and its own lockfile.
Run `pnpm --ignore-workspace build` to check the site and its links.
Then open `http://localhost:3006`.

The current Agents architecture and implementation status are in
[`products/agents/docs`](../../../../products/agents/docs/README.md). Settled specifications and
implementation issues are in the KasiTek Linear team.
