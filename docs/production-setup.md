# Production setup

Everything production needs that the repository cannot apply by itself.
`supabase/config.toml` configures the **local** stack only and is never pushed
to the hosted project (`supabase config push` is not used), so each hosted
setting below is applied by hand in the Supabase dashboard and checked again
after any change.

Keep this file current: a pull request that adds a production setting adds
it here.

## Vercel environment variables

Validated at startup by `lib/env/server-env.ts`; a missing or invalid value
stops the application rather than failing a request later.

| Variable                                     | Value                                                          |
| -------------------------------------------- | -------------------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`                        | The production origin, `https://…`                             |
| `SUPABASE_URL`                               | The hosted project's URL, `https://…`                          |
| `SUPABASE_ANON_KEY`                          | The project's anon key. Server-only here: never `NEXT_PUBLIC_` |
| `SUPABASE_SERVICE_ROLE_KEY`                  | The project's service-role key                                 |
| `RATE_LIMIT_HMAC_SECRET`                     | At least 32 random characters (`openssl rand -base64 48`)      |
| `TURNSTILE_SITE_KEY`                         | The production Turnstile widget's site key                     |
| `TURNSTILE_SECRET_KEY`                       | The production Turnstile widget's secret key                   |
| `CRON_SECRET`                                | At least 32 random characters                                  |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | From Stripe                                                    |
| `VERCEL`                                     | Set by Vercel itself. Production refuses to start without it   |

Cloudflare's published Turnstile test keys are refused in production.

## Cloudflare Turnstile

- One widget whose hostname list holds the production hostname only.
- Mode: Managed.
- The privacy policy names Cloudflare as a processor for this challenge
  (`README.md` §34).

## Supabase: Authentication

Mirror the local values in `supabase/config.toml`, with production URLs.

**URL configuration**

- Site URL: the production origin.
- Redirect URLs, both entries:
  - `https://<production origin>/auth/callback`
  - `https://<production origin>/auth/callback?sb_flow_id=*`

  Without the second, every sign-in link falls back to the site URL: each
  PKCE flow carries its id on the redirect (TASK-003d).

**Sessions** (paid plan)

- Time-box user sessions: `168h` (7 days).
- Inactivity timeout: `24h`.

Once TASK-003h lands, the application also enforces the 7-day limit itself,
making that one defence in depth; the 24-hour idle limit exists only here.
Until then, both exist only here.

**Tokens**

- JWT expiry: `3600` seconds.
- Refresh token rotation: on, reuse interval `10` seconds.

**Email**

- Custom SMTP: required. Supabase's built-in sender allows only a handful of
  emails an hour, too few for any real sign-in traffic.
- Minimum interval between emails to one address: `60` seconds. The
  application's per-address spacing (TASK-003c) is set to the same value, so
  the application never forwards a request GoTrue would refuse.
- Confirm email: off. Magic links confirm the address.
- Email OTP expiry: `3600` seconds.

**Rate limits** (per client IP; every request comes from the application's
servers, so each is shared by all visitors)

- Token refreshes: at least `150` per 5 minutes. Code exchanges and refreshes
  share this bucket; the application keeps its own ceilings (40 exchanges
  and, with TASK-003f, 100 refreshes per 5 minutes) under it. Raise both
  together if sign-in traffic grows.
- Sign-ins and sign-ups, token verifications: at least `150` per 5 minutes.

**CAPTCHA protection: off.** The application verifies Turnstile itself,
only past its thresholds (TASK-003c). Turning GoTrue's check on would demand
a token on every magic-link request.

**Providers**

- Email: on. Google: on, with the production OAuth client; its authorised
  redirect URI is the project's `…/auth/v1/callback`.

## Supabase: Database

- Apply every migration in `supabase/migrations/`, in order.
- `pg_cron` enabled (the rate-limit clean-up job is created by
  `20260918120000_rate_limits.sql`).
- Data API exposed schemas: `public` and `graphql_public` only. The
  `private` schema must never be exposed.

## GitHub

- Branch protection on `main`: the four CI checks (Typecheck, lint, test,
  build; Security test suite; Dependency audit; Real Supabase and browser
  suites) are required, for administrators too. Set 2026-09-19.
