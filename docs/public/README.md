# KasiTek Public Docs

Public documentation site for the KasiTek platform.

## Intended deployment

- root: `docs/public`
- domain: `docs.kasitek.co.za`
- hosting: Vercel

Internal technical documentation is a separate standalone site under `docs/internal-site`.

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

The public docs are structured around current supported behavior:

- getting started
- workspace setup
- operations
- client portal
- API and URL reference

Internal-only docs and temporary implementation plans live separately under `docs/internal` and
`docs/plans`.

Public documentation must be updated when a released feature changes user behavior, supported
configuration, or a public API. Future work, internal architecture, and temporary checklists do
not belong here.
