# Kasitek Monorepo

## Overview
A Next.js pnpm monorepo migrated from Vercel to Replit. The main client app is a Next.js 16 application using React 19, Tailwind CSS v4, and Prisma with a PostgreSQL database.

## Solutions Pages Architecture
- `/solutions` — 4-card picker (SMBs, Agencies, Software Vendors, Franchises)
- `/solutions/[category]` — full detail page with 2-col hero + service showcase tabs
- `SolutionServicesShowcase` — interactive service selector with per-kind animated demos
- Each `SolutionDemoKind` maps to a self-looping animated component:
  `website-agent`, `whatsapp-agent`, `catalogue-agent`, `quote-automation`,
  `voice-agent`, `lead-nurturing`, `reviews`, `reporting`, `content-engine`,
  `aeo`, `platform-embed`, `usage-reporting`, `tenant-provisioning`
- Animations use a `useLoop(steps, stepMs, holdMs)` hook (setTimeout chain + auto-restart)

## Project Structure
```
client/                        # pnpm monorepo root
  apps/
    client/                    # Main Next.js app (port 5000)
    admin/                     # Admin Next.js app
    tenant-portal/             # Tenant portal app
  packages/
    database/                  # Shared Prisma database package (@kasitek/database)
    api-client-react/          # Shared API client
server/                        # Rust backend (Cargo workspace)
  crates/
    kasitek-core/
    kasitek-tenants/
```

## Running the App
- **Workflow**: "Start application" — runs `cd client && pnpm dev`
- **Port**: 5000 (bound to 0.0.0.0 for Replit compatibility)
- **Package Manager**: pnpm@10.30.1

## Required Environment Variables
- `DATABASE_URL` — PostgreSQL connection string (required for Prisma)
- `OPENROUTER_API_KEY` — OpenRouter API key for AI features
- `OPENROUTER_MODEL` — Optional, defaults to `openai/gpt-4.1-mini`
- `NEXT_PUBLIC_API_BASE_URL` — Base URL for the backend API
- `NEXT_PUBLIC_APP_URL` — Public app URL (defaults to `http://localhost:3000`)
- `NEXT_PUBLIC_META_APP_ID` — Meta app ID for WhatsApp embedded signup
- `NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID` — Meta embedded signup config ID

## Key Technologies
- Next.js 16.1.6 with Turbopack
- React 19
- Tailwind CSS v4
- Prisma v7 with PostgreSQL
- Auth.js v5 (session-based auth)
- pnpm workspaces

## Replit-Specific Changes
- Dev script updated to run on port 5000 with `-H 0.0.0.0` for proxy compatibility
- `esbuild` added to `pnpm.onlyBuiltDependencies` for correct installation
