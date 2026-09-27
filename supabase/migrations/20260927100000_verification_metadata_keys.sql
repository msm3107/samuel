-- The verification metadata key whitelist, and one added failure code
-- (TASK-023; PR #39 review, note 4). Additive: no column is added, dropped
-- or retyped, and `verification_checks` still holds no rows.
--
-- Why a whitelist, and why now. TASK-022 promised that `metadata` holds
-- facts about the check and never content from the customer's page
-- (README §34), and bounded it only in shape (`jsonb_typeof = 'object'`) and
-- size (2048 bytes). A page excerpt fits comfortably inside 2048 bytes, so
-- the promise rested on every future writer remembering it. It now rests on
-- the database. It lands here rather than in TASK-022 because this is the
-- task that produces the vocabulary: inventing the key names two tasks
-- before anything wrote them would have been a guess this migration widened
-- anyway. TASK-024 adds the inspection keys — which matcher failed, and what
-- it looked for — in its own migration, deliberately: widening a whitelist
-- by a named migration is an act somebody reviews, which is the opposite of
-- drift.
--
-- The honest limit, recorded where a future writer will meet it: a whitelist
-- bounds keys, not values. Nothing here stops a caller putting a page
-- excerpt in `content_type`. What it stops is a key nobody reviewed.
--
-- Why `metadata - array[...]`: a CHECK constraint may not contain a
-- subquery, so `jsonb_object_keys` is unavailable. Deleting every allowed
-- key and requiring an empty object left over says the same thing in one
-- expression, with no function to keep immutable and no list to read twice.
-- The `jsonb_typeof` guard comes first because `-` raises on a scalar rather
-- than returning false, and a non-object is already refused by TASK-022's
-- own constraint with the error code its tests pin.
--
-- Why `CONNECTION_FAILED`: §19's set had no code for a name that resolved
-- and a connection that was then refused, reset, unreachable or rejected at
-- TLS — a site that is simply down, which is the most common real failure
-- there is. It would otherwise land on `UNKNOWN_ERROR`, which tells a
-- customer nothing and is what §19 exists to prevent. Proposed by the
-- implementer; the list is replaced rather than extended in place because a
-- check constraint has no `add value`, which is why TASK-022 chose text with
-- a constraint over a Postgres enum.

alter table public.verification_checks
  add constraint verification_checks_metadata_keys_check check (
    jsonb_typeof(metadata) <> 'object'
    or metadata - array[
      -- Which scheme answered. Plain HTTP is weaker evidence, so it is
      -- recorded rather than assumed (owner, 2026-09-27).
      'scheme',
      -- Whether HTTPS was tried first and failed.
      'https_failed',
      -- How many hops were followed.
      'redirects',
      -- The hostname the body came from, which a chain may have changed.
      'final_host',
      -- Bytes of body read, after decompression.
      'response_bytes',
      -- How long the whole attempt took, any HTTPS attempt included.
      'duration_ms',
      -- The `Content-Type` header as given, so a PDF home page is
      -- explicable rather than mysteriously missing a widget.
      'content_type',
      -- Which redirect rule refused a hop. REDIRECT_BLOCKED is one code over
      -- six causes that need six different fixes, and this is the one failure
      -- class the customer must act on (PR #40 review, note 2). The value
      -- comes from a fixed list of seven strings with no customer data in it,
      -- so storing it is privacy-safe by construction; the row schema bounds
      -- the value, because a constraint on a value is what this migration
      -- deliberately declines to do.
      'redirect_reason'
    ] = '{}'::jsonb
  );

alter table public.verification_checks
  drop constraint verification_checks_failure_code_check;

alter table public.verification_checks
  add constraint verification_checks_failure_code_check check (
    failure_code in (
      'DNS_ERROR',
      'CONNECTION_FAILED',
      'CONNECTION_TIMEOUT',
      'TOTAL_TIMEOUT',
      'HTTP_ERROR',
      'REDIRECT_BLOCKED',
      'TOO_MANY_REDIRECTS',
      'PRIVATE_NETWORK_BLOCKED',
      'RESPONSE_TOO_LARGE',
      'WIDGET_NOT_FOUND',
      'DEPLOYMENT_ID_MISMATCH',
      'DISCLOSURE_VERSION_MISMATCH',
      'UNKNOWN_ERROR'
    )
  );

comment on column public.verification_checks.metadata is
  'Facts about the check, never content fetched from the customer page '
  '(README §34). Bounded three ways: an object, at most 2048 bytes '
  '(TASK-022), and only the keys named in '
  'verification_checks_metadata_keys_check (TASK-023). A whitelist bounds '
  'keys, not values: a new key needs a migration, and the reviewer of that '
  'migration is the last line against page content reaching this column.';
