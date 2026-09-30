# Kasitek Labs website

Standalone Next.js site owned by the Kasitek Labs repository.

## Local development

Requirements: Node.js `>=22.12.0 <23` or `>=24.0.0`, and pnpm 10.30.1.

From this directory:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The development server listens on port `3007`. For checks, run:

```sh
pnpm lint
pnpm build
```

## Configuration

- `NEXT_PUBLIC_KASITEK_PUBLIC_API_URL` sets the public API origin used for the embedded chat
  widget. It defaults to `https://api.kasitek.co.za`.
- `NEXT_PUBLIC_KASITEK_CONTACT_EMAIL` sets the displayed contact address. It defaults to
  `hello@kasitek.co.za`.
- `RUST_API_BASE_URL`, `NEXT_PUBLIC_API_BASE_URL`, and `NEXT_PUBLIC_KASITEK_PUBLIC_API_URL` set
  the upstream API origin for the quote-request and waitlist routes, in that precedence order.
  In development they otherwise target `http://localhost:4000`; in production they default to
  `https://api.kasitek.co.za`.

Moving the source into this repository does not change the hosting project, domains, or deployed
environment. Those remain separate cutover work.
