# Admin

Central admin UI. It calls Growth Core for Growth operations and the Agency service over HTTP for tenant administration; it has no direct database dependency.

Copy `.env.example` to `.env.local`, then run:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

Set `OUTREACH_DRAFTS_DIR` only when draft files are stored outside the default
`local-work/outreach-emails/organized/categories` directory under the repository root.

To verify SMTP settings, set `SMTP_*` values in `.env.local` and run `pnpm test:smtp` from this
directory. Add `-- --to=address@example.com` to send a test message.

The conversations pages read from Core's `/api/admin/conversations` routes. The old `/api/conversations/messages` handler had no caller in this repository and wrote directly through Growth's Prisma package, so it was removed during the move.

Git deployments remain disabled in `vercel.json` until hosting cutover is handled separately.
