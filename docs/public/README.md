# KasiTek Public Docs

Public documentation site for the KasiTek platform.

## Intended deployment

- root: `docs/public`
- domain: `docs.kasitek.co.za`
- hosting: Vercel

## Runtime expectation

Use Node `22`.

This scaffold is pinned with:

- `.nvmrc` = `22`
- `package.json` engines = `>=20 <24`

## Local commands

```bash
cd docs/public
pnpm install
pnpm dev
```

Production build:

```bash
cd docs/public
pnpm build
```

## Content model

The public docs are structured around:

- getting started
- workspace setup
- operations
- client portal
- service modules
- implementation reference

Internal-only docs live separately under `docs/internal`.
