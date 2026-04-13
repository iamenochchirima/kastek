# Kasitek Monorepo

## Overview
A pnpm monorepo containing two Next.js applications and a shared Prisma database package.

## Structure
- `apps/client` — Main Next.js 16 client app (port 5000)
- `apps/admin` — Admin Next.js 16 app (port 3001)
- `packages/database` — Shared Prisma client with Neon PostgreSQL adapter
- `server/` — Rust server

## Package Manager
pnpm (v10.26.1 available in Replit environment)

## Running the App
The main workflow runs: `pnpm --filter client dev`
This starts the client app on port 5000 bound to 0.0.0.0 (Replit compatible).

## Required Environment Variables
Set these as secrets in the Replit environment:

### Database
- `DATABASE_URL` — Neon PostgreSQL connection string

### Client App
- `AUTH_SECRET` — NextAuth/Auth.js secret key
- `AUTH_URL` — Base URL for Auth.js (e.g. https://your-replit-url.replit.app)
- `OPENROUTER_API_KEY` — OpenRouter AI API key
- `OPENROUTER_MODEL` — OpenRouter model name (optional, has default)
- `NEXT_PUBLIC_API_BASE_URL` — Base URL for the backend API server
- `NEXT_PUBLIC_APP_URL` — Public URL of the client app
- `NEXT_PUBLIC_SERVER_URL` — Server URL (fallback for API base)
- `NEXT_PUBLIC_META_APP_ID` — Meta/Facebook App ID (WhatsApp integration)
- `NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID` — Meta embedded signup config

### Admin App
- `NEXTAUTH_SECRET` — NextAuth secret for admin app
- `CONVERSATIONS_API_KEY` — API key for conversations service
- `SMTP_FROM` — SMTP sender address
- `SMTP_PORT` — SMTP port
- `SMTP_SECURE` — Whether SMTP uses TLS
- `ADMIN_EMAIL` — Default admin email
- `ADMIN_PASSWORD` — Default admin password

## Key Notes
- The `packageManager` field in root package.json is set to pnpm@10.26.1 to match Replit's installed version
- Prisma client must be generated before building: `pnpm db:generate`
- Database uses Neon serverless PostgreSQL with WebSocket support
