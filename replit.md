# Kasitek Monorepo

## Overview
A Next.js pnpm monorepo migrated from Vercel to Replit. The main client app is a Next.js 16 application using React 19, Tailwind CSS v4, and Prisma with a Neon PostgreSQL database.

## Project Structure
```
client/                        # pnpm monorepo root
  apps/
    client/                    # Main Next.js app (port 5000)
    admin/                     # Admin Next.js app
    call-bridge/               # Call bridge app
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
- `DATABASE_URL` — Neon PostgreSQL connection string (required for Prisma)
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
- Prisma v7 with Neon serverless PostgreSQL adapter
- Auth.js v5 (session-based auth)
- pnpm workspaces

## Replit-Specific Changes
- Dev script updated to run on port 5000 with `-H 0.0.0.0` for proxy compatibility
- `esbuild` added to `pnpm.onlyBuiltDependencies` for correct installation
