# TASK-003i — Keep sessions through auth-server hiccups outside the proxy

## Objective

Close review finding F2 for server actions and route handlers. The proxy
already keeps a session it could not verify (TASK-003d), but the session
client used by server actions and route handlers still applies every cookie
removal auth-js asks for. After any non-retryable refresh failure, including
a 429 caused by other people's traffic, auth-js deletes the session, so the
first dashboard mutation (TASK-007) would sign people out over an auth-server
hiccup.

Raised by the independent review of PRs #9–#11 (2026-09-19). No affected
caller exists yet, so this lands before TASK-007.

## Also: the proxy's background-refresh race (found 2026-09-19, TASK-003f)

Creating a session client subscribes to auth events
(`@supabase/ssr`'s `createServerClient` calls `onAuthStateChange`), which makes
auth-js load the session — and refresh it when the access token has expired —
in the background, without anyone calling it. On a refresh failure it removes
the session, and that removal is written straight into the request's cookies
by the cookie adapter.

So F2's guarantee in the proxy holds only because the proxy awaits its own
`getSession()` immediately after creating the client: with any awaited work in
between, the background refresh finishes first, the session is gone from the
request, and the proxy sees "no session" — signing the person out over a 429.
TASK-003f works around it by consulting the refresh limit before the client
exists.

Fix it here, so the guarantee no longer depends on ordering: hold removals
until the resolution has a verdict (as below), and make the proxy's cookie
adapter stop applying a removal to `request.cookies` before that verdict.
A regression test must add a delay between creating the client and resolving,
and still find the session intact after a 429.

## Owner agent

Backend

## Dependencies

TASK-003g.

## Allowed files

- lib/database/session-client.ts, lib/database/proxy-session-client.ts,
  lib/database/session-cookie-options.ts
- lib/auth/require-session.ts, lib/auth/resolve-session-user.ts,
  lib/auth/sign-in/sign-out.ts
- tests/unit/database/\*\*, tests/unit/auth/\*\*, tests/security/auth/\*\*,
  tests/supabase/auth/\*\*

## Forbidden files

- proxy.ts (its own handling is already guarded; only the client below changes)

## Invariants

- **A deletion waits for a verdict.** A batch of cookie writes that only
  removes the session (no new session cookie in it) is held until the session
  resolution finishes. It is applied when the auth server rejected the
  credential (400, 401 or 403) or when the person signs out, and dropped when
  the lookup failed for any other reason (429, 5xx, network).
- **Chunk clean-up is never held.** A batch that writes a new session and
  removes its stale chunks is applied at once; holding the removals would
  leave stale chunks that corrupt the next read.
- **Sign-out still signs out,** including when the auth server cannot be
  reached.

## Acceptance criteria

- In a route handler or server action, a refresh answered 429 leaves the
  session cookies in place; one answered `refresh_token_not_found` clears them.
- Sign-out clears the cookies whatever the auth server answers.

## Required tests

- security: 429, 408, 409 and 5xx refresh failures in a route handler delete
  no session cookie; a rejected credential does; sign-out does
- unit: a batch mixing a new session with chunk removals is applied at once
- supabase: a real refresh through a route handler keeps working, and chunk
  clean-up still happens
